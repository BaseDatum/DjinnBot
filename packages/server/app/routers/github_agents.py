"""API endpoints for GitHub agent assignments."""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List
import json
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import Project, ProjectGitHubAgent, GitHubAgentTrigger
from app.utils import gen_id, now_ms

router = APIRouter()


# ── Pydantic Models ──────────────────────────────────────────────────────

class GitHubAgentAssignment(BaseModel):
    """Model for GitHub agent assignment."""
    agent_id: str
    event_type: str
    event_action: Optional[str] = None
    filter_labels: Optional[List[str]] = None
    filter_file_patterns: Optional[List[str]] = None
    filter_authors: Optional[List[str]] = None
    auto_respond: bool = False


class GitHubAgentAssignmentResponse(BaseModel):
    """Response model for agent assignment."""
    id: str
    project_id: str
    agent_id: str
    event_type: str
    event_action: Optional[str] = None
    filter_labels: Optional[List[str]] = None
    filter_file_patterns: Optional[List[str]] = None
    filter_authors: Optional[List[str]] = None
    auto_respond: bool
    created_at: int
    updated_at: int


# ── Helper Functions ──────────────────────────────────────────────────────

def parse_json_field(value: Optional[str]) -> Optional[List[str]]:
    """Parse JSON string field to list."""
    if value:
        return json.loads(value)
    return None


def serialize_json_field(value: Optional[List[str]]) -> Optional[str]:
    """Serialize list to JSON string."""
    if value:
        return json.dumps(value)
    return None


# ── API Endpoints ────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/github/assignments", response_model=GitHubAgentAssignmentResponse)
async def create_github_agent_assignment(
    project_id: str,
    assignment: GitHubAgentAssignment,
    session: AsyncSession = Depends(get_async_session)
):
    """Assign an agent to handle GitHub events for a project.
    
    Example:
    ```json
    {
        "agent_id": "bug-triager",
        "event_type": "issues",
        "event_action": "opened",
        "filter_labels": ["bug"],
        "auto_respond": true
    }
    ```
    """
    # Verify project exists
    result = await session.execute(
        select(Project).where(Project.id == project_id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")
    
    now = now_ms()
    
    new_assignment = ProjectGitHubAgent(
        id=gen_id("gha_"),
        project_id=project_id,
        agent_id=assignment.agent_id,
        event_type=assignment.event_type,
        event_action=assignment.event_action,
        filter_labels=serialize_json_field(assignment.filter_labels),
        filter_file_patterns=serialize_json_field(assignment.filter_file_patterns),
        filter_authors=serialize_json_field(assignment.filter_authors),
        auto_respond=1 if assignment.auto_respond else 0,
        created_at=now,
        updated_at=now,
    )
    session.add(new_assignment)
    await session.flush()
    
    return GitHubAgentAssignmentResponse(
        id=new_assignment.id,
        project_id=project_id,
        agent_id=assignment.agent_id,
        event_type=assignment.event_type,
        event_action=assignment.event_action,
        filter_labels=assignment.filter_labels,
        filter_file_patterns=assignment.filter_file_patterns,
        filter_authors=assignment.filter_authors,
        auto_respond=assignment.auto_respond,
        created_at=now,
        updated_at=now,
    )


@router.get("/projects/{project_id}/github/assignments")
async def list_github_agent_assignments(
    project_id: str,
    session: AsyncSession = Depends(get_async_session)
):
    """List all GitHub agent assignments for a project.
    
    Returns:
    ```json
    {
        "assignments": [...],
        "count": 3
    }
    ```
    """
    # Verify project exists
    result = await session.execute(
        select(Project).where(Project.id == project_id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")
    
    result = await session.execute(
        select(ProjectGitHubAgent)
        .where(ProjectGitHubAgent.project_id == project_id)
        .order_by(ProjectGitHubAgent.created_at.desc())
    )
    assignments = result.scalars().all()
    
    return {
        "assignments": [
            {
                "id": a.id,
                "project_id": a.project_id,
                "agent_id": a.agent_id,
                "event_type": a.event_type,
                "event_action": a.event_action,
                "filter_labels": parse_json_field(a.filter_labels),
                "filter_file_patterns": parse_json_field(a.filter_file_patterns),
                "filter_authors": parse_json_field(a.filter_authors),
                "auto_respond": bool(a.auto_respond),
                "created_at": a.created_at,
                "updated_at": a.updated_at,
            }
            for a in assignments
        ],
        "count": len(assignments),
    }


@router.get("/projects/{project_id}/github/assignments/{assignment_id}", response_model=GitHubAgentAssignmentResponse)
async def get_github_agent_assignment(
    project_id: str,
    assignment_id: str,
    session: AsyncSession = Depends(get_async_session)
):
    """Get a specific GitHub agent assignment."""
    result = await session.execute(
        select(ProjectGitHubAgent).where(
            ProjectGitHubAgent.id == assignment_id,
            ProjectGitHubAgent.project_id == project_id
        )
    )
    assignment = result.scalar_one_or_none()
    
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
    
    return GitHubAgentAssignmentResponse(
        id=assignment.id,
        project_id=assignment.project_id,
        agent_id=assignment.agent_id,
        event_type=assignment.event_type,
        event_action=assignment.event_action,
        filter_labels=parse_json_field(assignment.filter_labels),
        filter_file_patterns=parse_json_field(assignment.filter_file_patterns),
        filter_authors=parse_json_field(assignment.filter_authors),
        auto_respond=bool(assignment.auto_respond),
        created_at=assignment.created_at,
        updated_at=assignment.updated_at,
    )


@router.put("/projects/{project_id}/github/assignments/{assignment_id}", response_model=GitHubAgentAssignmentResponse)
async def update_github_agent_assignment(
    project_id: str,
    assignment_id: str,
    assignment: GitHubAgentAssignment,
    session: AsyncSession = Depends(get_async_session)
):
    """Update a GitHub agent assignment."""
    result = await session.execute(
        select(ProjectGitHubAgent).where(
            ProjectGitHubAgent.id == assignment_id,
            ProjectGitHubAgent.project_id == project_id
        )
    )
    existing = result.scalar_one_or_none()
    
    if not existing:
        raise HTTPException(status_code=404, detail="Assignment not found")
    
    now = now_ms()
    
    existing.agent_id = assignment.agent_id
    existing.event_type = assignment.event_type
    existing.event_action = assignment.event_action
    existing.filter_labels = serialize_json_field(assignment.filter_labels)
    existing.filter_file_patterns = serialize_json_field(assignment.filter_file_patterns)
    existing.filter_authors = serialize_json_field(assignment.filter_authors)
    existing.auto_respond = 1 if assignment.auto_respond else 0
    existing.updated_at = now
    
    return GitHubAgentAssignmentResponse(
        id=existing.id,
        project_id=project_id,
        agent_id=assignment.agent_id,
        event_type=assignment.event_type,
        event_action=assignment.event_action,
        filter_labels=assignment.filter_labels,
        filter_file_patterns=assignment.filter_file_patterns,
        filter_authors=assignment.filter_authors,
        auto_respond=assignment.auto_respond,
        created_at=existing.created_at,
        updated_at=now,
    )


@router.delete("/projects/{project_id}/github/assignments/{assignment_id}")
async def delete_github_agent_assignment(
    project_id: str,
    assignment_id: str,
    session: AsyncSession = Depends(get_async_session)
):
    """Remove a GitHub agent assignment."""
    result = await session.execute(
        select(ProjectGitHubAgent).where(
            ProjectGitHubAgent.id == assignment_id,
            ProjectGitHubAgent.project_id == project_id
        )
    )
    assignment = result.scalar_one_or_none()
    
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
    
    await session.delete(assignment)
    
    return {"status": "deleted", "id": assignment_id}


@router.get("/projects/{project_id}/github/triggers")
async def list_github_agent_triggers(
    project_id: str,
    status: Optional[str] = None,
    agent_id: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    session: AsyncSession = Depends(get_async_session)
):
    """List GitHub agent triggers (audit log) for a project.
    
    Query params:
    - status: Filter by status (pending, running, completed, failed)
    - agent_id: Filter by agent
    - limit: Max results (default: 50)
    - offset: Pagination offset
    
    Returns:
    ```json
    {
        "triggers": [...],
        "count": 10
    }
    ```
    """
    # Verify project exists
    result = await session.execute(
        select(Project).where(Project.id == project_id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")
    
    query = select(GitHubAgentTrigger).where(
        GitHubAgentTrigger.project_id == project_id
    )
    
    if status:
        query = query.where(GitHubAgentTrigger.status == status)
    if agent_id:
        query = query.where(GitHubAgentTrigger.agent_id == agent_id)
    
    query = query.order_by(GitHubAgentTrigger.triggered_at.desc()).limit(limit).offset(offset)
    
    result = await session.execute(query)
    triggers = result.scalars().all()
    
    return {
        "triggers": [
            {
                "id": t.id,
                "agent_assignment_id": t.agent_assignment_id,
                "webhook_event_id": t.webhook_event_id,
                "project_id": t.project_id,
                "agent_id": t.agent_id,
                "event_type": t.event_type,
                "event_action": t.event_action,
                "repository_full_name": t.repository_full_name,
                "trigger_reason": t.trigger_reason,
                "task_id": t.task_id,
                "session_id": t.session_id,
                "status": t.status,
                "triggered_at": t.triggered_at,
                "completed_at": t.completed_at,
            }
            for t in triggers
        ],
        "count": len(triggers),
        "limit": limit,
        "offset": offset,
    }


@router.get("/projects/{project_id}/github/triggers/{trigger_id}")
async def get_github_agent_trigger(
    project_id: str,
    trigger_id: str,
    session: AsyncSession = Depends(get_async_session)
):
    """Get details of a specific GitHub agent trigger."""
    result = await session.execute(
        select(GitHubAgentTrigger).where(
            GitHubAgentTrigger.id == trigger_id,
            GitHubAgentTrigger.project_id == project_id
        )
    )
    trigger = result.scalar_one_or_none()
    
    if not trigger:
        raise HTTPException(status_code=404, detail="Trigger not found")
    
    return {
        "id": trigger.id,
        "agent_assignment_id": trigger.agent_assignment_id,
        "webhook_event_id": trigger.webhook_event_id,
        "project_id": trigger.project_id,
        "agent_id": trigger.agent_id,
        "event_type": trigger.event_type,
        "event_action": trigger.event_action,
        "repository_full_name": trigger.repository_full_name,
        "trigger_reason": trigger.trigger_reason,
        "task_id": trigger.task_id,
        "session_id": trigger.session_id,
        "status": trigger.status,
        "triggered_at": trigger.triggered_at,
        "completed_at": trigger.completed_at,
    }
