#!/usr/bin/env python3
"""Blueprint for static serving, health, and restart endpoints."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from flask import Blueprint, jsonify, render_template, send_from_directory


def create_meta_blueprint(static_dir: Path, workspace_root: Path, app_start_time: float, file_monitor=None):
    bp = Blueprint("meta", __name__)

    @bp.route("/")
    def index():
        return render_template("index.html")

    @bp.route("/static/<path:filename>")
    def static_files(filename):
        return send_from_directory(str(static_dir), filename)

    @bp.route("/api/workspace-info")
    def api_workspace_info():
        return jsonify({
            "root": str(workspace_root),
            "name": workspace_root.name,
        })

    @bp.route("/api/health")
    def api_health():
        return jsonify({"status": "ok", "start_time": app_start_time})

    @bp.route("/api/restart", methods=["POST"])
    def api_restart():
        """Force-restart the backend process."""
        if file_monitor is not None:
            file_monitor.schedule_restart(delay=0.3)
        else:
            import threading

            def _do_restart():
                import time
                time.sleep(0.3)
                restart_cmd = json.dumps([sys.executable] + sys.argv)
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
                subprocess.Popen(
                    [sys.executable, "-c", watcher_code, restart_cmd],
                    start_new_session=True,
                    close_fds=True,
                )
                os._exit(0)

            threading.Thread(target=_do_restart, daemon=True).start()
        return jsonify({"status": "restarting"})

    return bp
