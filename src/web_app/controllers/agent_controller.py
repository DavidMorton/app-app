#!/usr/bin/env python3
"""Blueprint for agent-provider endpoints."""

from __future__ import annotations

import subprocess

from flask import Blueprint, Response, jsonify, request

from agents.base import AgentProvider
from services.agent_session_service import AgentSessionService


def create_agent_blueprint(
    provider: AgentProvider,
    agent_session_service: AgentSessionService,
    workspace_root: str,
    **_kwargs,
):
    bp = Blueprint("agent", __name__)

    @bp.route("/api/agent/create-chat", methods=["POST"])
    def api_agent_create_chat():
        try:
            return jsonify({"chat_id": provider.create_chat()})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

    @bp.route("/api/agent/models", methods=["GET"])
    def api_agent_models():
        try:
            models, default_model = provider.list_models()
            return jsonify({"models": models, "default": default_model})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

    @bp.route("/api/agent/tool-result", methods=["POST"])
    def api_agent_tool_result():
        """Frontend submits the answer to an AskFollowupQuestion tool call."""
        if not hasattr(provider, "send_tool_result"):
            return jsonify({"error": "Provider does not support mid-stream tool results"}), 501
        data = request.get_json() or {}
        chat_id = data.get("chat_id", "")
        tool_use_id = data.get("tool_use_id", "")
        content = data.get("content", "")
        if not chat_id or not tool_use_id:
            return jsonify({"error": "chat_id and tool_use_id are required"}), 400
        ok = provider.send_tool_result(chat_id, tool_use_id, content)
        return jsonify({"ok": ok})

    @bp.route("/api/agent/cancel", methods=["POST"])
    def api_agent_cancel():
        """Cancel the running agent for a chat."""
        data = request.get_json() or {}
        chat_id = data.get("chat_id", "")
        if not chat_id:
            return jsonify({"error": "chat_id is required"}), 400
        ok = provider.cancel(chat_id)
        return jsonify({"ok": ok})

    @bp.route("/api/agent/session-info/<chat_id>", methods=["GET"])
    def api_agent_session_info(chat_id):
        """Return persisted session metadata for a chat."""
        return jsonify({"chat_id": chat_id})

    @bp.route("/api/agent/run", methods=["POST"])
    def api_agent_run():
        data = request.get_json() or {}
        prompt = data.get("prompt", "")
        images = data.get("images", [])
        if not prompt and not images:
            return jsonify({"error": "No prompt or images provided"}), 400

        context_path = data.get("context_path", "")
        chat_id = data.get("chat_id", "")
        model = data.get("model", "")

        return Response(
            agent_session_service.stream_run(
                prompt=prompt,
                context_path=context_path,
                images=images,
                model=model,
                chat_id=chat_id,
            ),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return bp
