---
title: MCP Tools
weight: 6
---

DjinnBot agents can use external tools through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). An [mcpo](https://github.com/skymoore/mcpo) proxy converts MCP tool servers into REST/OpenAPI endpoints that agents call like any other tool.

## How It Works

```
Agent Container → HTTP → mcpo Proxy → stdio → MCP Server
```

1. The mcpo proxy runs as a Docker service (`djinnbot-mcpo`)
2. It reads `mcp/config.json` to discover configured tool servers
3. Each MCP server is exposed as a set of REST endpoints
4. Agents call these endpoints like any other HTTP tool
5. The proxy handles stdio communication with the actual MCP server

## Default Tools

DjinnBot ships with these MCP servers pre-configured:

| Server | Tools | Description |
|--------|-------|------------|
| `github` | Repository browsing, issues, context | GitHub API access (read-only by default) |
| `fetch` | Web page fetching | Retrieve content from URLs |
| `time` | Current time/timezone | Time-aware operations |
| `grokipedia` | Wikipedia search | Knowledge lookup |

## Configuration

MCP servers are configured in `mcp/config.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "/usr/local/bin/github-mcp-server",
      "args": ["stdio", "--read-only", "--toolsets", "context,repos,issues"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "time": {
      "command": "uvx",
      "args": ["mcp-server-time", "--local-timezone=Europe/Lisbon"]
    }
  }
}
```

Each entry specifies:

- **command** — the executable to run
- **args** — command-line arguments
- **env** — environment variables (supports `${VAR}` substitution from the host)

## Adding Tools

### Via Dashboard

1. Go to **MCP Tools** in the dashboard
2. Click **Configure** or **Add Server**
3. Enter the server configuration
4. The proxy hot-reloads — no restart needed

### Via Config File

Edit `mcp/config.json` directly. The proxy watches the file and reloads automatically.

### Via API

```bash
POST /v1/mcp/
{
  "name": "My Tool Server",
  "description": "Does useful things",
  "config": {
    "command": "npx",
    "args": ["my-mcp-server"],
    "env": {}
  },
  "enabled": true
}
```

## Health Monitoring

The engine's McpoManager continuously monitors tool server health:

- On startup, it polls each server endpoint
- Server status (running/error/configuring) is tracked in the database
- Tool discovery extracts available tools from each server's OpenAPI schema
- Logs are streamed to Redis and visible in the dashboard

## Security

The mcpo proxy is protected by an API key (`MCPO_API_KEY` in `.env`). Agent containers receive this key and include it in their requests.

Environment variables in `mcp/config.json` use `${VAR}` syntax — the actual values come from the Docker environment, not the config file. Sensitive tokens never appear in the config.

## Custom MCP Servers

You can add any MCP-compatible tool server. The community maintains hundreds of servers for various APIs and services. Some popular ones:

- **Filesystem** — file operations outside the workspace
- **Postgres/MySQL** — direct database access
- **Slack** — Slack API operations
- **Brave Search** — web search
- **Playwright** — browser automation

See [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) for a comprehensive list.
