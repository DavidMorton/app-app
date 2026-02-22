#!/usr/bin/env python3
"""Provider abstraction for agent backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Iterator

 
class AgentProvider(ABC):
    """Interface for backend agent providers."""

    @property
    def status_message(self) -> str:
        """Human-readable label shown in the UI when a run starts."""
        return "Starting agent..."

    @abstractmethod
    def open_target(self, target: str) -> None:
        raise NotImplementedError

    @abstractmethod
    def create_chat(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def list_models(self) -> tuple[list[dict], str | None]:
        raise NotImplementedError

    @abstractmethod
    def run_stream(self, prompt: str, workspace: str, model: str = "", chat_id: str = "") -> Iterator[str]:
        """Yield newline-delimited stream-json lines."""
        raise NotImplementedError

    def cancel(self, chat_id: str) -> bool:
        """Cancel the running agent for *chat_id*.  Returns True if cancelled."""
        return False
