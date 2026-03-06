"""HTTP client for the djinnbot API."""

import httpx
import json
from typing import Optional, Iterator


class DjinnBotClient:
    """Client for communicating with the djinnbot API server.

    All endpoints use the /v1/ prefix matching the FastAPI server routes.
    Supports Bearer token authentication (JWT or API key).
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8000",
        token: Optional[str] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self._token = token
        self._client: httpx.Client | None = None

    @property
    def token(self) -> Optional[str]:
        return self._token

    @token.setter
    def token(self, value: Optional[str]) -> None:
        self._token = value
        # Recreate client so headers are updated
        if self._client is not None:
            self._client.close()
            self._client = None

    def _build_headers(self) -> dict:
        """Build request headers including auth if token is set."""
        headers = {}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def _ensure_token(self) -> None:
        """Try to refresh expired JWT tokens before making a request."""
        from djinnbot.auth import resolve_token

        if self._token:
            return
        # Attempt to get a token from stored credentials
        token = resolve_token(self.base_url)
        if token:
            self.token = token

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                base_url=self.base_url,
                timeout=30.0,
                follow_redirects=True,
                headers=self._build_headers(),
            )
        return self._client

    def close(self):
        if self._client is not None:
            self._client.close()
            self._client = None

    # ── Status ──────────────────────────────────────────────────────────

    def get_status(self) -> dict:
        """Get server health status."""
        response = self.client.get("/v1/status")
        response.raise_for_status()
        return response.json()

    # ── Pipelines ───────────────────────────────────────────────────────

    def list_pipelines(self) -> list[dict]:
        """List all pipelines."""
        response = self.client.get("/v1/pipelines/")
        response.raise_for_status()
        return response.json()

    def get_pipeline(self, pipeline_id: str) -> dict:
        """Get a specific pipeline."""
        response = self.client.get(f"/v1/pipelines/{pipeline_id}")
        response.raise_for_status()
        return response.json()

    def validate_pipeline(self, pipeline_id: str) -> dict:
        """Validate a pipeline by ID."""
        response = self.client.post(f"/v1/pipelines/{pipeline_id}/validate")
        response.raise_for_status()
        return response.json()

    def get_pipeline_raw(self, pipeline_id: str) -> dict:
        """Get raw YAML content for a pipeline."""
        response = self.client.get(f"/v1/pipelines/{pipeline_id}/raw")
        response.raise_for_status()
        return response.json()

    def update_pipeline(self, pipeline_id: str, yaml_content: str) -> dict:
        """Update a pipeline YAML file."""
        response = self.client.put(
            f"/v1/pipelines/{pipeline_id}",
            json={"yaml_content": yaml_content},
        )
        response.raise_for_status()
        return response.json()

    # ── Runs ────────────────────────────────────────────────────────────

    def start_run(
        self,
        pipeline_id: str,
        task: str,
        context: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> dict:
        """Start a new pipeline run."""
        payload: dict = {"pipeline_id": pipeline_id, "task": task}
        if context:
            payload["context"] = context
        if project_id:
            payload["project_id"] = project_id
        response = self.client.post("/v1/runs/", json=payload)
        response.raise_for_status()
        return response.json()

    def list_runs(
        self,
        pipeline_id: Optional[str] = None,
        status: Optional[str] = None,
    ) -> list[dict]:
        """List pipeline runs."""
        params: dict = {}
        if pipeline_id:
            params["pipeline_id"] = pipeline_id
        if status:
            params["status"] = status
        response = self.client.get("/v1/runs/", params=params)
        response.raise_for_status()
        return response.json()

    def get_run(self, run_id: str) -> dict:
        """Get a specific run with step details."""
        response = self.client.get(f"/v1/runs/{run_id}")
        response.raise_for_status()
        return response.json()

    def cancel_run(self, run_id: str) -> dict:
        """Cancel a running pipeline."""
        response = self.client.post(f"/v1/runs/{run_id}/cancel")
        response.raise_for_status()
        return response.json()

    def restart_run(self, run_id: str, context: Optional[str] = None) -> dict:
        """Restart a run from scratch."""
        payload = {"context": context} if context else {}
        response = self.client.post(f"/v1/runs/{run_id}/restart", json=payload)
        response.raise_for_status()
        return response.json()

    def pause_run(self, run_id: str) -> dict:
        """Pause a running pipeline."""
        response = self.client.post(f"/v1/runs/{run_id}/pause")
        response.raise_for_status()
        return response.json()

    def resume_run(self, run_id: str) -> dict:
        """Resume a paused pipeline."""
        response = self.client.post(f"/v1/runs/{run_id}/resume")
        response.raise_for_status()
        return response.json()

    def delete_run(self, run_id: str) -> dict:
        """Delete a run and its steps."""
        response = self.client.delete(f"/v1/runs/{run_id}")
        response.raise_for_status()
        return response.json()

    def get_run_logs(self, run_id: str) -> list[dict]:
        """Get event log for a run from Redis stream."""
        response = self.client.get(f"/v1/runs/{run_id}/logs")
        response.raise_for_status()
        return response.json()

    def get_run_outputs(self, run_id: str) -> dict:
        """Get all accumulated outputs for a run."""
        response = self.client.get(f"/v1/runs/{run_id}/outputs")
        response.raise_for_status()
        return response.json()

    def list_run_steps(self, run_id: str, status: Optional[str] = None) -> list[dict]:
        """List all steps for a run."""
        params: dict = {}
        if status:
            params["status"] = status
        response = self.client.get(f"/v1/runs/{run_id}/steps", params=params)
        response.raise_for_status()
        return response.json()

    def stream_run_events(self, run_id: str) -> Iterator[dict]:
        """Stream events for a run using SSE."""
        params = {}
        if self._token:
            params["token"] = self._token
        with httpx.stream(
            "GET",
            f"{self.base_url}/v1/events/stream/{run_id}",
            timeout=None,
            params=params,
            headers=self._build_headers(),
        ) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if data:
                        try:
                            yield json.loads(data)
                        except json.JSONDecodeError:
                            continue

    # ── Steps ───────────────────────────────────────────────────────────

    def get_step(self, run_id: str, step_id: str) -> dict:
        """Get step details."""
        response = self.client.get(f"/v1/steps/{run_id}/{step_id}")
        response.raise_for_status()
        return response.json()

    def restart_step(
        self, run_id: str, step_id: str, context: Optional[str] = None
    ) -> dict:
        """Restart a step."""
        payload = {}
        if context:
            payload["context"] = context
        response = self.client.post(
            f"/v1/steps/{run_id}/{step_id}/restart", json=payload
        )
        response.raise_for_status()
        return response.json()

    def get_step_logs(self, run_id: str, step_id: str) -> list[dict]:
        """Get logs for a specific step."""
        response = self.client.get(f"/v1/steps/{run_id}/{step_id}/logs")
        response.raise_for_status()
        return response.json()

    # ── Agents ──────────────────────────────────────────────────────────

    def list_agents(self) -> list[dict]:
        """List all agents."""
        response = self.client.get("/v1/agents/")
        response.raise_for_status()
        return response.json()

    def get_agent(self, agent_id: str) -> dict:
        """Get a specific agent with persona files."""
        response = self.client.get(f"/v1/agents/{agent_id}")
        response.raise_for_status()
        return response.json()

    def get_agents_status(self) -> dict:
        """Get runtime status of all agents with fleet summary.

        Returns {agents: [...], summary: {...}}.
        """
        response = self.client.get("/v1/agents/status")
        response.raise_for_status()
        return response.json()

    def get_agent_status(self, agent_id: str) -> dict:
        """Get runtime status of a specific agent."""
        response = self.client.get(f"/v1/agents/{agent_id}/status")
        response.raise_for_status()
        return response.json()

    def get_agent_runs(self, agent_id: str) -> list[dict]:
        """Get runs the agent participated in."""
        response = self.client.get(f"/v1/agents/{agent_id}/runs")
        response.raise_for_status()
        return response.json()

    def get_agent_memory(self, agent_id: str) -> list[dict]:
        """Get memory files for an agent."""
        response = self.client.get(f"/v1/agents/{agent_id}/memory")
        response.raise_for_status()
        return response.json()

    def get_agent_memory_file(self, agent_id: str, filename: str) -> dict:
        """Get a specific memory file for an agent."""
        response = self.client.get(f"/v1/agents/{agent_id}/memory/{filename}")
        response.raise_for_status()
        return response.json()

    def delete_agent_memory_file(self, agent_id: str, filename: str) -> dict:
        """Delete a memory file from an agent's vault."""
        response = self.client.delete(f"/v1/agents/{agent_id}/memory/{filename}")
        response.raise_for_status()
        return response.json()

    def get_agent_config(self, agent_id: str) -> dict:
        """Get agent configuration."""
        response = self.client.get(f"/v1/agents/{agent_id}/config")
        response.raise_for_status()
        return response.json()

    def update_agent_config(self, agent_id: str, config: dict) -> dict:
        """Update agent configuration."""
        response = self.client.put(f"/v1/agents/{agent_id}/config", json=config)
        response.raise_for_status()
        return response.json()

    def get_agent_projects(self, agent_id: str) -> list[dict]:
        """List projects an agent is assigned to."""
        response = self.client.get(f"/v1/agents/{agent_id}/projects")
        response.raise_for_status()
        return response.json()

    # ── Memory ──────────────────────────────────────────────────────────

    def list_vaults(self) -> list[dict]:
        """List all memory vaults."""
        response = self.client.get("/v1/memory/vaults")
        response.raise_for_status()
        return response.json()

    def list_vault_files(self, agent_id: str) -> list[dict]:
        """List files in a vault."""
        response = self.client.get(f"/v1/memory/vaults/{agent_id}")
        response.raise_for_status()
        return response.json()

    def get_vault_file(self, agent_id: str, filename: str) -> dict:
        """Get a specific file from a vault."""
        response = self.client.get(f"/v1/memory/vaults/{agent_id}/{filename}")
        response.raise_for_status()
        return response.json()

    def search_memory(
        self,
        query: str,
        agent_id: Optional[str] = None,
        limit: int = 20,
    ) -> list[dict]:
        """Search across memory vaults."""
        params: dict = {"q": query, "limit": limit}
        if agent_id:
            params["agent_id"] = agent_id
        response = self.client.get("/v1/memory/search", params=params)
        response.raise_for_status()
        return response.json()

    def delete_vault_file(self, agent_id: str, filename: str) -> dict:
        """Delete a file from a vault (via agents endpoint)."""
        response = self.client.delete(f"/v1/agents/{agent_id}/memory/{filename}")
        response.raise_for_status()
        return response.json()

    # ── Settings / Providers ──────────────────────────────────────────

    def list_providers(self) -> list[dict]:
        """List all model providers and their configuration status.

        Each provider has: providerId, enabled, configured, models[], name, etc.
        """
        response = self.client.get("/v1/settings/providers")
        response.raise_for_status()
        return response.json()

    def get_provider_models(self, provider_id: str) -> dict:
        """Get models for a specific provider (live-fetched if possible).

        Returns {models: [...], source: "live"|"static"}.
        """
        response = self.client.get(f"/v1/settings/providers/{provider_id}/models")
        response.raise_for_status()
        return response.json()

    def get_available_models(self) -> list[dict]:
        """Get all models from configured & enabled providers.

        Returns a flat list of {id, name, provider, provider_id, reasoning} dicts,
        only from providers that have API keys set up.

        For providers whose static catalog has no models (e.g. OpenRouter,
        OpenAI — they fetch live from their APIs), this method calls
        get_provider_models() to retrieve the live list.
        """
        providers = self.list_providers()
        models = []
        for p in providers:
            if not p.get("configured") or not p.get("enabled"):
                continue
            provider_id = p.get("providerId", "")
            provider_name = p.get("name", provider_id)
            provider_models = p.get("models", [])

            # If static catalog is empty, fetch live models from the provider
            if not provider_models:
                try:
                    result = self.get_provider_models(provider_id)
                    provider_models = result.get("models", [])
                except Exception:
                    continue

            for m in provider_models:
                models.append(
                    {
                        "id": m.get("id", ""),
                        "name": m.get("name", m.get("id", "")),
                        "provider": provider_name,
                        "provider_id": provider_id,
                        "reasoning": m.get("reasoning", False),
                    }
                )
        return models

    def upsert_provider(
        self,
        provider_id: str,
        api_key: Optional[str] = None,
        enabled: bool = True,
        extra_config: Optional[dict] = None,
    ) -> dict:
        """Add or update a provider's API key and configuration."""
        payload: dict = {
            "providerId": provider_id,
            "enabled": enabled,
        }
        if api_key:
            payload["apiKey"] = api_key
        if extra_config:
            payload["extraConfig"] = extra_config
        response = self.client.put(
            f"/v1/settings/providers/{provider_id}",
            json=payload,
        )
        response.raise_for_status()
        return response.json()

    def delete_provider(self, provider_id: str) -> dict:
        """Remove a provider configuration (clears stored API key)."""
        response = self.client.delete(f"/v1/settings/providers/{provider_id}")
        response.raise_for_status()
        return response.json()

    # ── Chat ────────────────────────────────────────────────────────────

    def start_chat(
        self,
        agent_id: str,
        model: Optional[str] = None,
        system_prompt_supplement: Optional[str] = None,
    ) -> dict:
        """Start a new chat session with an agent.

        Returns {sessionId, status, message}.
        """
        payload: dict = {}
        if model:
            payload["model"] = model
        if system_prompt_supplement:
            payload["system_prompt_supplement"] = system_prompt_supplement
        response = self.client.post(
            f"/v1/agents/{agent_id}/chat/start",
            json=payload if payload else None,
        )
        response.raise_for_status()
        return response.json()

    def send_chat_message(
        self,
        agent_id: str,
        session_id: str,
        message: str,
        model: Optional[str] = None,
    ) -> dict:
        """Send a message in a chat session.

        Returns {status, sessionId, userMessageId, assistantMessageId}.
        """
        payload: dict = {"message": message}
        if model:
            payload["model"] = model
        response = self.client.post(
            f"/v1/agents/{agent_id}/chat/{session_id}/message",
            json=payload,
        )
        response.raise_for_status()
        return response.json()

    def stop_chat_response(self, agent_id: str, session_id: str) -> dict:
        """Stop current response generation but keep session alive."""
        response = self.client.post(f"/v1/agents/{agent_id}/chat/{session_id}/stop")
        response.raise_for_status()
        return response.json()

    def end_chat(self, agent_id: str, session_id: str) -> dict:
        """End a chat session entirely."""
        response = self.client.post(f"/v1/agents/{agent_id}/chat/{session_id}/end")
        response.raise_for_status()
        return response.json()

    def get_chat_status(self, agent_id: str, session_id: str) -> dict:
        """Get chat session status."""
        response = self.client.get(f"/v1/agents/{agent_id}/chat/{session_id}/status")
        response.raise_for_status()
        return response.json()

    def list_chat_sessions(
        self,
        agent_id: str,
        status: Optional[str] = None,
        limit: int = 20,
    ) -> dict:
        """List chat sessions for an agent.

        Returns {sessions: [...], total, has_more}.
        """
        params: dict = {"limit": limit}
        if status:
            params["status"] = status
        response = self.client.get(
            f"/v1/agents/{agent_id}/chat/sessions", params=params
        )
        response.raise_for_status()
        return response.json()

    # ── Resolve ───────────────────────────────────────────────────────────

    def resolve_issue(
        self,
        issue_url: str,
        project_id: Optional[str] = None,
        model: Optional[str] = None,
    ) -> dict:
        """Start a resolve pipeline run for a GitHub issue.

        Args:
            issue_url: GitHub issue URL or shorthand (owner/repo#123)
            project_id: Optional project ID to link the run to
            model: Optional model override

        Returns:
            {run_id, pipeline_id, issue_number, repo_full_name, issue_title, status}
        """
        payload: dict = {"issue_url": issue_url}
        if project_id:
            payload["project_id"] = project_id
        if model:
            payload["model"] = model
        response = self.client.post("/v1/resolve/", json=payload)
        response.raise_for_status()
        return response.json()

    def parse_issue_url(self, url: str) -> dict:
        """Parse a GitHub issue URL without starting a run.

        Returns:
            {owner, repo, number, full_name}
        """
        response = self.client.get("/v1/resolve/parse", params={"url": url})
        response.raise_for_status()
        return response.json()

    # ── Chat ────────────────────────────────────────────────────────────

    def stream_chat_events(self, session_id: str) -> Iterator[dict]:
        """Stream SSE events for a chat session.

        Yields parsed JSON event dicts. Event types include:
        connected, token, turn_end, tool_start, tool_end,
        session_complete, response_aborted, etc.

        Auth token is passed both as Authorization header and as a
        query parameter (the server accepts ?token= for SSE/WebSocket).
        """
        params = {}
        if self._token:
            params["token"] = self._token
        with httpx.stream(
            "GET",
            f"{self.base_url}/v1/agents/sessions/{session_id}/events",
            timeout=None,
            params=params,
            headers=self._build_headers(),
        ) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if data:
                        try:
                            yield json.loads(data)
                        except json.JSONDecodeError:
                            continue
