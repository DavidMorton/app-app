#!/usr/bin/env python3
"""Claude Code CLI-backed implementation of AgentProvider."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from queue import Empty, Queue
from threading import Thread
from typing import Iterator

from .base import AgentProvider

logger = logging.getLogger(__name__)

_CLAUDE_MODELS = [
    {"id": "claude-opus-4-6",           "name": "Claude Opus 4.6",  "is_default": False, "is_current": False},
    {"id": "claude-sonnet-4-6",         "name": "Claude Sonnet 4.6","is_default": True,  "is_current": True},
    {"id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "is_default": False, "is_current": False},
]
_DEFAULT_MODEL = "claude-sonnet-4-6"

# Absolute path to the approval-gate MCP server (lives next to this file)
_MCP_SERVER = str(Path(__file__).resolve().parent.parent / "mcp" / "approval_gate.py")

# Flask base URL for the approval callbacks (matches app.run port 5050)
_FLASK_URL = os.environ.get("APPROVAL_GATE_URL", "http://127.0.0.1:5050")


# Env vars that must not leak into agent subprocesses:
# - CLAUDECODE / CLAUDE_CODE_ENTRYPOINT: prevents recursive Claude Code invocation
_STRIP_ENV_VARS = {
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
}


class ClaudeCodeProvider(AgentProvider):
    """Agent provider backed by the Claude Code CLI (`claude`).

    Uses ``--input-format stream-json`` so the prompt is written to stdin as a
    JSON user message.  This keeps stdin alive as a real pipe (solving the
    historic hang), lets Claude proceed normally, and still allows the MCP
    approval-gate server to block on tool calls waiting for frontend decisions.

    Approval flow:
    1. Claude calls ``mcp__approval-gate__Bash`` (or Write/Edit/MultiEdit).
    2. The MCP server POSTs to Flask ``/api/approval/request``.
    3. Flask calls ``inject_event()`` which drops a ``permission_request`` event
       into the live SSE merged queue for the relevant chat.
    4. The frontend shows an Allow / Deny card.
    5. The user clicks → frontend POSTs to ``/api/approval/decide``.
    6. Flask unblocks the MCP server's long-poll.
    7. MCP server executes (or declines) the tool and returns to Claude.
    """

    # Common install locations for the Claude Code CLI binary
    _CLAUDE_SEARCH_PATHS = [
        Path.home() / ".local" / "bin" / "claude",
        Path("/usr/local/bin/claude"),
        Path.home() / ".npm-global" / "bin" / "claude",
    ]

    @staticmethod
    def _resolve_claude_cli(cli: str) -> str:
        """Resolve the claude CLI to an absolute path.

        When the server is started from a GUI or auto-restart context,
        ~/.local/bin may not be on PATH. This checks shutil.which first,
        then falls back to well-known install locations.
        """
        # Already an absolute path
        if os.path.isabs(cli) and os.path.isfile(cli):
            return cli
        # Try PATH lookup
        found = shutil.which(cli)
        if found:
            return found
        # Probe well-known locations
        for candidate in ClaudeCodeProvider._CLAUDE_SEARCH_PATHS:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                logger.info("Resolved claude CLI at %s (not on PATH)", candidate)
                return str(candidate)
        # Give up — return as-is and let Popen raise FileNotFoundError later
        logger.warning("Could not resolve claude CLI '%s' to an absolute path", cli)
        return cli

    def __init__(self, claude_cli: str = "claude", sessions_file: Path | None = None):
        self.claude_cli = self._resolve_claude_cli(claude_cli)
        self._sessions_file = sessions_file
        # Maps chat_id → Claude Code session_id  (for --resume); persisted to disk
        self._session_map: dict[str, str] = {}
        # Maps chat_id → code folder path; persisted alongside session_map
        self._code_folders: dict[str, str] = {}
        self._load_sessions()
        # Maps chat_id → the live merged_q so inject_event() can drop events in
        self._inject_queues: dict[str, Queue] = {}
        # Maps chat_id → open stdin pipe for mid-stream tool_result responses
        self._stdin_map: dict[str, object] = {}
        # Maps chat_id → running subprocess.Popen so we can cancel
        self._process_map: dict[str, subprocess.Popen] = {}
        # Maps chat_id → prompt text from the last cancelled run (so next run
        # can re-provide context that Claude may have lost)
        self._cancelled_prompts: dict[str, str] = {}

    def set_code_folder(self, chat_id: str, path: str) -> None:
        """Register the code folder for a chat so approval can auto-allow file ops there.

        Persisted to sessions.json so the correct cwd survives backend restarts.
        """
        if path:
            self._code_folders[chat_id] = path
        else:
            self._code_folders.pop(chat_id, None)
        self._save_sessions()

    def get_code_folder(self, chat_id: str) -> str:
        """Return the code folder for a chat, or empty string if none."""
        return self._code_folders.get(chat_id, "")

    def _load_sessions(self) -> None:
        """Load session map from disk.

        Handles two formats:
          - Legacy: {chat_id: session_id_str}
          - Current: {chat_id: {session_id, code_folder?}}
        """
        if not (self._sessions_file and self._sessions_file.exists()):
            return
        try:
            raw = json.loads(self._sessions_file.read_text())
        except Exception:
            return
        for chat_id, val in raw.items():
            if isinstance(val, str):
                # Legacy format — just a session_id string
                self._session_map[chat_id] = val
            elif isinstance(val, dict):
                self._session_map[chat_id] = val.get("session_id", "")
                cf = val.get("code_folder", "")
                if cf:
                    self._code_folders[chat_id] = cf

    def _save_sessions(self) -> None:
        if not self._sessions_file:
            return
        try:
            data = {}
            for chat_id, session_id in self._session_map.items():
                cf = self._code_folders.get(chat_id, "")
                if cf:
                    data[chat_id] = {"session_id": session_id, "code_folder": cf}
                else:
                    data[chat_id] = session_id  # keep legacy format for non-code-folder chats
            tmp = self._sessions_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(data))
            tmp.replace(self._sessions_file)
        except Exception as exc:
            logger.warning("Failed to persist session map: %s", exc)

    @property
    def status_message(self) -> str:
        return "Starting Claude Code agent..."

    # ------------------------------------------------------------------
    # inject_event – called by the approval controller (Flask thread)
    # ------------------------------------------------------------------

    def send_tool_result(self, chat_id: str, tool_use_id: str, content: str) -> bool:
        """Write a tool_result back to Claude via stdin.

        Called from the agent controller when the user answers an
        AskFollowupQuestion card.  Thread-safe: writes to the pipe that
        the run_stream subprocess is reading from.
        """
        stdin = self._stdin_map.get(chat_id)
        if stdin is None:
            logger.warning("send_tool_result: no open stdin for chat_id %s", chat_id)
            return False
        tool_result_msg = json.dumps({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": tool_use_id, "content": content}],
            },
        })
        try:
            stdin.write(tool_result_msg + "\n")
            stdin.flush()
            logger.debug("send_tool_result: %s → chat_id %s", tool_use_id, chat_id)
            return True
        except OSError as exc:
            logger.warning("send_tool_result OSError: %s", exc)
            return False

    def inject_event(self, chat_id: str, event: dict) -> bool:
        """Inject a synthetic event into the running SSE stream for *chat_id*.

        Thread-safe: the approval controller calls this from a Flask request
        thread while the SSE generator is blocked on ``merged_q.get()``.
        """
        q = self._inject_queues.get(chat_id)
        if q is None:
            logger.warning("inject_event: no active stream for chat_id %s", chat_id)
            return False
        q.put(("inject", json.dumps(event)))
        logger.debug("inject_event: %s → %s", event.get("type"), chat_id)
        return True

    # ------------------------------------------------------------------
    # cancel – kill a running agent process
    # ------------------------------------------------------------------

    def cancel(self, chat_id: str) -> bool:
        """Terminate the running CLI process for *chat_id*.

        Sends SIGTERM, then injects a ``cancelled`` sentinel into the merged
        queue so the stream loop exits cleanly and yields a cancelled event.
        """
        proc = self._process_map.get(chat_id)
        if proc is None or proc.poll() is not None:
            logger.warning("cancel: no running process for chat_id %s", chat_id)
            return False

        logger.info("cancel: terminating process %d for chat_id %s", proc.pid, chat_id)
        proc.terminate()

        # Inject a sentinel so the stream loop yields a cancelled event
        q = self._inject_queues.get(chat_id)
        if q is not None:
            q.put(("cancel", None))

        return True

    @property
    def active_run_count(self) -> int:
        """Number of currently running agent processes."""
        return len(self._process_map)

    # ------------------------------------------------------------------
    # Misc provider methods
    # ------------------------------------------------------------------

    def open_target(self, target: str) -> None:
        subprocess.Popen(["open", target])

    def create_chat(self) -> str:
        return str(uuid.uuid4())

    def list_models(self) -> tuple[list[dict], str | None]:
        return _CLAUDE_MODELS, _DEFAULT_MODEL

    # ------------------------------------------------------------------
    # run_stream
    # ------------------------------------------------------------------

    # Pattern that indicates the conversation history is too large to resume
    _PROMPT_TOO_LONG_PATTERNS = [
        "prompt is too long",
        "prompt_too_long",
        "context window",
        "maximum context length",
    ]

    def _try_compact_session(
        self, session_id: str, workspace: str, model: str = "",
    ) -> bool:
        """Run ``claude -p --resume <id> "/compact"`` to shrink a session.

        Returns True if the compact command exited successfully.
        """
        cmd = [self.claude_cli, "-p", "--resume", session_id]
        if model:
            cmd.extend(["--model", model])
        cmd.append("/compact")

        env = {k: v for k, v in os.environ.items() if k not in _STRIP_ENV_VARS}

        logger.info("Attempting to compact session %s", session_id)
        logger.info("  compact cmd: %s", " ".join(cmd))
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=workspace or None,
                env=env,
            )
            logger.info(
                "Compact finished: rc=%s  stdout=%d chars  stderr=%d chars",
                result.returncode, len(result.stdout), len(result.stderr),
            )
            if result.stderr:
                logger.info("Compact stderr: %s", result.stderr[:500])
            if result.stdout:
                logger.info("Compact stdout (first 300): %s", result.stdout[:300])
            return result.returncode == 0
        except subprocess.TimeoutExpired:
            logger.warning("Compact timed out after 120 s")
            return False
        except Exception as exc:
            logger.warning("Compact failed: %s", exc)
            return False

    def run_stream(
        self,
        prompt: str,
        workspace: str,
        model: str = "",
        chat_id: str = "",
        images: list[dict] | None = None,
    ) -> Iterator[str]:
        # If the previous run for this chat was cancelled, Claude's session may
        # have lost the user's original request.  Prepend it as context so the
        # follow-up message makes sense.
        original_prompt = prompt
        prev_prompt = self._cancelled_prompts.pop(chat_id, "") if chat_id else ""
        if prev_prompt:
            prompt = (
                f"[Context: the user's previous request was cancelled before you could finish. "
                f"Their original message was:\n\n{prev_prompt}\n\n"
                f"---\nTheir new message is:]\n\n{prompt}"
            )
        yield from self._run_stream_impl(prompt, workspace, model, chat_id, images,
                                         _original_prompt=original_prompt)

    def _run_stream_impl(
        self,
        prompt: str,
        workspace: str,
        model: str = "",
        chat_id: str = "",
        images: list[dict] | None = None,
        _is_retry: bool = False,
        _original_prompt: str = "",
    ) -> Iterator[str]:
        # ── build command ─────────────────────────────────────────────
        cmd = [
            self.claude_cli,
            "-p",
            "--verbose",
            "--include-partial-messages",       # stream content_block_delta events
            "--output-format", "stream-json",
            "--input-format",  "stream-json",   # prompt via stdin JSON
            "--dangerously-skip-permissions",   # MCP server is our approval gate
            "--allowedTools",
            "mcp__approval-gate__Write,mcp__approval-gate__Edit,"
            "mcp__approval-gate__MultiEdit,mcp__approval-gate__Bash,"
            "mcp__approval-gate__AskUserQuestion,"
            "WebFetch,WebSearch",
            "--disallowedTools", "Bash,Write,Edit,MultiEdit,Task,TaskOutput,EnterPlanMode,ExitPlanMode,AskUserQuestion",
        ]
        if model:
            cmd.extend(["--model", model])

        # Always look up session from the map.  The compact-then-retry
        # path keeps the (now smaller) session in the map; the fresh-start
        # fallback pops it before retrying.
        claude_session = self._session_map.get(chat_id, "")
        if claude_session:
            cmd.extend(["--resume", claude_session])

        # ── MCP approval-gate config ──────────────────────────────────
        mcp_cfg = json.dumps({
            "mcpServers": {
                "approval-gate": {
                    "command": sys.executable,
                    "args":    [_MCP_SERVER],
                }
            }
        })
        cmd.extend(["--mcp-config", mcp_cfg])

        # ── env: strip CLAUDECODE; pass approval-gate routing vars ────
        claudecode_present = "CLAUDECODE" in os.environ
        env = {k: v for k, v in os.environ.items() if k not in _STRIP_ENV_VARS}
        env["APPROVAL_GATE_URL"]     = _FLASK_URL
        env["APPROVAL_GATE_CHAT_ID"] = chat_id
        logger.info("ClaudeCodeProvider.run_stream")
        logger.info("  cmd        : %s", " ".join(cmd))
        logger.info("  cwd        : %s", workspace or "(inherited)")
        logger.info("  chat_id    : %s", chat_id or "(none)")
        logger.info("  session    : %s", claude_session or "(new)")
        logger.info("  CLAUDECODE stripped: %s", claudecode_present)

        yield json.dumps({"type": "debug", "message": f"cmd: {' '.join(cmd)}"})

        # ── spawn process ─────────────────────────────────────────────
        try:
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE,     # kept open; we write the prompt then close
                text=True,
                bufsize=1,
                cwd=workspace or None,
                env=env,
            )
        except FileNotFoundError as exc:
            if workspace and not Path(workspace).is_dir():
                msg = f"Working directory does not exist: {workspace}"
            else:
                msg = f"claude CLI not found at '{self.claude_cli}'. Is Claude Code installed and on PATH?"
            logger.error("%s (original: %s)", msg, exc)
            yield json.dumps({"type": "error", "message": msg})
            return

        # ── write the prompt to stdin as a JSON user message ──────────
        content_blocks: list[dict] = []

        # Inline images (base64) if any
        for img in (images or []):
            raw = img.get("data", "")
            # Strip data-URL prefix if present ("data:image/png;base64,…")
            if "," in raw:
                raw = raw.split(",", 1)[1]
            content_blocks.append({
                "type":   "image",
                "source": {
                    "type":       "base64",
                    "media_type": img.get("type", "image/png"),
                    "data":       raw,
                },
            })

        if prompt:
            content_blocks.append({"type": "text", "text": prompt})

        user_msg = json.dumps({
            "type":    "user",
            "message": {
                "role":    "user",
                "content": content_blocks,
            },
        })

        # ── Instrumentation: log exactly what we're sending to the CLI ──
        logger.info("── stdin payload ──────────────────────────────────")
        logger.info("  total JSON length : %d chars (%d bytes)",
                     len(user_msg), len(user_msg.encode("utf-8")))
        for i, block in enumerate(content_blocks):
            btype = block.get("type", "?")
            if btype == "text":
                logger.info("  block[%d] text     : %d chars", i, len(block.get("text", "")))
            elif btype == "image":
                b64 = block.get("source", {}).get("data", "")
                logger.info("  block[%d] image    : %d base64 chars (~%d KB)",
                             i, len(b64), len(b64) * 3 // 4 // 1024)
            else:
                logger.info("  block[%d] %s", i, btype)
        logger.info("──────────────────────────────────────────────────")

        try:
            process.stdin.write(user_msg + "\n")
            process.stdin.flush()
            # Do NOT close stdin here — keep the pipe open so we can write
            # tool_result messages back if Claude uses AskFollowupQuestion.
            # Claude Code in --input-format stream-json mode starts processing
            # immediately after reading the first JSON line; it only reads more
            # stdin if it needs to return a tool result.
        except OSError as exc:
            logger.error("Failed to write prompt to stdin: %s", exc)
            yield json.dumps({"type": "error", "message": f"stdin write error: {exc}"})
            process.kill()
            return

        # ── register inject queue + process so approval/cancel can reach us
        merged_q: Queue = Queue()
        if chat_id:
            self._inject_queues[chat_id] = merged_q
            self._stdin_map[chat_id] = process.stdin
            self._process_map[chat_id] = process

        # ── background readers: stdout + stderr → merged_q ───────────
        def _read_stdout() -> None:
            try:
                assert process.stdout
                for line in process.stdout:
                    merged_q.put(("out", line.rstrip("\n")))
            finally:
                merged_q.put(("out_eof", None))

        def _read_stderr() -> None:
            try:
                assert process.stderr
                for line in process.stderr:
                    merged_q.put(("err", line.rstrip("\n")))
            finally:
                merged_q.put(("err_eof", None))

        Thread(target=_read_stdout, daemon=True).start()
        Thread(target=_read_stderr, daemon=True).start()

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        out_done = err_done = False
        got_result = False          # True once we see a successful "result" event
        was_cancelled = False

        try:
            while not (out_done and err_done):
                try:
                    kind, line = merged_q.get(timeout=None)
                except Empty:
                    continue

                if kind == "out_eof":
                    out_done = True
                    continue
                if kind == "err_eof":
                    err_done = True
                    continue

                # ── cancel sentinel (from cancel()) ────────────────────────
                if kind == "cancel":
                    was_cancelled = True
                    logger.info("Stream cancelled for chat_id %s", chat_id)
                    yield json.dumps({"type": "cancelled", "message": "Request cancelled."})
                    break

                if not line:
                    continue

                # ── injected synthetic event (from approval controller) ─────
                if kind == "inject":
                    yield line   # already JSON-encoded
                    continue

                # ── real stdout line ────────────────────────────────────────
                if kind == "out":
                    stdout_lines.append(line)
                    logger.debug("stdout: %s", line)

                    try:
                        event = json.loads(line)
                        if event.get("type") == "result":
                            got_result = True
                            sid = event.get("session_id", "")
                            if sid and chat_id:
                                self._session_map[chat_id] = sid
                                logger.info("Captured session_id %s", sid)
                                self._save_sessions()
                            # Close stdin so Claude exits cleanly; stdout will
                            # then close, out_eof arrives, and the loop ends.
                            try:
                                if process.stdin and not process.stdin.closed:
                                    process.stdin.close()
                            except OSError:
                                pass
                    except json.JSONDecodeError:
                        pass

                    yield line

                # ── stderr line ─────────────────────────────────────────────
                elif kind == "err":
                    stderr_lines.append(line)
                    logger.warning("stderr: %s", line)
                    yield json.dumps({"type": "error", "message": f"claude: {line}"})

        finally:
            if was_cancelled:
                # Give the process a moment to exit after SIGTERM, then force-kill
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            else:
                process.wait()
            if chat_id:
                self._inject_queues.pop(chat_id, None)
                self._process_map.pop(chat_id, None)
                stdin = self._stdin_map.pop(chat_id, None)
                if stdin and not stdin.closed:
                    try:
                        stdin.close()
                    except OSError:
                        pass

        # ── Skip post-processing if the request was cancelled ─────────
        if was_cancelled:
            if chat_id:
                self._cancelled_prompts[chat_id] = _original_prompt or prompt
            return

        # ── Post-process: log summary and detect prompt-too-long ─────
        all_output = "\n".join(stdout_lines + stderr_lines)
        logger.info("── stream finished ────────────────────────────────")
        logger.info("  rc           : %s", process.returncode)
        logger.info("  stdout lines : %d", len(stdout_lines))
        logger.info("  stderr lines : %d", len(stderr_lines))
        logger.info("  got_result   : %s", got_result)
        logger.info("  is_retry     : %s", _is_retry)
        logger.info("  session      : %s", claude_session or "(none)")
        if stderr_lines:
            logger.info("  stderr dump  :")
            for sl in stderr_lines:
                logger.info("    | %s", sl)
        if not got_result and stdout_lines:
            logger.info("  stdout dump (no result):")
            for sl in stdout_lines:
                logger.info("    | %s", sl)
        logger.info("───────────────────────────────────────────────────")

        # ── Auto-recover if the session context was too large ─────────
        all_lower = all_output.lower()
        prompt_too_long = (
            not got_result
            and not _is_retry
            and chat_id
            and claude_session
            and any(p in all_lower for p in self._PROMPT_TOO_LONG_PATTERNS)
        )

        if prompt_too_long:
            # Step 1 — try to compact the session in-place
            yield json.dumps({
                "type": "session_compacting",
                "message": "Conversation too large — compacting session…",
            })

            if self._try_compact_session(claude_session, workspace, model):
                # Session is now smaller; retry with --resume (session
                # is still in the map so it will be picked up).
                logger.info("Session %s compacted — retrying with --resume", claude_session)
                yield json.dumps({
                    "type": "session_compacted",
                    "message": "Session compacted successfully. Retrying…",
                })
                yield from self._run_stream_impl(
                    prompt, workspace, model, chat_id, images, _is_retry=True,
                )
                return

            # Step 2 — compact failed; drop the session and start fresh
            logger.warning(
                "Compact failed for session %s — dropping session and starting fresh",
                claude_session,
            )
            self._session_map.pop(chat_id, None)
            self._save_sessions()
            yield json.dumps({
                "type": "session_reset",
                "message": "Could not compact session. Starting a fresh conversation…",
            })
            yield from self._run_stream_impl(
                prompt, workspace, model, chat_id, images, _is_retry=True,
            )
            return

        if not got_result and not stdout_lines:
            stderr_text = "\n".join(stderr_lines)
            msg = (
                f"claude exited (code {process.returncode}) with no stdout. "
                f"stderr: {stderr_text or '(empty)'}"
            )
            logger.error(msg)
            yield json.dumps({"type": "error", "message": msg})
