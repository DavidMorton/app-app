#!/usr/bin/env python3
"""Image attachment processing for agent prompts."""

from __future__ import annotations

import base64
import time
import uuid
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ImageAttachmentService:
    temp_images_dir: Path

    def __post_init__(self) -> None:
        self.temp_images_dir.mkdir(parents=True, exist_ok=True)

    def process_images(self, images: list[dict]) -> tuple[list[str], list[Path]]:
        image_paths: list[str] = []
        temp_files: list[Path] = []
        ext_map = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/gif": ".gif",
            "image/webp": ".webp",
        }

        for img_data in images or []:
            try:
                image_bytes = base64.b64decode(img_data.get("data", ""))
                image_type = img_data.get("type", "image/png")
                ext = ext_map.get(image_type, ".png")
                unique_id = str(uuid.uuid4())[:8]
                filename = f"{unique_id}_{int(time.time() * 1000)}{ext}"
                filepath = self.temp_images_dir / filename
                filepath.write_bytes(image_bytes)
                image_paths.append(str(filepath))
                temp_files.append(filepath)
            except Exception:
                # Keep parity with prior behavior: skip invalid images and continue.
                continue

        return image_paths, temp_files

    def cleanup(self, temp_files: list[Path]) -> None:
        for temp_file in temp_files:
            try:
                if temp_file.exists():
                    temp_file.unlink()
            except Exception:
                pass
