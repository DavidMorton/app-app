#!/usr/bin/env python3
"""
MCP Approval Gate Server

Wraps Bash, Write, Edit, and MultiEdit with a frontend approval step.

Claude Code spawns this server when the approval-gate MCP config is active.

Environment variables (inherited via the Claude Code subprocess chain):
  APPROVAL_GATE_URL           Flask base URL  (default: http://127.0.0.1:5050)
  APPROVAL_GATE_CHAT_ID       Chat session ID to route approval requests to
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

FLASK_URL = os.environ.get("APPROVAL_GATE_URL", "http://127.0.0.1:5050")
CHAT_ID   = os.environ.get("APPROVAL_GATE_CHAT_ID", "")

# ── JSON-RPC helpers ──────────────────────────────────────────────────────────

def _read() -> dict | None:
    line = sys.stdin.readline()
    if not line:
        return None
    try:
        return json.loads(line.strip())
    except json.JSONDecodeError:
        return {}


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _ok(msg_id: Any, result: dict) -> None:
    _write({"jsonrpc": "2.0", "id": msg_id, "result": result})


def _err(msg_id: Any, code: int, message: str) -> None:
    _write({"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}})


def _log(msg: str) -> None:
    print(f"[approval-gate] {msg}", file=sys.stderr, flush=True)


# ── Tool schemas ──────────────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "AskUserQuestion",
        "description": (
            "Ask the user a question with optional choices. "
            "The question is shown in the frontend UI and the user can "
            "click an option or type a custom answer."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {"type": "string"},
                            "header":   {"type": "string"},
                            "options": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label":       {"type": "string"},
                                        "description": {"type": "string"},
                                    },
                                    "required": ["label", "description"],
                                },
                            },
                            "multiSelect": {"type": "boolean", "default": False},
                        },
                        "required": ["question", "header", "options", "multiSelect"],
                    },
                },
            },
            "required": ["questions"],
        },
    },
    {
        "name": "Write",
        "description": (
            "Write content to a file. Creates the file if it does not exist, "
            "or overwrites it. Requires frontend approval before executing."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Path to the file"},
                "content":   {"type": "string", "description": "Content to write"},
            },
            "required": ["file_path", "content"],
        },
    },
    {
        "name": "Edit",
        "description": (
            "Replace one exact string in a file with new text. "
            "Requires frontend approval before executing."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path":  {"type": "string"},
                "old_string": {"type": "string", "description": "Exact text to find"},
                "new_string": {"type": "string", "description": "Replacement text"},
            },
            "required": ["file_path", "old_string", "new_string"],
        },
    },
    {
        "name": "MultiEdit",
        "description": (
            "Apply multiple find-and-replace edits to a file atomically. "
            "Requires frontend approval before executing."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "edits": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_string": {"type": "string"},
                            "new_string": {"type": "string"},
                        },
                        "required": ["old_string", "new_string"],
                    },
                },
            },
            "required": ["file_path", "edits"],
        },
    },
    {
        "name": "Bash",
        "description": (
            "Execute a shell command in the workspace. "
            "Requires frontend approval before executing."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command":     {"type": "string", "description": "Shell command to run"},
                "description": {"type": "string", "description": "Human-readable description"},
                "timeout":     {"type": "number",  "description": "Timeout in milliseconds"},
            },
            "required": ["command"],
        },
    },
]

# ── Approval flow ─────────────────────────────────────────────────────────────

def _request_approval(tool_name: str, tool_input: dict) -> str:
    """
    POST the pending approval to Flask, then long-poll for the decision.
    Returns 'allow' or 'deny'.
    """
    request_id = str(uuid.uuid4())

    payload = json.dumps({
        "chat_id":    CHAT_ID,
        "request_id": request_id,
        "tool":       tool_name,
        "input":      tool_input,
    }).encode()

    # Register the pending request with Flask
    try:
        req = urllib.request.Request(
            f"{FLASK_URL}/api/approval/request",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        _log(f"Could not reach Flask for approval: {exc} — denying")
        return "deny"

    # Block (long-poll) until the user decides (Flask holds the connection)
    try:
        resp = urllib.request.urlopen(
            f"{FLASK_URL}/api/approval/wait/{request_id}",
            timeout=310,   # 5-min user window + buffer
        )
        data = json.loads(resp.read())
        return data.get("decision", "deny")
    except Exception as exc:
        _log(f"Approval wait failed: {exc} — denying")
        return "deny"


# ── User question flow ────────────────────────────────────────────────────────

def _request_user_answer(tool_input: dict) -> str:
    """
    POST a question to Flask, then long-poll for the user's answer.
    Returns a JSON string with the user's answers.
    """
    request_id = str(uuid.uuid4())

    payload = json.dumps({
        "chat_id":    CHAT_ID,
        "request_id": request_id,
        "questions":  tool_input.get("questions", []),
    }).encode()

    try:
        req = urllib.request.Request(
            f"{FLASK_URL}/api/approval/question",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as exc:
        _log(f"Could not reach Flask for question: {exc}")
        return json.dumps({"error": str(exc)})

    # Block until the user answers (Flask holds the connection)
    try:
        resp = urllib.request.urlopen(
            f"{FLASK_URL}/api/approval/wait/{request_id}",
            timeout=310,
        )
        data = json.loads(resp.read())
        return data.get("decision", "{}")
    except Exception as exc:
        _log(f"Question wait failed: {exc}")
        return json.dumps({"error": str(exc)})


# ── Tool executors ────────────────────────────────────────────────────────────

def _exec_write(inp: dict) -> str:
    file_path = inp["file_path"]
    content   = inp["content"]
    parent = os.path.dirname(os.path.abspath(file_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return f"Wrote {len(content)} bytes to {file_path}"


def _exec_edit(inp: dict) -> str:
    file_path  = inp["file_path"]
    old_string = inp["old_string"]
    new_string = inp["new_string"]
    with open(file_path, "r", encoding="utf-8") as fh:
        original = fh.read()
    if old_string not in original:
        raise ValueError(f"old_string not found in {file_path}")
    updated = original.replace(old_string, new_string, 1)
    with open(file_path, "w", encoding="utf-8") as fh:
        fh.write(updated)
    return f"Edited {file_path}"


def _exec_multiedit(inp: dict) -> str:
    file_path = inp["file_path"]
    edits     = inp["edits"]
    with open(file_path, "r", encoding="utf-8") as fh:
        content = fh.read()
    for i, edit in enumerate(edits):
        old, new = edit["old_string"], edit["new_string"]
        if old not in content:
            raise ValueError(f"Edit {i}: old_string not found in {file_path}: {old[:40]!r}")
        content = content.replace(old, new, 1)
    with open(file_path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return f"Applied {len(edits)} edit(s) to {file_path}"


def _exec_bash(inp: dict) -> str:
    command    = inp["command"]
    timeout_ms = inp.get("timeout", 120_000)
    timeout_s  = min(float(timeout_ms) / 1000.0, 300.0)
    result = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        timeout=timeout_s,
    )
    out = result.stdout
    if result.returncode != 0:
        out += f"\n[exit {result.returncode}]\n{result.stderr}"
    elif result.stderr:
        out += f"\n{result.stderr}"
    return out or "(no output)"


_EXECUTORS = {
    "Write":     _exec_write,
    "Edit":      _exec_edit,
    "MultiEdit": _exec_multiedit,
    "Bash":      _exec_bash,
}

# ── Main JSON-RPC loop ────────────────────────────────────────────────────────

def main() -> None:
    _log(f"started  chat_id={CHAT_ID!r}  flask={FLASK_URL}")

    while True:
        msg = _read()
        if msg is None:
            break                   # stdin closed → exit

        method = msg.get("method", "")
        msg_id = msg.get("id")

        # ── lifecycle ─────────────────────────────────────────────────────────
        if method == "initialize":
            _ok(msg_id, {
                "protocolVersion": "2024-11-05",
                "capabilities":    {"tools": {}},
                "serverInfo":      {"name": "approval-gate", "version": "1.0.0"},
            })

        elif method == "notifications/initialized":
            pass   # no response for notifications

        # ── tool discovery ────────────────────────────────────────────────────
        elif method == "tools/list":
            _ok(msg_id, {"tools": TOOLS})

        # ── tool execution (with approval) ────────────────────────────────────
        elif method == "tools/call":
            params     = msg.get("params", {})
            tool_name  = params.get("name", "")
            tool_input = params.get("arguments", {})

            # AskUserQuestion: no approval step — forward to frontend directly
            if tool_name == "AskUserQuestion":
                _log(f"tool_call tool={tool_name!r} chat_id={CHAT_ID!r}")
                answer = _request_user_answer(tool_input)
                _log(f"user_answer received for tool={tool_name!r}")
                _ok(msg_id, {
                    "content": [{"type": "text", "text": answer}],
                    "isError": False,
                })
                continue

            if tool_name not in _EXECUTORS:
                _err(msg_id, -32601, f"Unknown tool: {tool_name!r}")
                continue

            _log(f"tool_call tool={tool_name!r} chat_id={CHAT_ID!r}")
            decision = _request_approval(tool_name, tool_input)
            _log(f"decision={decision!r} for tool={tool_name!r}")

            if decision != "allow":
                _ok(msg_id, {
                    "content": [{"type": "text", "text": "[Tool use denied by user]"}],
                    "isError": True,
                })
                continue

            try:
                result_text = _EXECUTORS[tool_name](tool_input)
                _ok(msg_id, {
                    "content": [{"type": "text", "text": result_text}],
                    "isError": False,
                })
            except Exception as exc:
                _log(f"Execution error: {exc}")
                _ok(msg_id, {
                    "content": [{"type": "text", "text": f"Error: {exc}"}],
                    "isError": True,
                })

        # ── unknown request ───────────────────────────────────────────────────
        elif msg_id is not None:
            _err(msg_id, -32601, f"Unknown method: {method!r}")


if __name__ == "__main__":
    main()
