#!/usr/bin/env python3
"""
AppApp Web App
A local web interface with an AI-powered chat that can modify its own codebase.
"""

import logging
import os
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask

# Load .env from the src directory (parent of web_app)
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from agents.claude_code_provider import ClaudeCodeProvider
from config import AppConfig
from controllers.agent_controller import create_agent_blueprint
from controllers.approval_controller import create_approval_blueprint
from controllers.chat_controller import create_chat_blueprint
from controllers.meta_controller import create_meta_blueprint
from controllers.permissions_controller import create_permissions_blueprint
from services.agent_session_service import AgentSessionService
from services.file_monitor_service import FileMonitorService
from services.permission_rules_service import PermissionRulesService
from services.chat_repository import ChatRepository
from services.image_service import ImageAttachmentService


def create_app() -> Flask:
    config = AppConfig()
    app = Flask(__name__)
    app_start_time = datetime.now().timestamp()

    config.chats_dir.mkdir(parents=True, exist_ok=True)

    # Core services
    chat_repository = ChatRepository(config.chats_dir)
    image_service = ImageAttachmentService(config.temp_images_dir)
    permission_rules_service = PermissionRulesService(config.app_dir / "permission_rules.json")

    # Claude Code provider
    provider = ClaudeCodeProvider(
        sessions_file=config.app_data_dir / "sessions.json",
    )

    file_monitor_service = FileMonitorService(
        watch_dir=config.app_dir,
        active_agent_count_fn=lambda: provider.active_run_count,
    )

    agent_session_service = AgentSessionService(
        provider=provider,
        image_service=image_service,
        workspace=str(config.workspace_root),
        file_monitor=file_monitor_service,
    )

    # Blueprints
    app.register_blueprint(
        create_agent_blueprint(
            provider=provider,
            agent_session_service=agent_session_service,
            workspace_root=str(config.workspace_root),
            config=config,
        )
    )
    app.register_blueprint(create_chat_blueprint(chat_repository=chat_repository))
    app.register_blueprint(create_approval_blueprint(
        provider=provider,
        permission_rules_service=permission_rules_service,
    ))
    app.register_blueprint(create_permissions_blueprint(
        permission_rules_service=permission_rules_service,
    ))
    app.register_blueprint(
        create_meta_blueprint(
            static_dir=config.app_dir / "static",
            workspace_root=config.workspace_root,
            app_start_time=app_start_time,
            file_monitor=file_monitor_service,
        )
    )

    return app


app = create_app()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("agents.claude_code_provider").setLevel(logging.DEBUG)

    config = AppConfig()
    os.environ["FLASK_SKIP_DOTENV"] = "1"
    print(f"\n{'=' * 60}")
    print("  📦 AppApp")
    print(f"  📁 Workspace: {config.workspace_root}")
    print("  🌐 URL: http://127.0.0.1:5050")
    print(f"{'=' * 60}\n")
    app.run(host="127.0.0.1", port=5050, debug=True, use_reloader=False)
