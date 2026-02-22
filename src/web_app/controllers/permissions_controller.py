#!/usr/bin/env python3
"""
Permissions controller

REST API for managing permission rules:

  GET  /api/permissions/rules          → {rules: [...]}
  POST /api/permissions/rules          → add rule → {ok, rule}
  DELETE /api/permissions/rules/<id>   → remove rule → {ok}
  POST /api/permissions/suggest        → {tool, input} → {pattern: str | null}
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from flask import Blueprint, jsonify, request

if TYPE_CHECKING:
    from services.permission_rules_service import PermissionRulesService


def create_permissions_blueprint(permission_rules_service: "PermissionRulesService") -> Blueprint:
    bp = Blueprint("permissions", __name__)

    @bp.route("/api/permissions/rules", methods=["GET"])
    def list_rules():
        return jsonify({"rules": permission_rules_service.list_rules()})

    @bp.route("/api/permissions/rules", methods=["POST"])
    def add_rule():
        data = request.get_json() or {}
        tool       = data.get("tool", "")
        match_type = data.get("match_type", "")
        pattern    = data.get("pattern", "")
        action     = data.get("action", "")

        if not all([tool, match_type, pattern, action]):
            return jsonify({"error": "tool, match_type, pattern, action are required"}), 400

        try:
            rule = permission_rules_service.add_rule(tool, match_type, pattern, action)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        return jsonify({"ok": True, "rule": rule}), 201

    @bp.route("/api/permissions/rules/<rule_id>", methods=["DELETE"])
    def remove_rule(rule_id: str):
        removed = permission_rules_service.remove_rule(rule_id)
        if not removed:
            return jsonify({"error": "Rule not found"}), 404
        return jsonify({"ok": True})

    @bp.route("/api/permissions/suggest", methods=["POST"])
    def suggest_pattern():
        data    = request.get_json() or {}
        tool    = data.get("tool", "")
        inp     = data.get("input", {})

        pattern = None
        if tool == "Bash":
            command = inp.get("command", "") if isinstance(inp, dict) else ""
            pattern = permission_rules_service.suggest_bash_pattern(command)
        elif tool in ("Write", "Edit", "MultiEdit"):
            file_path = inp.get("file_path", "") if isinstance(inp, dict) else ""
            if file_path.endswith(".md"):
                pattern = "**/*.md"

        return jsonify({"pattern": pattern})

    return bp
