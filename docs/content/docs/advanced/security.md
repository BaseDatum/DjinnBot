---
title: Security Model
weight: 4
---

DjinnBot takes security seriously with container isolation, encrypted secrets, and minimal attack surface.

## Authentication

{{< callout type="warning" >}}
**DjinnBot does not currently include built-in authentication.** The API and dashboard are open to anyone who can reach them on the network. This is fine for local development and private networks, but if you need to expose DjinnBot publicly, you **must** place it behind an authentication proxy.

Recommended options:
- [OAuth2 Proxy](https://oauth2-proxy.github.io/oauth2-proxy/) — supports Google, GitHub, Azure AD, and dozens of other providers
- [Authelia](https://www.authelia.com/) — self-hosted SSO with 2FA
- [Caddy](https://caddyserver.com/) with [caddy-security](https://github.com/greenpau/caddy-security) — simple reverse proxy with built-in auth
- [Nginx](https://nginx.org/) with `auth_request` — forward auth to an external provider
- [Cloudflare Access](https://www.cloudflare.com/products/zero-trust/access/) — zero-trust access without a VPN

Built-in authentication (user accounts, API keys, RBAC) is on the near-term roadmap.
{{< /callout >}}

## Container Isolation

Every agent runs in its own Docker container. This provides:

- **Filesystem isolation** — agents cannot access the host filesystem
- **Process isolation** — agents cannot see or interact with host processes
- **Network isolation** — containers are on a private bridge network
- **No Docker socket** — agent containers cannot spawn other containers
- **Ephemeral execution** — containers are destroyed after each step, leaving no persistent state outside the data volume

The engine container has Docker socket access (required to spawn agent containers), but this is limited to the engine service only. Agent containers receive no Docker socket access.

## Secrets Management

### Encryption at Rest

User-defined secrets (API keys, SSH keys, tokens) are encrypted with AES-256-GCM before storage in PostgreSQL. The encryption key is configured via `SECRET_ENCRYPTION_KEY` in `.env`.

```bash
# Generate a strong encryption key
python3 -c "import secrets; print(secrets.token_hex(32))"
```

{{< callout type="warning" >}}
Without `SECRET_ENCRYPTION_KEY`, secrets are encrypted with an ephemeral key that changes on restart — making stored secrets permanently unrecoverable. Always set this in production.
{{< /callout >}}

### Internal Token (`ENGINE_INTERNAL_TOKEN`)

The plaintext secrets endpoint (`/v1/secrets/agents/{id}/env`) is protected by a shared secret token. The engine and agent containers send this token in the `Authorization: Bearer <token>` header. Without it, the endpoint returns `403 Forbidden`.

```bash
# Generate and add to .env
python3 -c "import secrets; print('ENGINE_INTERNAL_TOKEN=' + secrets.token_urlsafe(32))" >> .env
```

The token is shared between three parties: the API server (validates it), the engine (sends it when fetching secrets and injects it into containers), and agent containers (send it when using the `get_secret` tool at runtime). If `ENGINE_INTERNAL_TOKEN` is not set, the endpoint is unprotected for backward compatibility with local development.

### MCP Proxy Authentication

The mcpo proxy is protected by `MCPO_API_KEY`. Agent containers receive this key to authenticate tool calls. Generate a strong key:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

### Credential Injection

Provider API keys are injected into agent containers as environment variables — they're never baked into images or written to disk. The engine fetches keys from the database and passes them to containers at runtime.

## Network Security

### Default Configuration

The default Docker Compose setup exposes services on localhost:

| Service | Bound To | Port |
|---------|----------|------|
| Dashboard | `0.0.0.0:3000` | 3000 |
| API | `0.0.0.0:8000` | 8000 |
| mcpo | `0.0.0.0:8001` | 8001 |
| PostgreSQL | `0.0.0.0:5432` | 5432 |
| Redis | `0.0.0.0:6379` | 6379 |

### Production Hardening

For production deployments:

1. **Bind to localhost** — change port bindings to `127.0.0.1:PORT:PORT`
2. **Reverse proxy** — put nginx or Caddy in front of the API and dashboard with TLS
3. **Firewall** — block external access to PostgreSQL, Redis, and mcpo ports
4. **Change defaults** — update PostgreSQL password, mcpo API key, and encryption key

### Internal Network

All DjinnBot services communicate on the `djinnbot_default` Docker bridge network. Agent containers are attached to this network for Redis and API access, but cannot reach the host network.

## Comparison with Other Tools

Unlike tools that execute agent code directly on the host:

- DjinnBot agents **cannot access your files** outside their workspace
- DjinnBot agents **cannot read your SSH keys, browser cookies, or environment**
- DjinnBot agents **cannot install packages on your system**
- DjinnBot agents **cannot run as root on your machine**

The container boundary is a hard security line. The worst case scenario is an agent doing damage inside its own ephemeral container, which is destroyed after the step completes.
