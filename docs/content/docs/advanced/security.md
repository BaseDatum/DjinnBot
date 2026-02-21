---
title: Security Model
weight: 4
---

DjinnBot includes built-in authentication, container isolation, encrypted secrets, and optional SSL/TLS with automatic certificates.

## Authentication

DjinnBot has a full authentication system that protects the API and dashboard. Enable it by setting `AUTH_ENABLED=true` in `.env`.

### Initial Setup

When authentication is enabled and no users exist yet, the dashboard redirects to a **setup page** where you create the first (admin) account:

1. Enter your email, display name, and password (minimum 8 characters)
2. Optionally enable two-factor authentication (recommended)
3. If 2FA is enabled, scan the QR code with your authenticator app and save the recovery codes

The `djinn setup` wizard prompts you to enable auth during installation.

### User Accounts

Users authenticate with email and password. The system supports:

- **JWT tokens** — short-lived access tokens (15 min default) with refresh tokens (7 days default)
- **Automatic token refresh** — the dashboard and CLI transparently refresh expired access tokens
- **Session management** — logout invalidates the refresh token server-side

### Two-Factor Authentication (TOTP)

Users can enable TOTP-based 2FA from the dashboard Settings page:

1. Go to **Settings > Two-Factor Authentication**
2. Click **Enable 2FA** — a QR code and secret key are displayed
3. Scan with any authenticator app (Google Authenticator, Authy, 1Password, etc.)
4. Enter the 6-digit code to confirm
5. Save the **recovery codes** — these are one-time-use codes for account recovery if you lose your authenticator

When 2FA is enabled, login requires the TOTP code after email/password. The CLI (`djinn login`) also supports 2FA prompts and recovery codes.

The issuer name shown in authenticator apps is configured via `AUTH_TOTP_ISSUER` (default: `DjinnBot`).

### API Keys

Users can generate API keys from the dashboard (**Settings > API Keys**) for programmatic access and CLI authentication. API keys:

- Are scoped to the user who created them
- Can be named for identification (e.g., "CI/CD", "CLI")
- Work with `Authorization: Bearer <key>` header
- Can be used with `djinn login --api-key <key>` for CLI auth

The `ENGINE_INTERNAL_TOKEN` is also accepted as a first-class API key when auth is enabled, for service-to-service communication.

### OIDC Single Sign-On

DjinnBot supports external identity providers via OpenID Connect (OIDC). Configure OIDC providers through the dashboard (**Settings > OIDC Providers**) with:

- Provider name and issuer URL
- Client ID and client secret
- Auto-discovery via `.well-known/openid-configuration`

Users can then log in via their organization's identity provider (Google Workspace, Azure AD, Okta, etc.) through the `/auth/callback` route.

### CLI Authentication

The CLI stores credentials per server URL in `~/.config/djinnbot/auth.json` (mode `0600`):

```bash
# Interactive login (email/password + optional 2FA)
djinn login

# Login with an API key
djinn login --api-key <key>

# Check current user
djinn whoami

# Log out (clears local credentials and invalidates server session)
djinn logout
```

Token resolution order: `--api-key` flag > `DJINNBOT_API_KEY` env var > stored credentials.

### Disabling Authentication

For local development, set `AUTH_ENABLED=false` in `.env`. All requests are allowed without credentials. This is the default.

{{< callout type="warning" >}}
Never run with `AUTH_ENABLED=false` on a publicly accessible server. Anyone who can reach the API has full access to all data and agents.
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
Without `SECRET_ENCRYPTION_KEY`, secrets are encrypted with an ephemeral key that changes on restart — making stored secrets permanently unrecoverable. Always set this in production. The `djinn setup` wizard generates this automatically.
{{< /callout >}}

### Internal Token (`ENGINE_INTERNAL_TOKEN`)

The plaintext secrets endpoint (`/v1/secrets/agents/{id}/env`) is protected by a shared secret token. The engine and agent containers send this token in the `Authorization: Bearer <token>` header. Without it, the endpoint returns `403 Forbidden`.

```bash
# Generate and add to .env
python3 -c "import secrets; print('ENGINE_INTERNAL_TOKEN=' + secrets.token_urlsafe(32))" >> .env
```

The token is shared between three parties: the API server (validates it), the engine (sends it when fetching secrets and injects it into containers), and agent containers (send it when using the `get_secret` tool at runtime).

When `AUTH_ENABLED=true`, this token is **required** — the server refuses to start without it. It also doubles as a service-level API key for internal requests.

### MCP Proxy Authentication

The mcpo proxy is protected by `MCPO_API_KEY`. Agent containers receive this key to authenticate tool calls. Generate a strong key:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

### Credential Injection

Provider API keys are injected into agent containers as environment variables — they're never baked into images or written to disk. The engine fetches keys from the database and passes them to containers at runtime.

## Network Security

### Default Configuration

The default Docker Compose setup exposes services on all interfaces:

| Service | Bound To | Port |
|---------|----------|------|
| Dashboard | `${BIND_HOST}:3000` | 3000 |
| API | `${BIND_HOST}:8000` | 8000 |
| mcpo | `${BIND_HOST}:8001` | 8001 |
| PostgreSQL | `${BIND_HOST}:5432` | 5432 |
| Redis | `${BIND_HOST}:6379` | 6379 |

`BIND_HOST` defaults to `0.0.0.0`. When using Traefik for SSL, it's set to `127.0.0.1` so only the reverse proxy is publicly accessible.

### Production Hardening

For production deployments:

1. **Enable authentication** — set `AUTH_ENABLED=true` and generate all required secrets
2. **Enable SSL** — use Traefik (`djinn setup` configures this) or your own reverse proxy with TLS
3. **Bind to localhost** — set `BIND_HOST=127.0.0.1` when behind a reverse proxy
4. **Firewall** — block external access to PostgreSQL (5432), Redis (6379), and mcpo (8001) ports
5. **Change defaults** — update PostgreSQL password, mcpo API key, and encryption key
6. **Enable 2FA** — create your admin account with two-factor authentication enabled

### SSL/TLS with Traefik

DjinnBot includes a Traefik reverse proxy stack (`proxy/docker-compose.yml`) that provides:

- Automatic Let's Encrypt certificate issuance and renewal
- HTTP to HTTPS redirection
- Proper SSE streaming support (flush interval configuration)
- Separate Docker network for proxy isolation

See [Installation](/docs/getting-started/installation#ssltls-with-traefik) for setup instructions.

### Internal Network

All DjinnBot services communicate on the `djinnbot_default` Docker bridge network. Agent containers are attached to this network for Redis and API access, but cannot reach the host network.

## Comparison with Other Tools

Unlike tools that execute agent code directly on the host:

- DjinnBot agents **cannot access your files** outside their workspace
- DjinnBot agents **cannot read your SSH keys, browser cookies, or environment**
- DjinnBot agents **cannot install packages on your system**
- DjinnBot agents **cannot run as root on your machine**

The container boundary is a hard security line. The worst case scenario is an agent doing damage inside its own ephemeral container, which is destroyed after the step completes.
