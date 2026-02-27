"""Agent configuration service."""

import os
import yaml
from typing import Optional

# Default to docker-compose path, can be overridden
AGENTS_DIR = os.environ.get("AGENTS_DIR", "/agents")


async def get_agent_config(agent_id: str) -> dict:
    """
    Get agent configuration from config.yml.

    Returns a dictionary with the agent's configuration settings.
    """
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    config_path = os.path.join(agent_dir, "config.yml")

    if not os.path.exists(config_path):
        # Return default config if no config file exists
        return {
            "model": "anthropic/claude-sonnet-4",
            "thinkingModel": "anthropic/claude-sonnet-4",
        }

    try:
        with open(config_path, "r") as f:
            config = yaml.safe_load(f) or {}
            return config
    except Exception:
        return {
            "model": "anthropic/claude-sonnet-4",
            "thinkingModel": "anthropic/claude-sonnet-4",
        }


async def update_agent_config(agent_id: str, updates: dict) -> dict:
    """
    Update agent configuration.

    Merges the updates with existing config and saves to config.yml.
    """
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    config_path = os.path.join(agent_dir, "config.yml")

    # Load existing config
    existing = await get_agent_config(agent_id)

    # Merge updates
    existing.update(updates)

    # Ensure directory exists
    os.makedirs(agent_dir, exist_ok=True)

    # Save
    with open(config_path, "w") as f:
        yaml.safe_dump(existing, f, default_flow_style=False)

    return existing
