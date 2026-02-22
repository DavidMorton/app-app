#!/usr/bin/env python3
"""Web app configuration and shared constants."""

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class AppConfig:
    """Configuration values used throughout the web app."""

    app_dir: Path = field(default_factory=lambda: Path(__file__).resolve().parent)

    @property
    def workspace_root(self) -> Path:
        """The code directory the app runs in (defaults to cwd)."""
        env_val = os.environ.get("APPAPP_WORKSPACE")
        if env_val:
            return Path(env_val).resolve()
        return Path.cwd().resolve()

    @property
    def app_data_dir(self) -> Path:
        """Persistent app data (sessions, etc.)."""
        d = self.app_dir / "_app_data"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def temp_images_dir(self) -> Path:
        return self.app_data_dir / "temp_images"

    @property
    def chats_dir(self) -> Path:
        return self.app_data_dir / "chats"
