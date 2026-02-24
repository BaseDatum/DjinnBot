"""Project template CRUD and built-in template seeding.

Endpoints:
- GET    /v1/project-templates              - List all templates
- POST   /v1/project-templates              - Create custom template
- GET    /v1/project-templates/{id}         - Get template
- PUT    /v1/project-templates/{id}         - Update template
- DELETE /v1/project-templates/{id}         - Delete template (custom only)
- POST   /v1/project-templates/{id}/clone   - Clone template
- POST   /v1/project-templates/seed         - Seed built-in templates (startup)
"""

import json
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select, update, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.project_template import ProjectTemplate
from app.models.base import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ============================================================================
# Built-in Template Definitions
# ============================================================================

# The legacy hardcoded semantics — used as fallback for projects without
# explicit status_semantics, and as the default for the software-dev template.
LEGACY_STATUS_SEMANTICS = {
    "initial": ["backlog"],
    "terminal_done": ["done"],
    "terminal_fail": ["failed"],
    "blocked": ["blocked"],
    "in_progress": ["in_progress"],
    "claimable": ["backlog", "planning", "planned", "ux", "ready", "test", "failed"],
}


BUILTIN_TEMPLATES = [
    {
        "slug": "software-dev",
        "name": "Software Development",
        "description": "Full software development workflow with planning, UX, implementation, review, and testing stages. Includes git integration and agent-guided onboarding.",
        "icon": "💻",
        "columns": [
            {
                "name": "Backlog",
                "position": 0,
                "wip_limit": None,
                "statuses": ["backlog"],
            },
            {
                "name": "Planning",
                "position": 1,
                "wip_limit": None,
                "statuses": ["planning"],
            },
            {
                "name": "Planned",
                "position": 2,
                "wip_limit": None,
                "statuses": ["planned"],
            },
            {"name": "UX", "position": 3, "wip_limit": None, "statuses": ["ux"]},
            {
                "name": "Blocked",
                "position": 4,
                "wip_limit": None,
                "statuses": ["blocked"],
            },
            {"name": "Ready", "position": 5, "wip_limit": None, "statuses": ["ready"]},
            {
                "name": "In Progress",
                "position": 6,
                "wip_limit": 5,
                "statuses": ["in_progress"],
            },
            {
                "name": "Review",
                "position": 7,
                "wip_limit": None,
                "statuses": ["review"],
            },
            {"name": "Test", "position": 8, "wip_limit": None, "statuses": ["test"]},
            {"name": "Done", "position": 9, "wip_limit": None, "statuses": ["done"]},
            {
                "name": "Failed",
                "position": 10,
                "wip_limit": None,
                "statuses": ["failed"],
            },
        ],
        "status_semantics": LEGACY_STATUS_SEMANTICS,
        "default_pipeline_id": "engineering",
        "onboarding_agent_chain": ["stas", "jim", "eric", "finn"],
        "metadata": {
            "git_integration": True,
            "review_stages": ["spec", "quality"],
        },
        "sort_order": 0,
    },
    {
        "slug": "kanban-simple",
        "name": "Simple Kanban",
        "description": "A minimal kanban board with To Do, In Progress, and Done columns. No git integration or specialized agents required.",
        "icon": "📋",
        "columns": [
            {"name": "To Do", "position": 0, "wip_limit": None, "statuses": ["todo"]},
            {
                "name": "In Progress",
                "position": 1,
                "wip_limit": 5,
                "statuses": ["in_progress"],
            },
            {"name": "Done", "position": 2, "wip_limit": None, "statuses": ["done"]},
        ],
        "status_semantics": {
            "initial": ["todo"],
            "terminal_done": ["done"],
            "terminal_fail": [],
            "blocked": [],
            "in_progress": ["in_progress"],
            "claimable": ["todo"],
        },
        "default_pipeline_id": None,
        "onboarding_agent_chain": None,
        "metadata": {
            "git_integration": False,
        },
        "sort_order": 1,
    },
    {
        "slug": "content-pipeline",
        "name": "Content Pipeline",
        "description": "Workflow for content creation: ideation, drafting, editing, review, and publishing.",
        "icon": "📝",
        "columns": [
            {"name": "Ideas", "position": 0, "wip_limit": None, "statuses": ["idea"]},
            {
                "name": "Drafting",
                "position": 1,
                "wip_limit": 3,
                "statuses": ["drafting"],
            },
            {
                "name": "Editing",
                "position": 2,
                "wip_limit": None,
                "statuses": ["editing"],
            },
            {
                "name": "Review",
                "position": 3,
                "wip_limit": None,
                "statuses": ["review"],
            },
            {
                "name": "Published",
                "position": 4,
                "wip_limit": None,
                "statuses": ["published"],
            },
            {
                "name": "Archived",
                "position": 5,
                "wip_limit": None,
                "statuses": ["archived"],
            },
        ],
        "status_semantics": {
            "initial": ["idea"],
            "terminal_done": ["published"],
            "terminal_fail": ["archived"],
            "blocked": [],
            "in_progress": ["drafting", "editing"],
            "claimable": ["idea", "review"],
        },
        "default_pipeline_id": None,
        "onboarding_agent_chain": None,
        "metadata": {
            "git_integration": False,
        },
        "sort_order": 2,
    },
    {
        "slug": "research",
        "name": "Research & Analysis",
        "description": "Research workflow: questions, investigation, synthesis, and findings.",
        "icon": "🔬",
        "columns": [
            {
                "name": "Questions",
                "position": 0,
                "wip_limit": None,
                "statuses": ["question"],
            },
            {
                "name": "Investigating",
                "position": 1,
                "wip_limit": 3,
                "statuses": ["investigating"],
            },
            {
                "name": "Synthesizing",
                "position": 2,
                "wip_limit": None,
                "statuses": ["synthesizing"],
            },
            {
                "name": "Findings",
                "position": 3,
                "wip_limit": None,
                "statuses": ["findings"],
            },
            {
                "name": "Parked",
                "position": 4,
                "wip_limit": None,
                "statuses": ["parked"],
            },
        ],
        "status_semantics": {
            "initial": ["question"],
            "terminal_done": ["findings"],
            "terminal_fail": ["parked"],
            "blocked": [],
            "in_progress": ["investigating", "synthesizing"],
            "claimable": ["question"],
        },
        "default_pipeline_id": None,
        "onboarding_agent_chain": None,
        "metadata": {
            "git_integration": False,
        },
        "sort_order": 3,
    },
]


# ============================================================================
# Pydantic Request / Response Models
# ============================================================================


class ColumnDefinition(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    position: int = Field(..., ge=0)
    wip_limit: Optional[int] = Field(None, ge=1)
    statuses: List[str] = Field(..., min_length=1)


class StatusSemantics(BaseModel):
    initial: List[str] = Field(default_factory=lambda: ["backlog"])
    terminal_done: List[str] = Field(default_factory=lambda: ["done"])
    terminal_fail: List[str] = Field(default_factory=list)
    blocked: List[str] = Field(default_factory=list)
    in_progress: List[str] = Field(default_factory=list)
    claimable: List[str] = Field(default_factory=list)


class CreateTemplateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    slug: str = Field(
        ..., min_length=1, max_length=128, pattern=r"^[a-z0-9][a-z0-9-]*$"
    )
    description: str = ""
    icon: Optional[str] = None
    columns: List[ColumnDefinition]
    statusSemantics: StatusSemantics
    defaultPipelineId: Optional[str] = None
    onboardingAgentChain: Optional[List[str]] = None
    metadata: dict = {}


class UpdateTemplateRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=256)
    description: Optional[str] = None
    icon: Optional[str] = None
    columns: Optional[List[ColumnDefinition]] = None
    statusSemantics: Optional[StatusSemantics] = None
    defaultPipelineId: Optional[str] = None
    onboardingAgentChain: Optional[List[str]] = None
    metadata: Optional[dict] = None


def _serialize_template(t: ProjectTemplate) -> dict:
    return {
        "id": t.id,
        "slug": t.slug,
        "name": t.name,
        "description": t.description,
        "icon": t.icon,
        "isBuiltin": t.is_builtin,
        "columns": t.board_columns,
        "statusSemantics": t.status_semantics,
        "defaultPipelineId": t.default_pipeline_id,
        "onboardingAgentChain": t.onboarding_agent_chain,
        "metadata": t.template_metadata,
        "sortOrder": t.sort_order,
        "createdAt": t.created_at,
        "updatedAt": t.updated_at,
    }


# ============================================================================
# Seeding
# ============================================================================


async def seed_builtin_templates(db: Optional[AsyncSession] = None):
    """Seed built-in templates. Idempotent — skips if slug already exists.

    Called at server startup and via POST /v1/project-templates/seed.
    """
    close_session = False
    if db is None:
        from app.database import AsyncSessionLocal

        db = AsyncSessionLocal()
        close_session = True

    try:
        created = []
        for tmpl_def in BUILTIN_TEMPLATES:
            existing = await db.execute(
                select(ProjectTemplate).where(ProjectTemplate.slug == tmpl_def["slug"])
            )
            if existing.scalar_one_or_none():
                continue

            ts = now_ms()
            tmpl = ProjectTemplate(
                id=ProjectTemplate.generate_id(),
                slug=tmpl_def["slug"],
                name=tmpl_def["name"],
                description=tmpl_def["description"],
                icon=tmpl_def.get("icon"),
                is_builtin=True,
                board_columns=tmpl_def["columns"],
                status_semantics=tmpl_def["status_semantics"],
                default_pipeline_id=tmpl_def.get("default_pipeline_id"),
                onboarding_agent_chain=tmpl_def.get("onboarding_agent_chain"),
                template_metadata=tmpl_def.get("metadata", {}),
                sort_order=tmpl_def.get("sort_order", 0),
                created_at=ts,
                updated_at=ts,
            )
            db.add(tmpl)
            created.append(tmpl_def["slug"])

        if created:
            await db.commit()
            logger.info(f"Seeded built-in templates: {', '.join(created)}")

        return {"seeded": created}
    finally:
        if close_session:
            await db.close()


# ============================================================================
# Helper: resolve status semantics for a project
# ============================================================================


def get_project_status_semantics(project) -> dict:
    """Get the status semantics for a project.

    Returns the project's own status_semantics if set, otherwise
    falls back to the legacy hardcoded semantics.
    """
    if project.status_semantics:
        return project.status_semantics
    return LEGACY_STATUS_SEMANTICS


def get_all_valid_statuses_for_project(project) -> set[str]:
    """Get all valid task statuses for a project by reading its columns.

    Falls back to checking status_semantics if columns aren't loaded.
    """
    # If columns are loaded on the ORM object, extract statuses from them
    try:
        all_statuses = set()
        for col in project.columns:
            statuses_json = (
                col.task_statuses
                if isinstance(col.task_statuses, list)
                else json.loads(col.task_statuses or "[]")
            )
            all_statuses.update(statuses_json)
        if all_statuses:
            return all_statuses
    except Exception:
        pass

    # Fallback: collect from status_semantics
    semantics = get_project_status_semantics(project)
    all_statuses = set()
    for status_list in semantics.values():
        if isinstance(status_list, list):
            all_statuses.update(status_list)
    return all_statuses


# ============================================================================
# Endpoints
# ============================================================================


@router.get("/")
async def list_templates(db: AsyncSession = Depends(get_async_session)):
    """List all project templates, ordered by sort_order."""
    result = await db.execute(
        select(ProjectTemplate).order_by(
            ProjectTemplate.sort_order, ProjectTemplate.created_at
        )
    )
    templates = result.scalars().all()
    return {"templates": [_serialize_template(t) for t in templates]}


@router.get("/{template_id}")
async def get_template(
    template_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Get a single project template by ID or slug."""
    # Try by ID first
    result = await db.execute(
        select(ProjectTemplate).where(ProjectTemplate.id == template_id)
    )
    tmpl = result.scalar_one_or_none()
    if not tmpl:
        # Try by slug
        result = await db.execute(
            select(ProjectTemplate).where(ProjectTemplate.slug == template_id)
        )
        tmpl = result.scalar_one_or_none()
    if not tmpl:
        raise HTTPException(
            status_code=404, detail=f"Template '{template_id}' not found"
        )
    return _serialize_template(tmpl)


@router.post("/", status_code=201)
async def create_template(
    req: CreateTemplateRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Create a custom project template."""
    # Check slug uniqueness
    existing = await db.execute(
        select(ProjectTemplate).where(ProjectTemplate.slug == req.slug)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail=f"Template with slug '{req.slug}' already exists",
        )

    # Validate that all semantic statuses exist in columns
    all_column_statuses = set()
    for col in req.columns:
        all_column_statuses.update(col.statuses)

    semantics_dict = req.statusSemantics.model_dump()
    for key, status_list in semantics_dict.items():
        for status in status_list:
            if status not in all_column_statuses:
                raise HTTPException(
                    status_code=400,
                    detail=f"Status '{status}' in semantics.{key} not found in any column definition",
                )

    max_order = await db.execute(select(func.max(ProjectTemplate.sort_order)))
    next_order = (max_order.scalar() or 0) + 1

    ts = now_ms()
    tmpl = ProjectTemplate(
        id=ProjectTemplate.generate_id(),
        slug=req.slug,
        name=req.name,
        description=req.description,
        icon=req.icon,
        is_builtin=False,
        board_columns=[c.model_dump() for c in req.columns],
        status_semantics=semantics_dict,
        default_pipeline_id=req.defaultPipelineId,
        onboarding_agent_chain=req.onboardingAgentChain,
        template_metadata=req.metadata,
        sort_order=next_order,
        created_at=ts,
        updated_at=ts,
    )
    db.add(tmpl)
    await db.commit()
    await db.refresh(tmpl)

    return _serialize_template(tmpl)


@router.put("/{template_id}")
async def update_template(
    template_id: str,
    req: UpdateTemplateRequest,
    db: AsyncSession = Depends(get_async_session),
):
    """Update a project template. Built-in templates can be customized."""
    result = await db.execute(
        select(ProjectTemplate).where(ProjectTemplate.id == template_id)
    )
    tmpl = result.scalar_one_or_none()
    if not tmpl:
        raise HTTPException(status_code=404, detail="Template not found")

    update_fields = {}
    if req.name is not None:
        update_fields["name"] = req.name
    if req.description is not None:
        update_fields["description"] = req.description
    if req.icon is not None:
        update_fields["icon"] = req.icon
    if req.columns is not None:
        update_fields["board_columns"] = [c.model_dump() for c in req.columns]
    if req.statusSemantics is not None:
        update_fields["status_semantics"] = req.statusSemantics.model_dump()
    if req.defaultPipelineId is not None:
        update_fields["default_pipeline_id"] = req.defaultPipelineId or None
    if req.onboardingAgentChain is not None:
        update_fields["onboarding_agent_chain"] = req.onboardingAgentChain or None
    if req.metadata is not None:
        update_fields["template_metadata"] = req.metadata

    if update_fields:
        update_fields["updated_at"] = now_ms()
        await db.execute(
            update(ProjectTemplate)
            .where(ProjectTemplate.id == template_id)
            .values(**update_fields)
        )
        await db.commit()
        await db.refresh(tmpl)

    return _serialize_template(tmpl)


@router.delete("/{template_id}")
async def delete_template(
    template_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Delete a custom template. Built-in templates cannot be deleted."""
    result = await db.execute(
        select(ProjectTemplate).where(ProjectTemplate.id == template_id)
    )
    tmpl = result.scalar_one_or_none()
    if not tmpl:
        raise HTTPException(status_code=404, detail="Template not found")

    if tmpl.is_builtin:
        raise HTTPException(
            status_code=403,
            detail="Cannot delete built-in templates. You can customize them instead.",
        )

    await db.execute(delete(ProjectTemplate).where(ProjectTemplate.id == template_id))
    await db.commit()
    return {"status": "deleted", "id": template_id}


@router.post("/{template_id}/clone")
async def clone_template(
    template_id: str,
    db: AsyncSession = Depends(get_async_session),
):
    """Clone a template into a new custom template."""
    result = await db.execute(
        select(ProjectTemplate).where(ProjectTemplate.id == template_id)
    )
    source = result.scalar_one_or_none()
    if not source:
        raise HTTPException(status_code=404, detail="Template not found")

    # Generate unique slug
    base_slug = f"{source.slug}-copy"
    slug = base_slug
    counter = 2
    while True:
        dup = await db.execute(
            select(ProjectTemplate).where(ProjectTemplate.slug == slug)
        )
        if not dup.scalar_one_or_none():
            break
        slug = f"{base_slug}-{counter}"
        counter += 1

    max_order = await db.execute(select(func.max(ProjectTemplate.sort_order)))
    next_order = (max_order.scalar() or 0) + 1

    ts = now_ms()
    clone = ProjectTemplate(
        id=ProjectTemplate.generate_id(),
        slug=slug,
        name=f"{source.name} (Copy)",
        description=source.description,
        icon=source.icon,
        is_builtin=False,
        board_columns=source.board_columns,
        status_semantics=source.status_semantics,
        default_pipeline_id=source.default_pipeline_id,
        onboarding_agent_chain=source.onboarding_agent_chain,
        template_metadata=source.template_metadata,
        sort_order=next_order,
        created_at=ts,
        updated_at=ts,
    )
    db.add(clone)
    await db.commit()
    await db.refresh(clone)

    return _serialize_template(clone)


@router.post("/seed")
async def seed_templates(db: AsyncSession = Depends(get_async_session)):
    """Seed built-in templates. Idempotent."""
    result = await seed_builtin_templates(db)
    return result
