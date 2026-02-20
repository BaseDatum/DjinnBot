"""Integration tests for projects router."""
import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_project(client: AsyncClient):
    """Test creating a new project."""
    response = await client.post(
        "/api/projects/",
        json={
            "name": "Test Project",
            "description": "A test project",
        }
    )
    
    assert response.status_code == 200
    data = response.json()
    assert data["id"].startswith("proj_")
    assert data["name"] == "Test Project"
    assert data["status"] == "active"


@pytest.mark.asyncio
async def test_create_project_with_repo(client: AsyncClient):
    """Test creating a project with a repository URL."""
    response = await client.post(
        "/api/projects/",
        json={
            "name": "Project With Repo",
            "description": "Has a repo",
            "repository": "https://github.com/test/repo",
        }
    )
    
    assert response.status_code == 200
    data = response.json()
    assert "repo" in data.get("repository", "").lower()


@pytest.mark.asyncio
async def test_get_project(client: AsyncClient):
    """Test getting a project by ID."""
    # Create project
    create_response = await client.post(
        "/api/projects/",
        json={"name": "My Project"}
    )
    project_id = create_response.json()["id"]
    
    # Get it
    response = await client.get(f"/api/projects/{project_id}")
    
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == project_id
    assert data["name"] == "My Project"


@pytest.mark.asyncio
async def test_get_project_not_found(client: AsyncClient):
    """Test getting non-existent project."""
    response = await client.get("/api/projects/nonexistent")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_list_projects(client: AsyncClient):
    """Test listing projects."""
    # Create a couple of projects
    await client.post("/api/projects/", json={"name": "Project 1"})
    await client.post("/api/projects/", json={"name": "Project 2"})
    
    # List all
    response = await client.get("/api/projects/")
    
    assert response.status_code == 200
    projects = response.json()
    assert len(projects) == 2


@pytest.mark.asyncio
async def test_list_projects_empty(client: AsyncClient):
    """Test listing projects when empty."""
    response = await client.get("/api/projects/")
    
    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.asyncio
async def test_update_project(client: AsyncClient):
    """Test updating a project."""
    # Create project
    create_response = await client.post(
        "/api/projects/",
        json={"name": "Original Name", "description": "Original"}
    )
    project_id = create_response.json()["id"]
    
    # Update it
    update_response = await client.patch(
        f"/api/projects/{project_id}",
        json={"name": "Updated Name", "description": "Updated"}
    )
    
    assert update_response.status_code == 200
    data = update_response.json()
    assert data["name"] == "Updated Name"
    assert data["description"] == "Updated"


@pytest.mark.asyncio
async def test_update_project_status(client: AsyncClient):
    """Test updating project status."""
    # Create project
    create_response = await client.post("/api/projects/", json={"name": "Test"})
    project_id = create_response.json()["id"]
    
    # Update status to completed
    update_response = await client.patch(
        f"/api/projects/{project_id}",
        json={"status": "completed"}
    )
    
    assert update_response.status_code == 200
    assert update_response.json()["status"] == "completed"


@pytest.mark.asyncio
async def test_delete_project(client: AsyncClient):
    """Test deleting a project."""
    # Create project
    create_response = await client.post("/api/projects/", json={"name": "To Delete"})
    project_id = create_response.json()["id"]
    
    # Delete it
    delete_response = await client.delete(f"/api/projects/{project_id}")
    assert delete_response.status_code == 200
    
    # Verify gone
    get_response = await client.get(f"/api/projects/{project_id}")
    assert get_response.status_code == 404


@pytest.mark.asyncio
async def test_create_task(client: AsyncClient):
    """Test creating a task in a project."""
    # Create project
    project_response = await client.post(
        "/api/projects/",
        json={"name": "Test Project"}
    )
    project_id = project_response.json()["id"]
    
    # Create task
    task_response = await client.post(
        f"/api/projects/{project_id}/tasks",
        json={
            "title": "Test Task",
            "description": "Do something",
            "priority": "P1",
        }
    )
    
    assert task_response.status_code == 200
    data = task_response.json()
    assert data["title"] == "Test Task"
    assert data["status"] == "backlog"
    assert data["priority"] == "P1"


@pytest.mark.asyncio
async def test_get_task(client: AsyncClient):
    """Test getting a task by ID."""
    # Create project and task
    project_response = await client.post("/api/projects/", json={"name": "Test"})
    project_id = project_response.json()["id"]
    
    task_response = await client.post(
        f"/api/projects/{project_id}/tasks",
        json={"title": "My Task"}
    )
    task_id = task_response.json()["id"]
    
    # Get task
    response = await client.get(f"/api/projects/{project_id}/tasks/{task_id}")
    
    assert response.status_code == 200
    assert response.json()["title"] == "My Task"


@pytest.mark.asyncio
async def test_list_tasks(client: AsyncClient):
    """Test listing tasks in a project."""
    # Create project
    project_response = await client.post("/api/projects/", json={"name": "Test"})
    project_id = project_response.json()["id"]
    
    # Create a few tasks
    await client.post(f"/api/projects/{project_id}/tasks", json={"title": "Task 1"})
    await client.post(f"/api/projects/{project_id}/tasks", json={"title": "Task 2"})
    
    # List tasks
    response = await client.get(f"/api/projects/{project_id}/tasks")
    
    assert response.status_code == 200
    tasks = response.json()
    assert len(tasks) == 2


@pytest.mark.asyncio
async def test_update_task(client: AsyncClient):
    """Test updating a task."""
    # Create project and task
    project_response = await client.post("/api/projects/", json={"name": "Test"})
    project_id = project_response.json()["id"]
    
    task_response = await client.post(
        f"/api/projects/{project_id}/tasks",
        json={"title": "Original Title", "priority": "P2"}
    )
    task_id = task_response.json()["id"]
    
    # Update task
    update_response = await client.patch(
        f"/api/projects/{project_id}/tasks/{task_id}",
        json={"title": "New Title", "priority": "P1"}
    )
    
    assert update_response.status_code == 200
    data = update_response.json()
    assert data["title"] == "New Title"
    assert data["priority"] == "P1"


@pytest.mark.asyncio
async def test_move_task(client: AsyncClient):
    """Test moving a task to a different column."""
    # Create project
    project_response = await client.post("/api/projects/", json={"name": "Test"})
    project_id = project_response.json()["id"]
    
    # Get columns
    project_data = await client.get(f"/api/projects/{project_id}")
    columns = project_data.json()["columns"]
    
    # Create task (defaults to first column/backlog)
    task_response = await client.post(
        f"/api/projects/{project_id}/tasks",
        json={"title": "Task to Move"}
    )
    task_id = task_response.json()["id"]
    
    # Get second column id
    if len(columns) > 1:
        second_column_id = columns[1]["id"]
        
        # Move task
        move_response = await client.post(
            f"/api/projects/{project_id}/tasks/{task_id}/move",
            json={"columnId": second_column_id, "position": 0}
        )
        
        assert move_response.status_code == 200


@pytest.mark.asyncio
async def test_delete_task(client: AsyncClient):
    """Test deleting a task."""
    # Create project and task
    project_response = await client.post("/api/projects/", json={"name": "Test"})
    project_id = project_response.json()["id"]
    
    task_response = await client.post(
        f"/api/projects/{project_id}/tasks",
        json={"title": "To Delete"}
    )
    task_id = task_response.json()["id"]
    
    # Delete task
    delete_response = await client.delete(f"/api/projects/{project_id}/tasks/{task_id}")
    assert delete_response.status_code == 200
    
    # Verify gone
    get_response = await client.get(f"/api/projects/{project_id}/tasks/{task_id}")
    assert get_response.status_code == 404


@pytest.mark.asyncio
async def test_add_dependency(client: AsyncClient):
    """Test adding a dependency between tasks."""
    # Create project
    project_response = await client.post("/api/projects/", json={"name": "Test"})
    project_id = project_response.json()["id"]
    
    # Create two tasks
    task1_response = await client.post(
        f"/api/projects/{project_id}/tasks",
        json={"title": "Task 1"}
    )
    task1_id = task1_response.json()["id"]
    
    task2_response = await client.post(
        f"/api/projects/{project_id}/tasks",
        json={"title": "Task 2"}
    )
    task2_id = task2_response.json()["id"]
    
    # Add dependency: task1 blocks task2
    dep_response = await client.post(
        f"/api/projects/{project_id}/tasks/{task2_id}/dependencies",
        json={"fromTaskId": task1_id, "type": "blocks"}
    )
    
    assert dep_response.status_code == 200
    data = dep_response.json()
    assert data["from_task_id"] == task1_id
    assert data["to_task_id"] == task2_id


@pytest.mark.asyncio
async def test_get_project_columns(client: AsyncClient):
    """Test that new project has default columns."""
    # Create project
    create_response = await client.post(
        "/api/projects/",
        json={"name": "Test"}
    )
    project_id = create_response.json()["id"]
    
    # Get with full details
    response = await client.get(f"/api/projects/{project_id}")
    
    assert response.status_code == 200
    data = response.json()
    assert len(data["columns"]) == 8  # Default columns
    assert data["columns"][0]["name"] == "Backlog"