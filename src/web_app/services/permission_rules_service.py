#!/usr/bin/env python3
"""
Permission Rules Service

Manages persistent allow/deny rules for MCP tool calls.
Rules are stored in permission_rules.json and checked before showing
approval cards to the user.
"""

from __future__ import annotations

import fnmatch
import json
import logging
import os
import shlex
import uuid
from pathlib import Path
from typing import Literal

log = logging.getLogger(__name__)

# Commands that should never get an "Always Allow" suggestion
DANGEROUS = {
    "rm", "rmdir", "sudo", "su", "curl", "wget", "pip", "npm", "brew",
    "kill", "killall", "pkill", "dd", "mkfs", "chmod", "chown", "shutdown",
}

_DEFAULT_RULES: list[dict] = [
    # Allow safe file-editing tools on markdown files
    {"tool": "Write",     "match_type": "glob",   "pattern": "**/*.md", "action": "allow"},
    {"tool": "Edit",      "match_type": "glob",   "pattern": "**/*.md", "action": "allow"},
    {"tool": "MultiEdit", "match_type": "glob",   "pattern": "**/*.md", "action": "allow"},
    # Allow common read-only / safe bash commands
    {"tool": "Bash", "match_type": "prefix", "pattern": "grep",   "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "git",    "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "ls",     "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "find",   "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "cat",    "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "wc",     "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "head",   "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "tail",   "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "echo",   "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "pwd",    "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "python", "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "sort",   "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "uniq",   "action": "allow"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "diff",   "action": "allow"},
    # Deny dangerous bash commands
    {"tool": "Bash", "match_type": "prefix", "pattern": "rm",       "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "rmdir",    "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "sudo",     "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "su",       "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "curl",     "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "wget",     "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "pip",      "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "npm",      "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "brew",     "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "kill",     "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "killall",  "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "dd",       "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "chmod",    "action": "deny"},
    {"tool": "Bash", "match_type": "prefix", "pattern": "chown",    "action": "deny"},
]


class PermissionRulesService:
    """Load, save, and evaluate permission rules for MCP tool calls."""

    def __init__(self, rules_path: Path) -> None:
        self._path = rules_path
        self._rules: list[dict] = []
        self._load()

    # ── Public API ────────────────────────────────────────────────────────────

    def check(self, tool: str, tool_input: dict) -> Literal["allow", "deny", "ask"]:
        """Return 'allow', 'deny', or 'ask' for a given tool call."""
        # Deny rules take priority
        for action in ("deny", "allow"):
            for rule in self._rules:
                if rule.get("action") != action:
                    continue
                if self._matches(rule, tool, tool_input):
                    log.debug("Permission rule matched (%s): %s", action, rule)
                    return action
        return "ask"

    def add_rule(self, tool: str, match_type: str, pattern: str, action: str) -> dict:
        """Create a new rule, persist it, and return the rule dict."""
        if match_type not in ("glob", "prefix"):
            raise ValueError(f"Invalid match_type: {match_type!r}")
        if action not in ("allow", "deny"):
            raise ValueError(f"Invalid action: {action!r}")

        rule = {
            "id":         str(uuid.uuid4()),
            "tool":       tool,
            "match_type": match_type,
            "pattern":    pattern,
            "action":     action,
        }
        self._rules.append(rule)
        self._save()
        return rule

    def remove_rule(self, rule_id: str) -> bool:
        """Remove rule by id. Returns True if found and removed."""
        original = len(self._rules)
        self._rules = [r for r in self._rules if r.get("id") != rule_id]
        if len(self._rules) < original:
            self._save()
            return True
        return False

    def list_rules(self) -> list[dict]:
        """Return a copy of the current rule list."""
        return list(self._rules)

    def suggest_bash_pattern(self, command: str) -> str | None:
        """
        Extract the base command name from a bash command string.
        Returns None for dangerous commands or if parsing fails.
        """
        command = command.strip()
        if not command:
            return None
        try:
            parts = shlex.split(command)
        except ValueError:
            return None
        if not parts:
            return None
        base = os.path.basename(parts[0])
        if base in DANGEROUS:
            return None
        return base

    # ── Private helpers ───────────────────────────────────────────────────────

    def _matches(self, rule: dict, tool: str, tool_input: dict) -> bool:
        if rule.get("tool") != tool:
            return False
        match_type = rule.get("match_type")
        pattern = rule.get("pattern", "")

        if match_type == "glob":
            file_path = tool_input.get("file_path") or tool_input.get("path", "")
            if not file_path:
                return False
            # Try both the raw path and with a leading / so that patterns
            # like **/src/** match relative paths like src/file.js
            if fnmatch.fnmatch(file_path, pattern):
                return True
            if not file_path.startswith("/"):
                return fnmatch.fnmatch("/" + file_path, pattern)
            return False

        if match_type == "prefix":
            command = tool_input.get("command", "")
            base = self.suggest_bash_pattern(command)
            # suggest_bash_pattern returns None for dangerous commands,
            # but we still need to match deny rules for them.
            if base is None:
                # Try extracting without the dangerous-filter
                try:
                    parts = shlex.split(command.strip())
                    base = os.path.basename(parts[0]) if parts else ""
                except ValueError:
                    base = ""
            return base == pattern

        return False

    def _load(self) -> None:
        if self._path.exists():
            try:
                data = json.loads(self._path.read_text())
                self._rules = data.get("rules", [])
                log.info("Loaded %d permission rules from %s", len(self._rules), self._path)
                return
            except Exception as exc:
                log.warning("Failed to load permission rules (%s); seeding defaults", exc)

        # First run — seed defaults
        self._rules = [
            {"id": str(uuid.uuid4()), **r} for r in _DEFAULT_RULES
        ]
        self._save()
        log.info("Seeded %d default permission rules to %s", len(self._rules), self._path)

    def _save(self) -> None:
        try:
            self._path.write_text(
                json.dumps({"version": 1, "rules": self._rules}, indent=2)
            )
        except Exception as exc:
            log.error("Failed to save permission rules: %s", exc)
