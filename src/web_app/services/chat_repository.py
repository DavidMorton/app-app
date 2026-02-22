#!/usr/bin/env python3
"""Persistence for local chat history files."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


@dataclass
class ChatRepository:
    chats_dir: Path

    def __post_init__(self) -> None:
        self.chats_dir.mkdir(parents=True, exist_ok=True)

    def get_chat_file_path(self, chat_id: str) -> Path:
        safe_chat_id = re.sub(r"[^a-zA-Z0-9_-]", "", chat_id)
        if not safe_chat_id or safe_chat_id != chat_id:
            raise ValueError(f"Invalid chat_id: {chat_id}")
        return self.chats_dir / f"{chat_id}.json"

    def load_chat(self, chat_id: str) -> dict | None:
        try:
            chat_path = self.get_chat_file_path(chat_id)
            if not chat_path.exists():
                return None
            return json.loads(chat_path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def save_chat(self, chat_data: dict) -> dict:
        chat_id = chat_data.get("chat_id")
        if not chat_id:
            raise ValueError("chat_id is required")
        chat_path = self.get_chat_file_path(chat_id)

        if "messages" not in chat_data:
            chat_data["messages"] = []

        if "created_at" not in chat_data:
            chat_data["created_at"] = datetime.now().isoformat()
        chat_data["updated_at"] = datetime.now().isoformat()

        if "title" not in chat_data or not chat_data["title"]:
            for msg in chat_data["messages"]:
                if msg.get("role") == "user":
                    first_content = msg.get("content", "")
                    chat_data["title"] = first_content[:50] + ("..." if len(first_content) > 50 else "")
                    break
            if "title" not in chat_data or not chat_data["title"]:
                chat_data["title"] = "New Chat"

        chat_path.write_text(json.dumps(chat_data, indent=2, ensure_ascii=False), encoding="utf-8")
        return chat_data

    def delete_chat(self, chat_id: str) -> bool:
        chat_path = self.get_chat_file_path(chat_id)
        if chat_path.exists():
            chat_path.unlink()
            return True
        return False

    def list_chats(self) -> list[dict]:
        if not self.chats_dir.exists():
            self.chats_dir.mkdir(parents=True, exist_ok=True)
            return []

        chats: list[dict] = []
        for chat_file in sorted(self.chats_dir.glob("*.json"), reverse=True):
            chat_data = self.load_chat(chat_file.stem)
            if not chat_data:
                continue
            message_count = len(chat_data.get("messages", []))
            if message_count <= 0:
                continue
            chats.append(
                {
                    "chat_id": chat_data.get("chat_id"),
                    "title": chat_data.get("title", "Untitled"),
                    "created_at": chat_data.get("created_at"),
                    "updated_at": chat_data.get("updated_at"),
                    "message_count": message_count,
                }
            )

        chats.sort(key=lambda x: x.get("updated_at") or x.get("created_at", ""), reverse=True)
        return chats

    def append_message(self, chat_id: str, role: str, content: str, timestamp: str) -> dict:
        if role not in ["user", "assistant"]:
            raise ValueError('role must be "user" or "assistant"')

        chat_data = self.load_chat(chat_id)
        if not chat_data:
            chat_data = {"chat_id": chat_id, "messages": []}

        chat_data["messages"].append({"role": role, "content": content, "timestamp": timestamp})
        return self.save_chat(chat_data)

    def search_chats(self, query: str, limit: int = 20) -> list[dict]:
        """Full-text search across all chat messages. Returns matching chats with context."""
        if not query or not query.strip():
            return []

        query_lower = query.lower().strip()
        results: list[dict] = []

        for chat_file in self.chats_dir.glob("*.json"):
            chat_data = self.load_chat(chat_file.stem)
            if not chat_data:
                continue
            messages = chat_data.get("messages", [])
            if not messages:
                continue

            # Search through messages for matches
            matching_snippets: list[str] = []
            for msg in messages:
                content = msg.get("content", "")
                if query_lower in content.lower():
                    # Extract a snippet around the match
                    idx = content.lower().index(query_lower)
                    start = max(0, idx - 60)
                    end = min(len(content), idx + len(query_lower) + 60)
                    snippet = ("…" if start > 0 else "") + content[start:end] + ("…" if end < len(content) else "")
                    matching_snippets.append(snippet)

            if matching_snippets:
                results.append({
                    "chat_id": chat_data.get("chat_id"),
                    "title": chat_data.get("title", "Untitled"),
                    "created_at": chat_data.get("created_at"),
                    "updated_at": chat_data.get("updated_at"),
                    "message_count": len(messages),
                    "match_count": len(matching_snippets),
                    "snippets": matching_snippets[:3],  # Limit snippets per chat
                })

        results.sort(key=lambda x: x.get("updated_at") or x.get("created_at", ""), reverse=True)
        return results[:limit]

