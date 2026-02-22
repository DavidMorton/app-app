#!/usr/bin/env python3

from __future__ import annotations

import sys
from pathlib import Path


WEB_APP_DIR = Path(__file__).resolve().parents[1]
if str(WEB_APP_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_APP_DIR))

from agents.base import AgentProvider
from services.agent_session_service import AgentSessionService
from services.chat_repository import ChatRepository
from services.image_service import ImageAttachmentService


class FakeProvider(AgentProvider):
    def __init__(self, lines=None, error: Exception | None = None):
        self.lines = lines or []
        self.error = error

    def open_target(self, target: str) -> None:
        return None

    def create_chat(self) -> str:
        return "chat-1"

    def list_models(self) -> tuple[list[dict], str | None]:
        return [], None

    def run_stream(self, prompt: str, workspace: str, model: str = "", chat_id: str = "", **kwargs):
        if self.error:
            raise self.error
        for line in self.lines:
            yield line


def test_chat_repository_save_and_list(tmp_path):
    repo = ChatRepository(tmp_path / "chats")
    saved = repo.append_message("abc123", "user", "hello world", "2026-02-18T00:00:00")
    assert saved["chat_id"] == "abc123"
    assert len(saved["messages"]) == 1
    listing = repo.list_chats()
    assert len(listing) == 1
    assert listing[0]["chat_id"] == "abc123"


def test_agent_session_stream_parses_json_and_text(tmp_path):
    image_service = ImageAttachmentService(tmp_path / "temp_images")
    provider = FakeProvider(lines=['{"type":"token","content":"hi"}', "plain text line"])
    session = AgentSessionService(provider=provider, image_service=image_service, workspace=str(tmp_path))

    events = list(session.stream_run(prompt="hello", context_path="", images=[]))
    joined = "".join(events)
    assert '"type": "status"' in joined
    assert '{"type":"token","content":"hi"}' in joined
    assert '"type": "text"' in joined
    assert '"type": "done"' in joined
