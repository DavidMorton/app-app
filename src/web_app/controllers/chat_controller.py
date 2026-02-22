#!/usr/bin/env python3
"""Blueprint for chat persistence APIs."""

from __future__ import annotations

from datetime import datetime

from flask import Blueprint, jsonify, request

from services.chat_repository import ChatRepository


def create_chat_blueprint(chat_repository: ChatRepository):
    bp = Blueprint("chat", __name__)

    @bp.route("/api/chats", methods=["GET"])
    def api_list_chats():
        try:
            return jsonify({"chats": chat_repository.list_chats()})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

    @bp.route("/api/chats/search", methods=["GET"])
    def api_search_chats():
        try:
            query = request.args.get("q", "").strip()
            limit = int(request.args.get("limit", "20"))
            if not query:
                return jsonify({"error": "q parameter is required"}), 400
            results = chat_repository.search_chats(query, limit=limit)
            return jsonify({"query": query, "results": results})
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

    @bp.route("/api/chats/<chat_id>", methods=["GET"])
    def api_get_chat(chat_id):
        try:
            chat_data = chat_repository.load_chat(chat_id)
            if not chat_data:
                return jsonify({"error": "Chat not found"}), 404
            return jsonify(chat_data)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

    @bp.route("/api/chats/<chat_id>", methods=["DELETE"])
    def api_delete_chat(chat_id):
        try:
            deleted = chat_repository.delete_chat(chat_id)
            if deleted:
                return jsonify({"success": True})
            return jsonify({"error": "Chat not found"}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

    @bp.route("/api/chats/save", methods=["POST"])
    def api_save_message():
        try:
            data = request.get_json() or {}
            chat_id = data.get("chat_id")
            role = data.get("role")
            content = data.get("content", "")
            timestamp = data.get("timestamp", datetime.now().isoformat())

            if not chat_id:
                return jsonify({"error": "chat_id is required"}), 400
            saved_chat = chat_repository.append_message(chat_id, role, content, timestamp)
            return jsonify(
                {
                    "success": True,
                    "chat": {
                        "chat_id": saved_chat["chat_id"],
                        "title": saved_chat.get("title", "Untitled"),
                        "message_count": len(saved_chat["messages"]),
                    },
                }
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500


    return bp
