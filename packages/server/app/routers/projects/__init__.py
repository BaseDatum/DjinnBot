"""Project and task management endpoints.

This module combines project sub-routers into a single router for backward compatibility.
The original endpoints are now split across:
- core.py: Project CRUD (create, list, get, update, delete, archive)
- repository.py: Repository management (set, remove, status, validate, clone)
- tasks.py: Task CRUD and column management
- dependencies.py: Task dependencies and dependency graph
- workflows.py: Workflow CRUD
- execution.py: Task execution engine
- planning.py: Project planning and bulk import
- agents.py: Agent assignments to projects
"""

from fastapi import APIRouter

from .core import router as core_router
from .repository import router as repository_router
from .tasks import router as tasks_router
from .dependencies import router as dependencies_router
from .workflows import router as workflows_router
from .execution import router as execution_router
from .planning import router as planning_router
from .agents import router as agents_router
from .git_integration import router as git_integration_router
from .agent_routines import router as agent_routines_router
from .swarm import router as swarm_router

# Re-export commonly used items for backward compatibility
from ._common import (
    get_project_or_404,
    get_task_or_404,
    _serialize_task,
    BulkImportTasksRequest,
)
from .execution import task_run_completed  # Used by main.py listener
from .planning import (
    bulk_import_tasks,
    bulk_import_subtasks,
)  # Used by main.py listener

# Create combined router for backward compatibility
router = APIRouter()

# Include sub-routers (no prefix needed - paths are already correct)
router.include_router(core_router)
router.include_router(repository_router)
router.include_router(tasks_router)
router.include_router(dependencies_router)
router.include_router(workflows_router)
router.include_router(execution_router)
router.include_router(planning_router)
router.include_router(agents_router)
router.include_router(git_integration_router)
router.include_router(agent_routines_router)
router.include_router(swarm_router)

__all__ = [
    "router",
    "get_project_or_404",
    "get_task_or_404",
    "_serialize_task",
    "task_run_completed",
    "bulk_import_tasks",
    "bulk_import_subtasks",
    "BulkImportTasksRequest",
]
