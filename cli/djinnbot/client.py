"""HTTP client for the djinnbot API."""
import httpx
import json
from typing import Optional, Iterator


class DjinnBotClient:
    """Client for communicating with the djinnbot API server."""

    def __init__(self, base_url: str = "http://localhost:8000"):
        self.base_url = base_url
        self.client = httpx.Client(base_url=base_url, timeout=30.0, follow_redirects=True)

    def get_status(self) -> dict:
        """Get server status."""
        response = self.client.get("/api/status")
        response.raise_for_status()
        return response.json()

    def list_pipelines(self) -> list[dict]:
        """List all pipelines."""
        response = self.client.get("/api/pipelines/")
        response.raise_for_status()
        return response.json()

    def get_pipeline(self, pipeline_id: str) -> dict:
        """Get a specific pipeline."""
        response = self.client.get(f"/api/pipelines/{pipeline_id}")
        response.raise_for_status()
        return response.json()

    def validate_pipeline(self, pipeline_id: str) -> dict:
        """Validate a pipeline by ID."""
        response = self.client.post(f"/api/pipelines/{pipeline_id}/validate")
        response.raise_for_status()
        return response.json()

    def start_run(self, pipeline_id: str, task: str, context: Optional[str] = None) -> dict:
        """Start a new pipeline run."""
        payload = {"pipeline_id": pipeline_id, "task": task}
        if context:
            payload["context"] = context
        response = self.client.post("/api/runs/", json=payload)
        response.raise_for_status()
        return response.json()

    def list_runs(self, pipeline_id: Optional[str] = None, status: Optional[str] = None) -> list[dict]:
        """List pipeline runs."""
        params = {}
        if pipeline_id:
            params["pipeline_id"] = pipeline_id
        if status:
            params["status"] = status
        response = self.client.get("/api/runs/", params=params)
        response.raise_for_status()
        return response.json()

    def get_run(self, run_id: str) -> dict:
        """Get a specific run."""
        response = self.client.get(f"/api/runs/{run_id}")
        response.raise_for_status()
        return response.json()

    def cancel_run(self, run_id: str) -> dict:
        """Cancel a running pipeline."""
        response = self.client.post(f"/api/runs/{run_id}/cancel")
        response.raise_for_status()
        return response.json()

    def get_step(self, run_id: str, step_id: str) -> dict:
        """Get step details."""
        response = self.client.get(f"/api/steps/{run_id}/{step_id}")
        response.raise_for_status()
        return response.json()

    def restart_step(self, run_id: str, step_id: str, context: Optional[str] = None) -> dict:
        """Restart a step."""
        payload = {}
        if context:
            payload["context"] = context
        response = self.client.post(f"/api/steps/{run_id}/{step_id}/restart", json=payload)
        response.raise_for_status()
        return response.json()

    def get_run_logs(self, run_id: str) -> list[dict]:
        """Get logs for a run."""
        response = self.client.get(f"/api/runs/{run_id}/logs")
        response.raise_for_status()
        return response.json()

    def stream_run_events(self, run_id: str) -> Iterator[dict]:
        """Stream events for a run using SSE."""
        with httpx.stream("GET", f"{self.base_url}/api/events/stream/{run_id}", timeout=None) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if data:
                        try:
                            yield json.loads(data)
                        except json.JSONDecodeError:
                            continue

    # Run control (Phase 7.1)
    def restart_run(self, run_id: str, context: Optional[str] = None) -> dict:
        """Restart a run from scratch."""
        payload = {"context": context} if context else {}
        response = self.client.post(f"/api/runs/{run_id}/restart", json=payload)
        response.raise_for_status()
        return response.json()

    def pause_run(self, run_id: str) -> dict:
        """Pause a running pipeline."""
        response = self.client.post(f"/api/runs/{run_id}/pause")
        response.raise_for_status()
        return response.json()

    def resume_run(self, run_id: str) -> dict:
        """Resume a paused pipeline."""
        response = self.client.post(f"/api/runs/{run_id}/resume")
        response.raise_for_status()
        return response.json()

    # Agents (Phase 7.3)
    def list_agents(self) -> list[dict]:
        """List all agents."""
        response = self.client.get("/api/agents/")
        response.raise_for_status()
        return response.json()

    def get_agent(self, agent_id: str) -> dict:
        """Get a specific agent."""
        response = self.client.get(f"/api/agents/{agent_id}")
        response.raise_for_status()
        return response.json()

    def get_agents_status(self) -> list[dict]:
        """Get runtime status of all agents."""
        response = self.client.get("/api/agents/status")
        response.raise_for_status()
        return response.json()

    def get_agent_status(self, agent_id: str) -> dict:
        """Get runtime status of a specific agent."""
        response = self.client.get(f"/api/agents/{agent_id}/status")
        response.raise_for_status()
        return response.json()

    def get_agent_runs(self, agent_id: str) -> list[dict]:
        """Get runs the agent participated in."""
        response = self.client.get(f"/api/agents/{agent_id}/runs")
        response.raise_for_status()
        return response.json()

    def get_agent_memory(self, agent_id: str) -> list[dict]:
        """Get memory files for an agent."""
        response = self.client.get(f"/api/agents/{agent_id}/memory")
        response.raise_for_status()
        return response.json()

    def get_agent_memory_file(self, agent_id: str, filename: str) -> dict:
        """Get a specific memory file for an agent."""
        response = self.client.get(f"/api/agents/{agent_id}/memory/{filename}")
        response.raise_for_status()
        return response.json()

    # Memory (Phase 7.2)
    def list_vaults(self) -> list[dict]:
        """List all memory vaults."""
        response = self.client.get("/api/memory/vaults")
        response.raise_for_status()
        return response.json()

    def list_vault_files(self, agent_id: str) -> list[dict]:
        """List files in a vault."""
        response = self.client.get(f"/api/memory/vaults/{agent_id}")
        response.raise_for_status()
        return response.json()

    def get_vault_file(self, agent_id: str, filename: str) -> dict:
        """Get a specific file from a vault."""
        response = self.client.get(f"/api/memory/vaults/{agent_id}/{filename}")
        response.raise_for_status()
        return response.json()

    def search_memory(self, query: str, agent_id: Optional[str] = None, limit: int = 20) -> list[dict]:
        """Search across memory vaults."""
        params = {"q": query, "limit": limit}
        if agent_id:
            params["agent_id"] = agent_id
        response = self.client.get("/api/memory/search", params=params)
        response.raise_for_status()
        return response.json()

    def delete_vault_file(self, agent_id: str, filename: str) -> dict:
        """Delete a file from a vault."""
        response = self.client.delete(f"/api/memory/vaults/{agent_id}/{filename}")
        response.raise_for_status()
        return response.json()
