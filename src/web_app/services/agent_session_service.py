#!/usr/bin/env python3
"""Agent orchestration service for prompt assembly and SSE events."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Iterator

logger = logging.getLogger(__name__)

from agents.base import AgentProvider
from services.file_monitor_service import FileMonitorService
from services.image_service import ImageAttachmentService


@dataclass
class AgentSessionService:
    provider: AgentProvider
    image_service: ImageAttachmentService
    workspace: str = ""
    file_monitor: FileMonitorService | None = None

    def build_prompt(self, prompt: str, context_path: str, image_paths: list[str]) -> str:
        prompt_parts: list[str] = []

        now = datetime.now()
        prompt_parts.append(f"Current date/time: {now.strftime('%A, %B %d, %Y at %I:%M %p').strip()}")

        if image_paths:
            prompt_parts.append(f"\nAttached {len(image_paths)} image(s):")
            for idx, img_path in enumerate(image_paths, 1):
                prompt_parts.append(f"  Image {idx}: {img_path}")
            prompt_parts.append("")

        if prompt:
            prompt_parts.append(prompt)
        return "\n".join(prompt_parts)

    def stream_run(
        self, prompt: str, context_path: str, images: list[dict], model: str = "", chat_id: str = "",
    ) -> Iterator[str]:
        image_paths, temp_files = self.image_service.process_images(images or [])
        final_prompt = self.build_prompt(prompt, context_path, image_paths)

        logger.info("── prompt assembly ──────────────────────────────")
        logger.info("  raw prompt length : %d chars", len(prompt))
        logger.info("  final prompt length: %d chars", len(final_prompt))
        logger.info("  cwd               : %s", self.workspace)
        logger.info("  images            : %d", len(images or []))

        snapshot_before = self.file_monitor.snapshot() if self.file_monitor else None

        def emit(payload: dict) -> str:
            return f"data: {json.dumps(payload)}\n\n"

        yield emit({"type": "status", "message": self.provider.status_message})
        try:
            for line in self.provider.run_stream(
                prompt=final_prompt,
                workspace=self.workspace,
                model=model,
                chat_id=chat_id,
                images=images or [],
            ):
                try:
                    json.loads(line)
                    yield f"data: {line}\n\n"
                except json.JSONDecodeError:
                    yield emit({"type": "text", "content": line})

            logger.info("── agent completed ──────────────────────────────")
            if snapshot_before is not None and self.file_monitor.has_changed(snapshot_before):
                self.file_monitor.schedule_restart()
            yield emit({"type": "done", "exit_code": 0})
        except FileNotFoundError:
            yield emit({"type": "error", "message": "Agent CLI not found. Check that Claude Code is installed and on PATH."})
        except Exception as exc:
            yield emit({"type": "error", "message": str(exc)})
        finally:
            self.image_service.cleanup(temp_files)
            # If a restart was deferred (sibling agent changed code while we ran),
            # trigger it now if we're the last active agent.
            if self.file_monitor:
                self.file_monitor.check_deferred_restart()
