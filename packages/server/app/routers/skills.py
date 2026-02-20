"""
Skills API — V2, DB-backed with explicit per-agent access control.

Endpoints:

  Skill library (admin / UI):
    GET    /v1/skills/                       list all skills
    POST   /v1/skills/                       create skill
    GET    /v1/skills/{skill_id}             get skill
    PUT    /v1/skills/{skill_id}             update skill
    DELETE /v1/skills/{skill_id}             delete skill
    PATCH  /v1/skills/{skill_id}/enabled     toggle global enabled flag

  Agent access control:
    GET    /v1/skills/agents/{agent_id}            skills granted to agent
    GET    /v1/skills/agents/{agent_id}/manifest   compact manifest for system prompt
    POST   /v1/skills/agents/{agent_id}/{skill_id}/grant   grant access
    DELETE /v1/skills/agents/{agent_id}/{skill_id}         revoke access
    GET    /v1/skills/agents/{agent_id}/{skill_id}/content gated content load

  Skill generation helpers (unchanged from V1):
    POST   /v1/skills/generate/session
    POST   /v1/skills/parse
    POST   /v1/skills/github-import
    POST   /v1/skills/extract
"""

import json
import os
import re
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession
import httpx

from app.database import get_async_session
from app.models.skill import Skill, AgentSkill
from app.utils import now_ms

router = APIRouter()


# ── Pydantic models ────────────────────────────────────────────────────────────


class SkillResponse(BaseModel):
    id: str
    description: str
    tags: list[str]
    content: str
    enabled: bool
    scope: str  # 'global' | 'agent'
    owner_agent_id: Optional[str] = None
    created_by: str
    created_at: int
    updated_at: int


class SkillGrantResponse(BaseModel):
    """Minimal response for the grant list / manifest endpoints."""

    id: str
    description: str
    tags: list[str]
    enabled: bool
    scope: str
    owner_agent_id: Optional[str] = None
    granted_by: str
    granted_at: int


class ManifestEntry(BaseModel):
    id: str
    description: str
    tags: list[str]


class ManifestResponse(BaseModel):
    skills: list[ManifestEntry]
    manifest_text: str  # pre-built # SKILLS block ready to inject


class CreateSkillRequest(BaseModel):
    name: str
    description: str
    tags: list[str] = []
    content: str
    enabled: bool = True
    scope: str = "global"
    owner_agent_id: Optional[str] = None


class UpdateSkillRequest(BaseModel):
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    content: Optional[str] = None
    enabled: Optional[bool] = None


class GrantSkillRequest(BaseModel):
    granted_by: str = "ui"


# ── Helpers ────────────────────────────────────────────────────────────────────


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9-]", "-", name.lower().strip())[:64]


def _row_to_response(skill: Skill) -> SkillResponse:
    return SkillResponse(
        id=skill.id,
        description=skill.description,
        tags=json.loads(skill.tags) if skill.tags else [],
        content=skill.content,
        enabled=skill.enabled,
        scope=skill.scope,
        owner_agent_id=skill.owner_agent_id,
        created_by=skill.created_by,
        created_at=skill.created_at,
        updated_at=skill.updated_at,
    )


def _build_manifest_text(skills: list[ManifestEntry]) -> str:
    if not skills:
        return ""
    lines = [f"- **{s.id}**: {s.description}" for s in skills]
    return "\n".join(
        [
            "# SKILLS",
            "",
            'You have specialized skills available. Call `load_skill("name")` to load full',
            "instructions for a skill when you need it. Skills are loaded on demand.",
            "",
            *lines,
        ]
    )


# ── Skill library CRUD ────────────────────────────────────────────────────────


@router.get("/")
async def list_skills(
    db: AsyncSession = Depends(get_async_session),
) -> list[SkillResponse]:
    """List all skills in the library (admin/dashboard view)."""
    result = await db.execute(select(Skill).order_by(Skill.id))
    return [_row_to_response(s) for s in result.scalars().all()]


@router.post("/")
async def create_skill(
    req: CreateSkillRequest,
    db: AsyncSession = Depends(get_async_session),
    created_by: str = "ui",
) -> SkillResponse:
    """Create a new skill in the library."""
    skill_id = _slug(req.name)
    existing = await db.get(Skill, skill_id)
    if existing:
        raise HTTPException(
            status_code=409, detail=f"Skill '{skill_id}' already exists"
        )

    now = now_ms()
    skill = Skill(
        id=skill_id,
        description=req.description,
        tags=json.dumps(req.tags),
        content=req.content,
        enabled=req.enabled,
        scope=req.scope,
        owner_agent_id=req.owner_agent_id,
        created_by=created_by,
        created_at=now,
        updated_at=now,
    )
    db.add(skill)
    await db.flush()
    await db.refresh(skill)
    return _row_to_response(skill)


@router.get("/{skill_id}")
async def get_skill(
    skill_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> SkillResponse:
    """Get a single skill by ID."""
    skill = await db.get(Skill, _slug(skill_id))
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")
    return _row_to_response(skill)


@router.put("/{skill_id}")
async def update_skill(
    skill_id: str,
    req: UpdateSkillRequest,
    db: AsyncSession = Depends(get_async_session),
) -> SkillResponse:
    """Update a skill. Only provided fields are changed."""
    skill = await db.get(Skill, _slug(skill_id))
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")

    if req.description is not None:
        skill.description = req.description
    if req.tags is not None:
        skill.tags = json.dumps(req.tags)
    if req.content is not None:
        skill.content = req.content
    if req.enabled is not None:
        skill.enabled = req.enabled
    skill.updated_at = now_ms()

    await db.flush()
    await db.refresh(skill)
    return _row_to_response(skill)


@router.delete("/{skill_id}")
async def delete_skill(
    skill_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> dict:
    """Delete a skill and all its grants."""
    skill = await db.get(Skill, _slug(skill_id))
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")
    await db.delete(skill)
    return {"deleted": skill_id}


@router.patch("/{skill_id}/enabled")
async def set_skill_enabled(
    skill_id: str,
    enabled: bool,
    db: AsyncSession = Depends(get_async_session),
) -> SkillResponse:
    """Toggle the global enabled flag on a skill."""
    return await update_skill(skill_id, UpdateSkillRequest(enabled=enabled), db)


# ── Agent access control ──────────────────────────────────────────────────────


@router.get("/agents/{agent_id}")
async def list_agent_skills(
    agent_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> list[SkillGrantResponse]:
    """Return all skills granted to an agent (granted=True only)."""
    result = await db.execute(
        select(AgentSkill, Skill)
        .join(Skill, AgentSkill.skill_id == Skill.id)
        .where(AgentSkill.agent_id == agent_id, AgentSkill.granted == True)
        .order_by(Skill.id)
    )
    rows = result.all()
    return [
        SkillGrantResponse(
            id=skill.id,
            description=skill.description,
            tags=json.loads(skill.tags) if skill.tags else [],
            enabled=skill.enabled,
            scope=skill.scope,
            owner_agent_id=skill.owner_agent_id,
            granted_by=grant.granted_by,
            granted_at=grant.granted_at,
        )
        for grant, skill in rows
    ]


@router.get("/agents/{agent_id}/manifest")
async def get_agent_manifest(
    agent_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> ManifestResponse:
    """
    Return the compact skills manifest for an agent's system prompt.

    Only includes skills that are:
      - granted to this agent (granted=True in agent_skills)
      - globally enabled (skill.enabled=True)

    Agent-owned skills with the same id take precedence over global ones
    (they shadow them — only the agent-owned version appears).
    """
    result = await db.execute(
        select(AgentSkill, Skill)
        .join(Skill, AgentSkill.skill_id == Skill.id)
        .where(
            AgentSkill.agent_id == agent_id,
            AgentSkill.granted == True,
            Skill.enabled == True,
        )
        .order_by(
            # Agent-owned skills sort before global ones so precedence is clear
            Skill.scope.desc(),  # 'global' < 'agent' alphabetically → agent first
            Skill.id,
        )
    )
    rows = result.all()

    # Deduplicate by id: first-seen wins (agent-owned already sorted first)
    seen: set[str] = set()
    entries: list[ManifestEntry] = []
    for _grant, skill in rows:
        if skill.id not in seen:
            seen.add(skill.id)
            entries.append(
                ManifestEntry(
                    id=skill.id,
                    description=skill.description,
                    tags=json.loads(skill.tags) if skill.tags else [],
                )
            )

    return ManifestResponse(
        skills=entries,
        manifest_text=_build_manifest_text(entries),
    )


@router.post("/agents/{agent_id}/{skill_id}/grant")
async def grant_skill_to_agent(
    agent_id: str,
    skill_id: str,
    req: GrantSkillRequest = GrantSkillRequest(),
    db: AsyncSession = Depends(get_async_session),
) -> SkillGrantResponse:
    """Grant an agent access to a skill. Idempotent — re-grants if previously revoked."""
    sid = _slug(skill_id)
    skill = await db.get(Skill, sid)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{sid}' not found")

    # Upsert: update if exists, insert if not
    result = await db.execute(
        select(AgentSkill).where(
            AgentSkill.agent_id == agent_id,
            AgentSkill.skill_id == sid,
        )
    )
    existing_grant = result.scalar_one_or_none()

    now = now_ms()
    if existing_grant:
        existing_grant.granted = True
        existing_grant.granted_at = now
        existing_grant.granted_by = req.granted_by
    else:
        existing_grant = AgentSkill(
            agent_id=agent_id,
            skill_id=sid,
            granted=True,
            granted_at=now,
            granted_by=req.granted_by,
        )
        db.add(existing_grant)

    await db.flush()
    return SkillGrantResponse(
        id=skill.id,
        description=skill.description,
        tags=json.loads(skill.tags) if skill.tags else [],
        enabled=skill.enabled,
        scope=skill.scope,
        owner_agent_id=skill.owner_agent_id,
        granted_by=existing_grant.granted_by,
        granted_at=existing_grant.granted_at,
    )


@router.delete("/agents/{agent_id}/{skill_id}")
async def revoke_skill_from_agent(
    agent_id: str,
    skill_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> dict:
    """Revoke an agent's access to a skill (hard delete of the grant row)."""
    sid = _slug(skill_id)
    await db.execute(
        delete(AgentSkill).where(
            AgentSkill.agent_id == agent_id,
            AgentSkill.skill_id == sid,
        )
    )
    return {"revoked": sid, "agent_id": agent_id}


@router.get("/agents/{agent_id}/{skill_id}/content")
async def get_skill_content_for_agent(
    agent_id: str,
    skill_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> dict:
    """
    Gated content endpoint used by the agent load_skill tool.

    Returns 403 if the agent has no active grant.
    Returns 404 if the skill doesn't exist.
    Returns 503 if the skill is globally disabled.
    """
    sid = _slug(skill_id)
    skill = await db.get(Skill, sid)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{sid}' not found")

    if not skill.enabled:
        raise HTTPException(
            status_code=503, detail=f"Skill '{sid}' is currently disabled"
        )

    result = await db.execute(
        select(AgentSkill).where(
            AgentSkill.agent_id == agent_id,
            AgentSkill.skill_id == sid,
            AgentSkill.granted == True,
        )
    )
    grant = result.scalar_one_or_none()
    if not grant:
        raise HTTPException(
            status_code=403,
            detail=f"Agent '{agent_id}' does not have access to skill '{sid}'",
        )

    return {
        "id": skill.id,
        "description": skill.description,
        "content": skill.content,
        "tags": json.loads(skill.tags) if skill.tags else [],
    }


# ── Skill generation helpers (unchanged logic from V1) ────────────────────────

SKILL_SMITH_SYSTEM_PROMPT = """You are a Skill Smith — a specialist agent whose sole job is to write high-quality Djinnbot skill files.

A Djinnbot skill is a SKILL.md file with YAML frontmatter followed by dense, instructional markdown. Skills are injected into agent system prompts to teach agents specific capabilities. Good skills are the difference between an agent that flails and one that executes with precision.

## Your job
When the user asks you to create a skill — whether from a URL, a description, a GitHub repo, or raw instructions — you must:

1. **Research thoroughly** before writing. Use your browser and fetch tools to read the actual documentation, API references, GitHub repos, or source code. Do not hallucinate. Read primary sources.
2. **Produce one final SKILL.md** as your terminal output. This must be a complete, valid skill file.
3. **Confirm with the user** before finalizing — share a draft, accept feedback, then output the final version.

## SKILL.md format
The file must begin with YAML frontmatter delimited by `---`:

```
---
name: lowercase-kebab-case-slug
description: One sentence stating WHEN the agent should invoke this skill
tags: [keyword1, keyword2, keyword3]
enabled: true
---
```

Rules:
- `name`: lowercase kebab-case, max 40 chars (e.g. `stripe-refunds`, `github-pr-review`)
- `description`: starts with "Use when..." or a clear condition. One sentence only.
- `tags`: 3–8 lowercase keywords for pipeline keyword matching
- `enabled: true` always

## Content rules
- Dense, actionable markdown — no marketing copy, no filler prose
- Headers, numbered steps, code blocks where they clarify
- Include: purpose, when to use, prerequisites, step-by-step instructions, key API shapes/parameters, common pitfalls
- For API references: include endpoint patterns, required headers, auth approach, request/response shapes with examples
- For GitHub repos: read the README, source, and examples before writing
- Strip all navigation text, footers, disclaimers, promotional content
- Keep under 600 lines total
- If something is unclear or missing, ask — do not guess

## Final output
When you are ready to deliver the final skill, output it as a raw markdown code block labeled `skill-output`:

```skill-output
---
name: example-skill
...
---

# Example Skill
...
```

The system will extract this block and present it to the user for review before saving.
"""

_URL_FETCH_TIMEOUT = 20.0
_MAX_URL_CONTENT_CHARS = 60_000


def _parse_frontmatter(raw: str) -> tuple[dict, str]:
    match = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?(.*)", raw, re.DOTALL)
    if not match:
        return {}, raw.strip()

    fm_raw, body = match.group(1), match.group(2).strip()
    fm: dict = {}

    for line in fm_raw.split("\n"):
        colon_idx = line.find(":")
        if colon_idx == -1:
            continue
        key = line[:colon_idx].strip()
        val_raw = line[colon_idx + 1 :].strip()

        if val_raw.startswith("[") and val_raw.endswith("]"):
            fm[key] = [
                v.strip().strip("'\"") for v in val_raw[1:-1].split(",") if v.strip()
            ]
        elif val_raw.lower() == "true":
            fm[key] = True
        elif val_raw.lower() == "false":
            fm[key] = False
        else:
            fm[key] = val_raw.strip("'\"")

    return fm, body


def _validate_skill_markdown(raw: str) -> tuple[bool, str, dict]:
    fm, body = _parse_frontmatter(raw)
    if not fm:
        return False, "No YAML frontmatter found (must start with ---)", {}
    if not fm.get("name"):
        return False, "Frontmatter missing required field: name", fm
    if not fm.get("description"):
        return False, "Frontmatter missing required field: description", fm
    name = str(fm.get("name", ""))
    if not re.match(r"^[a-z0-9][a-z0-9-]{0,39}$", name):
        return (
            False,
            f"Skill name '{name}' must be lowercase-kebab-case (max 40 chars)",
            fm,
        )
    if not body.strip():
        return False, "Skill content (body) is empty", fm
    return True, "", fm


def _extract_name_from_frontmatter(markdown: str) -> str:
    m = re.match(r"^---\r?\n(.*?)\r?\n---", markdown, re.DOTALL)
    if not m:
        return "generated-skill"
    for line in m.group(1).split("\n"):
        if line.startswith("name:"):
            raw = line[5:].strip().strip("'\"")
            if raw:
                return re.sub(r"[^a-z0-9-]", "-", raw.lower())[:40]
    return "generated-skill"


# ── Skill session bootstrapping ───────────────────────────────────────────────


class StartSkillSessionRequest(BaseModel):
    agent_id: str
    model: str
    url: Optional[str] = None
    prompt: Optional[str] = None
    scope: str = "global"
    target_agent_id: Optional[str] = None


class StartSkillSessionResponse(BaseModel):
    session_id: str
    initial_message: str
    scope: str
    target_agent_id: Optional[str] = None


@router.post("/generate/session")
async def start_skill_gen_session(
    req: StartSkillSessionRequest,
) -> StartSkillSessionResponse:
    from app import dependencies
    from app.utils import gen_id
    from app.database import AsyncSessionLocal
    from app.models.chat import ChatSession

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")

    now = now_ms()
    session_id = f"skillgen_{req.agent_id}_{now}"

    if req.url:
        initial_message = (
            f"I need you to create a Djinnbot skill. "
            f"Please research this URL thoroughly — browse it, follow relevant links, read the API docs or source code: {req.url}\n\n"
            f"Then produce a complete SKILL.md for it. Use your browser and fetch tools to get real information. "
            f"Start by fetching the URL and tell me what you find."
        )
    elif req.prompt:
        initial_message = (
            f"I need you to create a Djinnbot skill based on this description:\n\n{req.prompt}\n\n"
            f"Research anything you need to (APIs, docs, repos) to write it accurately. "
            f"Ask me if anything is unclear before finalizing."
        )
    else:
        initial_message = (
            "I need you to help me create a Djinnbot skill. "
            "What capability should this skill teach an agent? Describe it and I'll guide you through writing it."
        )

    async with AsyncSessionLocal() as db:
        chat_session = ChatSession(
            id=session_id,
            agent_id=req.agent_id,
            status="starting",
            model=req.model,
            created_at=now,
            last_activity_at=now,
        )
        db.add(chat_session)
        await db.commit()

    await dependencies.redis_client.xadd(
        "djinnbot:events:chat_sessions",
        {
            "event": "chat:start",
            "session_id": session_id,
            "agent_id": req.agent_id,
            "model": req.model,
            "system_prompt_override": SKILL_SMITH_SYSTEM_PROMPT,
        },
    )

    return StartSkillSessionResponse(
        session_id=session_id,
        initial_message=initial_message,
        scope=req.scope,
        target_agent_id=req.target_agent_id,
    )


# ── Skill parse ───────────────────────────────────────────────────────────────


class ParseSkillRequest(BaseModel):
    raw: Optional[str] = None
    url: Optional[str] = None


class ParseSkillResponse(BaseModel):
    content: str
    name: str
    description: str
    tags: list[str]
    enabled: bool
    name_conflict: bool
    valid: bool
    error: Optional[str] = None


@router.post("/parse")
async def parse_skill(
    req: ParseSkillRequest,
    db: AsyncSession = Depends(get_async_session),
) -> ParseSkillResponse:
    if not req.raw and not req.url:
        raise HTTPException(status_code=400, detail="Provide either 'raw' or 'url'")

    if req.url:
        url = req.url.strip()
        url = re.sub(
            r"https://github\.com/([^/]+)/([^/]+)/blob/(.+)",
            r"https://raw.githubusercontent.com/\1/\2/\3",
            url,
        )
        headers = {"User-Agent": "Djinnbot-SkillParser/1.0", "Accept": "text/plain,*/*"}
        async with httpx.AsyncClient(
            timeout=_URL_FETCH_TIMEOUT, follow_redirects=True
        ) as client:
            try:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                raw = resp.text
            except httpx.HTTPStatusError as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Failed to fetch URL: HTTP {e.response.status_code}",
                )
            except Exception as e:
                raise HTTPException(status_code=422, detail=f"Failed to fetch URL: {e}")
    else:
        raw = (req.raw or "").strip()

    valid, error, fm = _validate_skill_markdown(raw)
    name = str(fm.get("name", "")) or _extract_name_from_frontmatter(raw)
    slug = re.sub(r"[^a-z0-9-]", "-", name.lower())[:40]

    _, body = _parse_frontmatter(raw)

    # Check DB for name conflict
    existing = await db.get(Skill, slug)
    conflict = existing is not None

    return ParseSkillResponse(
        content=body,
        name=slug,
        description=str(fm.get("description", "")),
        tags=fm.get("tags") or [slug],
        enabled=fm.get("enabled", True),
        name_conflict=conflict,
        valid=valid,
        error=error if not valid else None,
    )


# ── GitHub import ─────────────────────────────────────────────────────────────

_GH_REPO_RE = re.compile(r"^https?://github\.com/([^/]+)/([^/]+)/?(?:tree/[^/]+/?)?$")
_GH_FILE_RE = re.compile(r"^https?://github\.com/([^/]+)/([^/]+)/blob/(.+)$")
_GH_RAW_RE = re.compile(r"^https?://raw\.githubusercontent\.com/")

_GH_API_BASE = "https://api.github.com"
_GH_RAW_BASE = "https://raw.githubusercontent.com"


class GitHubImportedSkill(BaseModel):
    path: str
    raw_url: str
    content: str
    name: str
    description: str
    tags: list[str]
    enabled: bool
    name_conflict: bool
    valid: bool
    error: Optional[str] = None


class GitHubImportResponse(BaseModel):
    type: str
    repo: Optional[str] = None
    skills: list[GitHubImportedSkill]


def _parse_to_imported_skill(
    raw: str, path: str, raw_url: str, existing_ids: set[str]
) -> GitHubImportedSkill:
    valid, error, fm = _validate_skill_markdown(raw)
    name = (
        str(fm.get("name", ""))
        or re.sub(r"[^a-z0-9-]", "-", path.split("/")[-2].lower())[:40]
    )
    slug = re.sub(r"[^a-z0-9-]", "-", name.lower())[:40]
    _, body = _parse_frontmatter(raw)
    conflict = slug in existing_ids
    return GitHubImportedSkill(
        path=path,
        raw_url=raw_url,
        content=body,
        name=slug,
        description=str(fm.get("description", "")),
        tags=fm.get("tags") or [slug],
        enabled=fm.get("enabled", True),
        name_conflict=conflict,
        valid=valid,
        error=error if not valid else None,
    )


class GitHubImportRequest(BaseModel):
    url: str


@router.post("/github-import")
async def github_import(
    req: GitHubImportRequest,
    db: AsyncSession = Depends(get_async_session),
) -> GitHubImportResponse:
    url = req.url.strip()
    headers = {"User-Agent": "Djinnbot-SkillImporter/1.0", "Accept": "application/json"}

    # Pre-load all existing skill IDs for conflict detection
    result = await db.execute(select(Skill.id))
    existing_ids: set[str] = {row[0] for row in result.all()}

    async with httpx.AsyncClient(
        timeout=_URL_FETCH_TIMEOUT, follow_redirects=True
    ) as client:
        if _GH_RAW_RE.match(url) or _GH_FILE_RE.match(url):
            raw_url = re.sub(
                r"https://github\.com/([^/]+)/([^/]+)/blob/(.+)",
                r"https://raw.githubusercontent.com/\1/\2/\3",
                url,
            )
            try:
                resp = await client.get(
                    raw_url, headers={"User-Agent": "Djinnbot-SkillImporter/1.0"}
                )
                resp.raise_for_status()
            except httpx.HTTPStatusError as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Failed to fetch file: HTTP {e.response.status_code}",
                )
            except Exception as e:
                raise HTTPException(
                    status_code=422, detail=f"Failed to fetch file: {e}"
                )

            path = raw_url.split("/")[-1]
            skill = _parse_to_imported_skill(resp.text, path, raw_url, existing_ids)
            return GitHubImportResponse(type="file", skills=[skill])

        m = _GH_REPO_RE.match(url)
        if not m:
            raise HTTPException(
                status_code=422,
                detail="Unrecognised GitHub URL. Provide a repo URL or a file URL.",
            )

        owner, repo = m.group(1), m.group(2)
        repo_full = f"{owner}/{repo}"

        try:
            tree_resp = await client.get(
                f"{_GH_API_BASE}/repos/{owner}/{repo}/git/trees/HEAD?recursive=1",
                headers=headers,
            )
            tree_resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise HTTPException(
                status_code=422,
                detail=f"Failed to fetch repo tree: HTTP {e.response.status_code}",
            )
        except Exception as e:
            raise HTTPException(
                status_code=422, detail=f"Failed to fetch repo tree: {e}"
            )

        tree_data = tree_resp.json()
        skill_paths = [
            entry["path"]
            for entry in tree_data.get("tree", [])
            if entry.get("type") == "blob" and entry["path"].endswith("SKILL.md")
        ]

        if not skill_paths:
            raise HTTPException(
                status_code=404, detail=f"No SKILL.md files found in {repo_full}"
            )

        skills: list[GitHubImportedSkill] = []
        for path in skill_paths:
            raw_url = f"{_GH_RAW_BASE}/{owner}/{repo}/HEAD/{path}"
            try:
                r = await client.get(
                    raw_url, headers={"User-Agent": "Djinnbot-SkillImporter/1.0"}
                )
                r.raise_for_status()
                skills.append(
                    _parse_to_imported_skill(r.text, path, raw_url, existing_ids)
                )
            except Exception:
                skills.append(
                    GitHubImportedSkill(
                        path=path,
                        raw_url=raw_url,
                        content="",
                        name=re.sub(r"[^a-z0-9-]", "-", path.split("/")[-2].lower())[
                            :40
                        ],
                        description="",
                        tags=[],
                        enabled=True,
                        name_conflict=False,
                        valid=False,
                        error="Failed to fetch this file",
                    )
                )

        return GitHubImportResponse(type="repo", repo=repo_full, skills=skills)


# ── Extract skill from agent output ──────────────────────────────────────────


class ExtractSkillRequest(BaseModel):
    text: str


class ExtractSkillResponse(BaseModel):
    found: bool
    content: str
    name: str
    description: str
    tags: list[str]
    name_conflict: bool
    valid: bool
    error: Optional[str] = None


@router.post("/extract")
async def extract_skill_from_output(
    req: ExtractSkillRequest,
    db: AsyncSession = Depends(get_async_session),
) -> ExtractSkillResponse:
    text = req.text

    m = re.search(r"```skill-output\s*\n([\s\S]*?)```", text)
    if not m:
        m = re.search(r"```(?:markdown|yaml|md)?\s*\n(---[\s\S]*?)```", text)
    if not m:
        m = re.search(r"(---\s*\n[\s\S]*?\n---\s*\n[\s\S]+?)(?:\n```|\Z)", text)

    if not m:
        return ExtractSkillResponse(
            found=False,
            content="",
            name="",
            description="",
            tags=[],
            name_conflict=False,
            valid=False,
            error="No skill-output block found in the agent's response yet.",
        )

    raw = m.group(1).strip()
    valid, error, fm = _validate_skill_markdown(raw)
    name = str(fm.get("name", "")) or _extract_name_from_frontmatter(raw)
    slug = re.sub(r"[^a-z0-9-]", "-", name.lower())[:40]
    _, body = _parse_frontmatter(raw)
    existing = await db.get(Skill, slug)
    conflict = existing is not None

    return ExtractSkillResponse(
        found=True,
        content=raw,
        name=slug,
        description=str(fm.get("description", "")),
        tags=fm.get("tags") or [slug],
        name_conflict=conflict,
        valid=valid,
        error=error if not valid else None,
    )
