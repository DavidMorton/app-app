#!/usr/bin/env python3
"""
Approval controller

Three endpoints that wire the MCP approval-gate server to the frontend:

  POST /api/approval/request        MCP server → Flask: register a pending tool call
  GET  /api/approval/wait/<id>      MCP server → Flask: long-poll until user decides
  POST /api/approval/decide         Frontend  → Flask: submit allow / deny
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

from flask import Blueprint, jsonify, request

if TYPE_CHECKING:
    from agents.claude_code_provider import ClaudeCodeProvider
    from services.permission_rules_service import PermissionRulesService

# ── shared state (in-process, keyed by request_id) ───────────────────────────

_pending:  dict[str, dict]             = {}   # request_id → {chat_id, tool, input}
_decisions: dict[str, str]             = {}   # request_id → 'allow' | 'deny'
_events:    dict[str, threading.Event] = {}   # request_id → Event (unblocks wait endpoint)


def create_approval_blueprint(
    provider: "ClaudeCodeProvider",
    permission_rules_service: "PermissionRulesService | None" = None,
) -> Blueprint:
    bp = Blueprint("approval", __name__)

    # ── 1. MCP server registers a pending approval ────────────────────────────
    @bp.route("/api/approval/request", methods=["POST"])
    def api_approval_request():
        data       = request.get_json() or {}
        request_id = data.get("request_id", "")
        chat_id    = data.get("chat_id", "")
        tool       = data.get("tool", "")
        inp        = data.get("input", {})

        if not request_id:
            return jsonify({"error": "request_id required"}), 400

        # Stash so the decide endpoint can look it up
        event = threading.Event()
        _events[request_id]  = event
        _pending[request_id] = {"chat_id": chat_id, "tool": tool, "input": inp}

        # Check permission rules — only auto-approve; everything else
        # surfaces to the user so they can decide (no silent denials).
        if permission_rules_service is not None:
            verdict = permission_rules_service.check(tool, inp)
            if verdict == "allow":
                _decisions[request_id] = "allow"
                event.set()
                return jsonify({"ok": True, "request_id": request_id, "auto": "allow"}), 200

        # Auto-approve file operations inside the chat's code folder
        if tool in ("Write", "Edit", "MultiEdit") and hasattr(provider, "get_code_folder"):
            code_folder = provider.get_code_folder(chat_id)
            file_path = inp.get("file_path", "")
            if code_folder and file_path and file_path.startswith(code_folder + "/"):
                _decisions[request_id] = "allow"
                event.set()
                return jsonify({"ok": True, "request_id": request_id, "auto": "allow"}), 200

        # Derive a human-friendly description for the card
        description = (
            inp.get("command")
            or inp.get("content", "")[:120]
            or inp.get("old_string", "")[:80]
            or ""
        )
        path = inp.get("file_path", inp.get("path", ""))

        # Build always_allow_pattern for the frontend card
        always_allow_pattern = None
        if permission_rules_service is not None:
            if tool == "Bash":
                always_allow_pattern = permission_rules_service.suggest_bash_pattern(
                    inp.get("command", "")
                )
            elif tool in ("Write", "Edit", "MultiEdit"):
                file_path = inp.get("file_path", inp.get("path", ""))
                if file_path.endswith(".md"):
                    always_allow_pattern = "**/*.md"

        # Inject a permission_request event into the chat's live SSE stream
        if hasattr(provider, "inject_event"):
            provider.inject_event(chat_id, {
                "type":                 "permission_request",
                "request_id":           request_id,
                "tool":                 tool,
                "path":                 path,
                "description":          description,
                "input":                inp,
                "always_allow_pattern": always_allow_pattern,
            })

        return jsonify({"ok": True, "request_id": request_id}), 200

    # ── 2. MCP server long-polls here until the user decides ─────────────────
    @bp.route("/api/approval/wait/<request_id>", methods=["GET"])
    def api_approval_wait(request_id: str):
        ev = _events.get(request_id)
        if ev is None:
            return jsonify({"error": "Unknown request_id"}), 404

        # Block up to 5 minutes — Flask's threaded mode gives each request its
        # own thread so this doesn't block other requests.
        ev.wait(timeout=300)

        decision = _decisions.pop(request_id, "deny")   # timeout → deny
        _events.pop(request_id, None)
        _pending.pop(request_id, None)

        return jsonify({"decision": decision})

    # ── 3. Frontend submits the user's decision ───────────────────────────────
    @bp.route("/api/approval/decide", methods=["POST"])
    def api_approval_decide():
        data       = request.get_json() or {}
        request_id = data.get("request_id", "")
        decision   = data.get("decision", "deny")

        if not request_id:
            return jsonify({"error": "request_id required"}), 400
        if decision not in ("allow", "deny"):
            return jsonify({"error": "decision must be 'allow' or 'deny'"}), 400

        ev = _events.get(request_id)
        if ev is None:
            return jsonify({"error": "No pending request for this request_id"}), 404

        # Store decision then unblock the waiting MCP thread
        _decisions[request_id] = decision
        ev.set()

        # Also inject a permission_decision event so the SSE card can update
        chat_id = _pending.get(request_id, {}).get("chat_id", "")
        if chat_id and hasattr(provider, "inject_event"):
            provider.inject_event(chat_id, {
                "type":       "permission_decision",
                "request_id": request_id,
                "approved":   decision == "allow",
            })

        return jsonify({"ok": True, "decision": decision})

    # ── 4. MCP server registers a user question (no approval needed) ─────
    @bp.route("/api/approval/question", methods=["POST"])
    def api_approval_question():
        data       = request.get_json() or {}
        request_id = data.get("request_id", "")
        chat_id    = data.get("chat_id", "")
        questions  = data.get("questions", [])

        if not request_id:
            return jsonify({"error": "request_id required"}), 400

        event = threading.Event()
        _events[request_id]  = event
        _pending[request_id] = {"chat_id": chat_id, "type": "question", "questions": questions}

        # Inject a user_question event into the chat's live SSE stream
        if hasattr(provider, "inject_event"):
            provider.inject_event(chat_id, {
                "type":       "user_question",
                "request_id": request_id,
                "questions":  questions,
            })

        return jsonify({"ok": True, "request_id": request_id}), 200

    # ── 5. Frontend submits the user's answer to a question ────────────
    @bp.route("/api/approval/answer", methods=["POST"])
    def api_approval_answer():
        data       = request.get_json() or {}
        request_id = data.get("request_id", "")
        answer     = data.get("answer", "")

        if not request_id:
            return jsonify({"error": "request_id required"}), 400

        ev = _events.get(request_id)
        if ev is None:
            return jsonify({"error": "No pending request for this request_id"}), 404

        # Store answer as the "decision" and unblock the waiting MCP thread
        _decisions[request_id] = answer
        ev.set()

        return jsonify({"ok": True})

    return bp
