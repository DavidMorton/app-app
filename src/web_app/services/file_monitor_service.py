#!/usr/bin/env python3
"""File monitoring service for detecting code changes and triggering server restarts."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

MONITORED_EXTENSIONS = {".py", ".js", ".html", ".css"}
EXCLUDE_DIRS = {"__pycache__", ".git", ".venv", "venv", "node_modules"}


class FileMonitorService:
    def __init__(self, watch_dir: Path, exclude_dirs: set[str] | None = None,
                 active_agent_count_fn=None):
        self.watch_dir = watch_dir
        self.exclude_dirs = exclude_dirs or EXCLUDE_DIRS
        self._restart_scheduled = False
        self._restart_pending = False
        self._active_agent_count_fn = active_agent_count_fn or (lambda: 0)

    def snapshot(self) -> dict[str, float]:
        """Return {absolute_path: mtime} for all monitored code files."""
        result: dict[str, float] = {}
        for path in self.watch_dir.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix not in MONITORED_EXTENSIONS:
                continue
            if any(part in self.exclude_dirs for part in path.parts):
                continue
            try:
                result[str(path)] = path.stat().st_mtime
            except OSError:
                pass
        return result

    def has_changed(self, before: dict[str, float]) -> bool:
        """Return True if any monitored file was added, removed, or modified."""
        return bool(self.changed_files(before))

    def changed_files(self, before: dict[str, float]) -> set[str]:
        """Return the set of files that were added, removed, or modified."""
        after = self.snapshot()
        if after == before:
            return set()
        added = set(after) - set(before)
        removed = set(before) - set(after)
        modified = {p for p in after if p in before and after[p] != before[p]}
        changed = added | removed | modified
        for p in changed:
            logger.info("File changed: %s", p)
        return changed

    @staticmethod
    def only_static_changes(changed: set[str]) -> bool:
        """Return True if all changed files are static (non-Python) assets."""
        if not changed:
            return False
        static_exts = {".html", ".css", ".js"}
        return all(Path(p).suffix in static_exts for p in changed)

    def schedule_restart(self, delay: float = 1.5) -> None:
        """Restart the server process after a short delay. Safe to call multiple times.

        Spawns a detached watcher process that polls until port 5050 is free,
        then starts a fresh server. The current process exits immediately via
        os._exit() so the port is released before the new bind attempt.

        If other agent processes are still running, the restart is deferred
        until all agents complete (checked via check_deferred_restart).
        """
        if self._restart_scheduled:
            return

        active = self._active_agent_count_fn()
        if active > 0:
            self._restart_pending = True
            logger.info(
                "Restart deferred — %d agent(s) still running. "
                "Will restart when all agents complete.", active,
            )
            return

        self._restart_scheduled = True
        self._restart_pending = False
        logger.info("Code change detected — scheduling server restart in %.1fs", delay)

        restart_cmd = json.dumps([sys.executable] + sys.argv)

        # Inline watcher script: waits for port to be free, then relaunches.
        # Receives the restart command as sys.argv[1] (JSON-encoded list).
        watcher_code = (
            "import socket, time, subprocess, sys, json\n"
            "cmd = json.loads(sys.argv[1])\n"
            "for _ in range(40):\n"
            "    try:\n"
            "        s = socket.create_connection(('127.0.0.1', 5050), timeout=0.5)\n"
            "        s.close()\n"
            "        time.sleep(0.5)\n"
            "    except OSError:\n"
            "        break\n"
            "subprocess.Popen(cmd)\n"
        )

        def _do_restart() -> None:
            time.sleep(delay)
            subprocess.Popen(
                [sys.executable, "-c", watcher_code, restart_cmd],
                start_new_session=True,
                close_fds=True,
            )
            # Exit immediately — releases the port so the watcher can rebind
            os._exit(0)

        threading.Thread(target=_do_restart, daemon=True).start()

    def check_deferred_restart(self, delay: float = 1.5) -> None:
        """If a restart was deferred because agents were running, try again now."""
        if not self._restart_pending:
            return
        self.schedule_restart(delay=delay)
