"""Integration tests for runs router."""
import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_run(client: AsyncClient):
    """Test creating a new run."""
    response = await client.post(
        "/api/runs/",
        json={
            "pipeline_id": "test-pipeline",
            "task": "Test task description",
        }
    )
    
    assert response.status_code == 200
    data = response.json()
    assert data["id"].startswith("run_")
    assert data["pipeline_id"] == "test-pipeline"
    assert data["status"] == "pending"


@pytest.mark.asyncio
async def test_create_run_pipeline_not_found(client: AsyncClient):
    """Test creating run with non-existent pipeline."""
    response = await client.post(
        "/api/runs/",
        json={
            "pipeline_id": "nonexistent-pipeline",
            "task": "Test task",
        }
    )
    
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_list_runs_empty(client: AsyncClient):
    """Test listing runs when empty."""
    response = await client.get("/api/runs/")
    
    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.asyncio
async def test_list_runs_with_filter(client: AsyncClient):
    """Test listing runs with status filter."""
    # Create a run first
    await client.post(
        "/api/runs/",
        json={"pipeline_id": "test-pipeline", "task": "Test"}
    )
    
    # List with filter
    response = await client.get("/api/runs/?status=pending")
    
    assert response.status_code == 200
    runs = response.json()
    assert len(runs) == 1
    assert runs[0]["status"] == "pending"


@pytest.mark.asyncio
async def test_list_runs_by_pipeline(client: AsyncClient):
    """Test listing runs filtered by pipeline."""
    # Create a run
    await client.post(
        "/api/runs/",
        json={"pipeline_id": "test-pipeline", "task": "Test"}
    )
    
    # List with pipeline filter
    response = await client.get("/api/runs/?pipeline_id=test-pipeline")
    
    assert response.status_code == 200
    runs = response.json()
    assert len(runs) == 1
    assert runs[0]["pipeline_id"] == "test-pipeline"


@pytest.mark.asyncio
async def test_get_run_not_found(client: AsyncClient):
    """Test getting non-existent run."""
    response = await client.get("/api/runs/nonexistent")
    
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_get_run_success(client: AsyncClient):
    """Test getting a run by ID."""
    # Create run
    create_response = await client.post(
        "/api/runs/",
        json={"pipeline_id": "test-pipeline", "task": "Test task"}
    )
    run_id = create_response.json()["id"]
    
    # Get it
    response = await client.get(f"/api/runs/{run_id}")
    
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == run_id
    assert data["task"] == "Test task"
    assert data["status"] == "pending"


@pytest.mark.asyncio
async def test_cancel_run(client: AsyncClient):
    """Test cancelling a run."""
    # Create run
    create_response = await client.post(
        "/api/runs/",
        json={"pipeline_id": "test-pipeline", "task": "Test"}
    )
    run_id = create_response.json()["id"]
    
    # Cancel it
    cancel_response = await client.post(f"/api/runs/{run_id}/cancel")
    
    assert cancel_response.status_code == 200
    data = cancel_response.json()
    assert data["status"] == "cancelled"
    
    # Verify cancelled
    get_response = await client.get(f"/api/runs/{run_id}")
    assert get_response.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_nonexistent_run(client: AsyncClient):
    """Test cancelling non-existent run."""
    response = await client.post("/api/runs/nonexistent/cancel")
    assert response.status_code == 404