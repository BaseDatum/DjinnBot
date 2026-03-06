"""Shared test fixtures for the djinnbot CLI tests."""

import pytest
import httpx
import respx
from typer.testing import CliRunner

from djinnbot.main import app
from djinnbot.client import DjinnBotClient


@pytest.fixture
def runner():
    """Typer CLI runner."""
    return CliRunner()


@pytest.fixture
def mock_api():
    """respx mock router scoped to the default base URL."""
    with respx.mock(
        base_url="http://localhost:8000", assert_all_called=False
    ) as router:
        yield router


@pytest.fixture
def client():
    """DjinnBotClient instance."""
    c = DjinnBotClient(base_url="http://localhost:8000")
    yield c
    c.close()


# ── Sample API response data matching actual server shapes ──────────


SAMPLE_STATUS = {
    "status": "ok",
    "version": "0.1.0",
    "redis_connected": True,
    "active_runs": 2,
    "total_pipelines": 3,
    "total_agents": 4,
    "github": {"configured": True, "healthy": True},
}

SAMPLE_PIPELINE = {
    "id": "code-review",
    "name": "Code Review",
    "description": "Automated code review pipeline",
    "steps": [
        {"id": "analyze", "agent": "reviewer", "description": "Analyze code"},
        {"id": "report", "agent": "writer", "description": "Write report"},
    ],
    "agents": ["reviewer", "writer"],
}

SAMPLE_PIPELINES = [SAMPLE_PIPELINE]

SAMPLE_VALIDATE_OK = {
    "valid": True,
    "pipeline_id": "code-review",
    "errors": [],
    "warnings": ["Step 1 has no agent assigned"],
}

SAMPLE_VALIDATE_FAIL = {
    "valid": False,
    "pipeline_id": "bad-pipeline",
    "errors": ["Pipeline has no steps defined"],
    "warnings": [],
}

SAMPLE_RUN = {
    "id": "run_abc123def456",
    "pipeline_id": "code-review",
    "project_id": None,
    "task": "Review PR #42",
    "status": "running",
    "current_step": "analyze",
    "outputs": {},
    "created_at": 1700000000000,
    "updated_at": 1700000060000,
    "completed_at": None,
    "human_context": None,
    "workspace_exists": False,
    "workspace_has_git": False,
    "steps": [
        {
            "id": "run_abc123def456_analyze",
            "step_id": "analyze",
            "agent_id": "reviewer",
            "status": "running",
            "outputs": {},
            "inputs": {"code": "def foo(): pass"},
            "error": None,
            "retry_count": 0,
            "max_retries": 3,
            "session_id": "sess_123",
            "started_at": 1700000010000,
            "completed_at": None,
            "human_context": None,
        },
        {
            "id": "run_abc123def456_report",
            "step_id": "report",
            "agent_id": "writer",
            "status": "pending",
            "outputs": {},
            "inputs": {},
            "error": None,
            "retry_count": 0,
            "max_retries": 3,
            "session_id": None,
            "started_at": None,
            "completed_at": None,
            "human_context": None,
        },
    ],
}

SAMPLE_RUN_LIST = [
    {
        "id": "run_abc123def456",
        "pipeline_id": "code-review",
        "project_id": None,
        "task": "Review PR #42",
        "status": "running",
        "current_step": "analyze",
        "outputs": {},
        "created_at": 1700000000000,
        "updated_at": 1700000060000,
        "completed_at": None,
        "human_context": None,
    }
]

SAMPLE_RUN_LOGS = [
    {
        "type": "RUN_CREATED",
        "runId": "run_abc123def456",
        "pipelineId": "code-review",
        "taskDescription": "Review PR #42",
        "timestamp": 1700000000000,
    },
    {
        "type": "STEP_STARTED",
        "runId": "run_abc123def456",
        "stepId": "analyze",
        "agentId": "reviewer",
        "timestamp": 1700000010000,
    },
]

SAMPLE_AGENT = {
    "id": "reviewer",
    "name": "Reviewer Bot",
    "emoji": "🔍",
    "role": "Code reviewer",
    "description": "Reviews code for quality and correctness",
    "persona_files": ["IDENTITY.md", "SOUL.md"],
    "slack_connected": True,
    "memory_count": 5,
    "files": {
        "IDENTITY.md": "# Reviewer Bot\n- **Name:** Reviewer Bot\n- **Role:** Code reviewer",
        "SOUL.md": "You are a meticulous code reviewer...",
    },
    "soul_preview": "You are a meticulous code reviewer...",
}

SAMPLE_AGENTS = [
    {
        "id": "reviewer",
        "name": "Reviewer Bot",
        "emoji": "🔍",
        "role": "Code reviewer",
        "description": "Reviews code",
        "persona_files": ["IDENTITY.md", "SOUL.md"],
        "slack_connected": True,
        "memory_count": 5,
    },
    {
        "id": "writer",
        "name": "Writer Bot",
        "emoji": "✍️",
        "role": "Content writer",
        "description": None,
        "persona_files": ["IDENTITY.md"],
        "slack_connected": False,
        "memory_count": 0,
    },
]

SAMPLE_AGENTS_STATUS = {
    "agents": [
        {
            "id": "reviewer",
            "name": "Reviewer Bot",
            "emoji": "🔍",
            "role": "Code reviewer",
            "state": "working",
            "currentWork": {"step": "analyze", "runId": "run_abc123def456"},
            "queueLength": 1,
            "lastActive": 1700000060000,
            "lastPulse": None,
            "pulseEnabled": False,
            "slackConnected": True,
        },
        {
            "id": "writer",
            "name": "Writer Bot",
            "emoji": "✍️",
            "role": "Content writer",
            "state": "idle",
            "currentWork": None,
            "queueLength": 0,
            "lastActive": None,
            "lastPulse": None,
            "pulseEnabled": False,
            "slackConnected": False,
        },
    ],
    "summary": {
        "total": 2,
        "idle": 1,
        "working": 1,
        "thinking": 0,
        "totalQueued": 1,
    },
}

SAMPLE_AGENT_STATUS = {
    "id": "reviewer",
    "name": "Reviewer Bot",
    "emoji": "🔍",
    "role": "Code reviewer",
    "persona_files": ["IDENTITY.md", "SOUL.md"],
    "slack_connected": True,
    "memory_count": 5,
    "status": "online",
    "last_seen": 1700000060000,
    "active_steps": [
        {"run_id": "run_abc123def456", "step_id": "analyze", "started_at": "10:00"},
    ],
    "current_run": "run_abc123def456",
}

SAMPLE_AGENT_RUNS = [
    {
        "run_id": "run_abc123def456",
        "pipeline_id": "code-review",
        "task": "Review PR #42",
        "status": "running",
        "step_ids": ["analyze"],
        "created_at": 1700000000000,
    }
]

SAMPLE_AGENT_CONFIG = {
    "model": "claude-sonnet-4-20250514",
    "thinkingModel": "",
    "thinkingLevel": "off",
    "thinkingModelThinkingLevel": "off",
    "threadMode": "passive",
    "pulseEnabled": True,
    "pulseIntervalMinutes": 30,
    "pulseColumns": [],
    "pulseContainerTimeoutMs": 120000,
}

SAMPLE_AGENT_PROJECTS = [
    {
        "project_id": "proj_123",
        "agent_id": "reviewer",
        "role": "lead",
        "assigned_at": 1700000000000,
        "assigned_by": None,
        "project_name": "My Project",
        "project_status": "active",
        "project_description": "A test project",
    }
]

SAMPLE_VAULTS = [
    {"agent_id": "reviewer", "file_count": 5, "total_size_bytes": 10240},
    {"agent_id": "writer", "file_count": 2, "total_size_bytes": 4096},
]

SAMPLE_VAULT_FILES = [
    {
        "filename": "session-log.md",
        "directory": None,
        "category": "logs",
        "title": "Session Log",
        "created_at": 1700000000000,
        "size_bytes": 2048,
        "preview": "Session started at...",
    }
]

SAMPLE_VAULT_FILE = {
    "filename": "session-log.md",
    "content": "---\ntitle: Session Log\ncategory: logs\n---\nSession started at...",
    "metadata": {"title": "Session Log", "category": "logs"},
}

SAMPLE_SEARCH_RESULTS = [
    {
        "agent_id": "reviewer",
        "filename": "session-log.md",
        "snippet": "...found the bug in the authentication...",
        "score": 3,
    }
]

SAMPLE_STEP = {
    "id": "run_abc123def456_analyze",
    "step_id": "analyze",
    "agent_id": "reviewer",
    "status": "running",
    "outputs": {},
    "inputs": {"code": "def foo(): pass"},
    "error": None,
    "retry_count": 0,
    "max_retries": 3,
    "session_id": "sess_123",
    "started_at": 1700000010000,
    "completed_at": None,
    "human_context": None,
}

SAMPLE_STEP_LOGS = [
    {
        "type": "STEP_STARTED",
        "runId": "run_abc123def456",
        "stepId": "analyze",
        "agentId": "reviewer",
        "timestamp": 1700000010000,
    }
]

SAMPLE_RUN_STEPS = [
    {
        "id": "run_abc123def456_analyze",
        "run_id": "run_abc123def456",
        "step_id": "analyze",
        "agent_id": "reviewer",
        "status": "running",
        "session_id": "sess_123",
        "inputs": {"code": "def foo(): pass"},
        "outputs": {},
        "error": None,
        "retry_count": 0,
        "max_retries": 3,
        "started_at": 1700000010000,
        "completed_at": None,
        "human_context": None,
    },
    {
        "id": "run_abc123def456_report",
        "run_id": "run_abc123def456",
        "step_id": "report",
        "agent_id": "writer",
        "status": "pending",
        "session_id": None,
        "inputs": {},
        "outputs": {},
        "error": None,
        "retry_count": 0,
        "max_retries": 3,
        "started_at": None,
        "completed_at": None,
        "human_context": None,
    },
]

SAMPLE_RUN_OUTPUTS = {
    "analysis_result": "Code looks good with minor issues",
    "review_score": "8/10",
}


# ── Chat ────────────────────────────────────────────────────────────

SAMPLE_CHAT_START = {
    "sessionId": "chat_reviewer_1700000000000",
    "status": "starting",
    "message": "Chat session starting. Container will be ready shortly.",
}

SAMPLE_CHAT_STATUS_STARTING = {
    "sessionId": "chat_reviewer_1700000000000",
    "status": "starting",
    "exists": True,
    "messageCount": 0,
    "model": "anthropic/claude-sonnet-4",
    "containerId": None,
    "createdAt": 1700000000000,
    "lastActivityAt": 1700000000000,
}

SAMPLE_CHAT_STATUS_RUNNING = {
    "sessionId": "chat_reviewer_1700000000000",
    "status": "running",
    "exists": True,
    "messageCount": 2,
    "model": "anthropic/claude-sonnet-4",
    "containerId": "container_abc123",
    "createdAt": 1700000000000,
    "lastActivityAt": 1700000010000,
}

SAMPLE_CHAT_MESSAGE_SENT = {
    "status": "queued",
    "sessionId": "chat_reviewer_1700000000000",
    "userMessageId": "msg_user_123",
    "assistantMessageId": "msg_asst_456",
}

SAMPLE_CHAT_STOP_RESPONSE = {
    "status": "stopped",
    "sessionId": "chat_reviewer_1700000000000",
    "message": "Response generation stopped. Session is still active.",
}

SAMPLE_CHAT_END = {
    "status": "ended",
    "sessionId": "chat_reviewer_1700000000000",
    "message": "Chat session terminated.",
}

SAMPLE_CHAT_SESSIONS = {
    "sessions": [
        {
            "id": "chat_reviewer_1700000000000",
            "agent_id": "reviewer",
            "status": "running",
            "model": "anthropic/claude-sonnet-4",
            "container_id": "container_abc123",
            "created_at": 1700000000000,
            "started_at": 1700000001000,
            "last_activity_at": 1700000010000,
            "completed_at": None,
            "error": None,
            "message_count": 4,
        }
    ],
    "total": 1,
    "has_more": False,
}
