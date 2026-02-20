"""Pipeline management endpoints."""
import os
import yaml
from fastapi import APIRouter, HTTPException, status
from app.schemas import PipelineResponse, ErrorResponse
from app.utils import load_pipeline
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

# Get pipelines directory from env var
PIPELINES_DIR = os.getenv("PIPELINES_DIR", "./pipelines")


def _load_pipeline_from_file(file_path: str) -> dict | None:
    """Load and parse a pipeline YAML file."""
    logger.debug("Loading pipeline YAML file: %s", file_path)
    try:
        with open(file_path, "r") as f:
            content = yaml.safe_load(f)
        logger.debug("Successfully loaded pipeline from: %s", file_path)
        return content
    except Exception as e:
        logger.debug("Failed to load pipeline from %s: %s", file_path, e)
        return None


def _get_pipeline_id_from_file(file_path: str) -> str | None:
    """Extract pipeline ID from filename or content."""
    # First try to get from content
    content = _load_pipeline_from_file(file_path)
    if content and "id" in content:
        return content["id"]
    
    # Fall back to filename without extension
    basename = os.path.basename(file_path)
    for ext in [".yml", ".yaml"]:
        if basename.endswith(ext):
            return basename[:-len(ext)]
    return basename


@router.get("/", response_model=list[PipelineResponse])
async def list_pipelines():
    """List all available pipelines from filesystem."""
    pipelines = []
    
    if not os.path.exists(PIPELINES_DIR):
        return pipelines
    
    for filename in os.listdir(PIPELINES_DIR):
        if not filename.endswith((".yml", ".yaml")):
            continue
        
        file_path = os.path.join(PIPELINES_DIR, filename)
        if not os.path.isfile(file_path):
            continue
        
        content = _load_pipeline_from_file(file_path)
        if not content:
            continue
        
        pipeline_id = content.get("id") or _get_pipeline_id_from_file(file_path)
        
        pipelines.append(PipelineResponse(
            id=pipeline_id,
            name=content.get("name", pipeline_id),
            description=content.get("description"),
            steps=content.get("steps", []),
            agents=content.get("agents", [])
        ))
    
    return pipelines


@router.get("/{pipeline_id}", response_model=PipelineResponse, responses={404: {"model": ErrorResponse}})
async def get_pipeline(pipeline_id: str):
    """Get a specific pipeline by ID."""
    logger.debug("Getting pipeline: %s", pipeline_id)
    content = load_pipeline(pipeline_id)
    
    if not content:
        logger.debug("Pipeline not found: %s", pipeline_id)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Pipeline {pipeline_id} not found"
        )
    
    logger.debug("Successfully retrieved pipeline: %s", pipeline_id)
    return PipelineResponse(
        id=pipeline_id,
        name=content.get("name", pipeline_id),
        description=content.get("description"),
        steps=content.get("steps", []),
        agents=content.get("agents", [])
    )


@router.post("/{pipeline_id}/validate")
async def validate_pipeline(pipeline_id: str):
    """Validate a pipeline configuration."""
    logger.debug("Validating pipeline: %s", pipeline_id)
    content = load_pipeline(pipeline_id)
    
    if not content:
        logger.debug("Pipeline not found for validation: %s", pipeline_id)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Pipeline {pipeline_id} not found"
        )
    
    errors = []
    warnings = []
    
    # Validate required fields
    logger.debug("Validating required fields for pipeline: %s", pipeline_id)
    if not content.get("steps"):
        errors.append("Pipeline has no steps defined")
    elif not isinstance(content["steps"], list):
        errors.append("Pipeline 'steps' must be a list")
    
    if not content.get("agents"):
        warnings.append("Pipeline has no agents defined")
    elif not isinstance(content.get("agents"), list):
        errors.append("Pipeline 'agents' must be a list")
    
    # Validate each step has required fields
    logger.debug("Validating steps for pipeline: %s", pipeline_id)
    if isinstance(content.get("steps"), list):
        for i, step in enumerate(content["steps"]):
            if isinstance(step, dict):
                if not step.get("id") and not step.get("name"):
                    errors.append(f"Step {i} is missing 'id' or 'name'")
                if not step.get("agent") and not step.get("agent_id"):
                    warnings.append(f"Step {i} has no agent assigned")
            elif isinstance(step, str):
                # String step names are okay
                pass
            else:
                errors.append(f"Step {i} has invalid format")
    
    return {
        "valid": len(errors) == 0,
        "pipeline_id": pipeline_id,
        "errors": errors,
        "warnings": warnings
    }


@router.get("/{pipeline_id}/raw")
async def get_pipeline_raw(pipeline_id: str):
    """Get raw YAML content for a pipeline."""
    logger.debug("Getting raw pipeline: %s", pipeline_id)
    if not os.path.exists(PIPELINES_DIR):
        logger.debug("Pipelines directory not found: %s", PIPELINES_DIR)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Pipeline {pipeline_id} not found"
        )
    
    for fname in os.listdir(PIPELINES_DIR):
        if not fname.endswith(('.yml', '.yaml')):
            continue
        fpath = os.path.join(PIPELINES_DIR, fname)
        try:
            with open(fpath, 'r') as f:
                content = f.read()
                parsed = yaml.safe_load(content)
                if parsed and parsed.get('id') == pipeline_id:
                    logger.debug("Found raw pipeline: %s in %s", pipeline_id, fname)
                    return {"pipeline_id": pipeline_id, "yaml": content, "file": fname}
        except Exception as e:
            logger.debug("Error reading pipeline file %s: %s", fpath, e)
            continue
    
    logger.debug("Pipeline not found in directory: %s", pipeline_id)
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Pipeline {pipeline_id} not found"
    )


from pydantic import BaseModel

class PipelineUpdateRequest(BaseModel):
    yaml_content: str  # Raw YAML string


@router.put("/{pipeline_id}")
async def update_pipeline(pipeline_id: str, req: PipelineUpdateRequest):
    """Update a pipeline YAML file."""
    logger.debug("Updating pipeline: %s", pipeline_id)
    # Parse and validate the YAML
    try:
        parsed = yaml.safe_load(req.yaml_content)
    except Exception as e:
        logger.debug("Invalid YAML for pipeline %s: %s", pipeline_id, e)
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {e}")
    
    if not parsed or parsed.get("id") != pipeline_id:
        logger.debug("Pipeline ID mismatch: %s vs %s", parsed.get("id"), pipeline_id)
        raise HTTPException(
            status_code=400,
            detail=f"Pipeline ID in YAML must match URL: {pipeline_id}"
        )
    
    # Find existing file
    if not os.path.exists(PIPELINES_DIR):
        logger.debug("Creating pipelines directory: %s", PIPELINES_DIR)
        os.makedirs(PIPELINES_DIR, exist_ok=True)
    
    target_file = None
    logger.debug("Searching for existing pipeline file: %s", pipeline_id)
    for fname in os.listdir(PIPELINES_DIR):
        if not fname.endswith(('.yml', '.yaml')):
            continue
        fpath = os.path.join(PIPELINES_DIR, fname)
        try:
            with open(fpath, 'r') as f:
                content = yaml.safe_load(f)
                if content and content.get('id') == pipeline_id:
                    target_file = fpath
                    logger.debug("Found existing pipeline file: %s", target_file)
                    break
        except Exception as e:
            logger.debug("Error reading file %s: %s", fpath, e)
            continue
    
    if not target_file:
        # Create new file
        target_file = os.path.join(PIPELINES_DIR, f"{pipeline_id}.yml")
        logger.debug("Creating new pipeline file: %s", target_file)
    
    with open(target_file, 'w') as f:
        f.write(req.yaml_content)
    
    logger.debug("Successfully updated pipeline: %s", pipeline_id)
    
    return {
        "status": "updated",
        "pipeline_id": pipeline_id,
        "file": os.path.basename(target_file)
    }
