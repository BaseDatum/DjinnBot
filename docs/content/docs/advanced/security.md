---
title: Security Model
weight: 4
---

DjinnBot takes security seriously. Container isolation, multi-user authentication with 2FA, encrypted secrets, per-user API key management, and automatic SSL are built into the core — not bolted on as an afterthought.

## Authentication

DjinnBot has a full multi-user authentication system. Enable it by setting `AUTH_ENABLED=true` in `.env`.

### Initial Setup

When authentication is enabled and no users exist yet, the dashboard redirects to a **setup page** where you create the first (admin) account:

{{% steps %}}

### Create admin account

Enter your email, display name, and password (minimum 8 characters).

### Enable two-factor authentication

Scan the QR code with your authenticator app and save the recovery codes. 2FA is strongly recommended for any non-local deployment.

### Start using DjinnBot

You're logged in as admin with full access to all features including user management.

{{% /steps %}}

### Multi-User Support

DjinnBot supports multiple user accounts with different roles:

- **Admin users** — full access to all features, user management, API usage analytics, system configuration
- **Regular users** — access to projects, chat, runs, and personal settings

Additional users can be created through:
- The admin panel in the dashboard
- The API (`POST /v1/users`)
- The waitlist system (users request access, admins approve)

### JWT Authentication

Users authenticate with email and password. The system uses:

- **JWT access tokens** — short-lived (15 min default) for API requests
- **JWT refresh tokens** — longer-lived (7 days default) for session continuity
- **Automatic token refresh** — the dashboard and CLI transparently refresh expired access tokens
- **Session management** — logout invalidates the refresh token server-side
- **2FA state preservation** — 2FA status is maintained across token refresh cycles

### Two-Factor Authentication (TOTP)

Users can enable TOTP-based 2FA from the dashboard Settings page:

1. Go to **Settings > Two-Factor Authentication**
2. Click **Enable 2FA** — a QR code and secret key are displayed
3. Scan with any authenticator app (Google Authenticator, Authy, 1Password, etc.)
4. Enter the 6-digit code to confirm
5. Save the **recovery codes** — one-time-use codes for account recovery

When 2FA is enabled, login requires the TOTP code after email/password. The CLI (`djinn login`) also supports 2FA prompts and recovery codes (enter `r` to use a recovery code).

### API Keys

Users can generate API keys from the dashboard (**Settings > API Keys**) for programmatic access and CLI authentication:

- Scoped to the user who created them
- Named for identification (e.g., "CI/CD", "CLI", "Automation")
- Work with `Authorization: Bearer <key>` header
- Can be used with `djinn login --api-key <key>` for CLI auth

The `ENGINE_INTERNAL_TOKEN` is also accepted as a first-class API key for service-to-service communication.

### OIDC Single Sign-On

DjinnBot supports external identity providers via OpenID Connect (OIDC). Configure OIDC providers through the dashboard (**Settings > OIDC Providers**) with:

- Provider name and issuer URL
- Client ID and client secret
- Auto-discovery via `.well-known/openid-configuration`

Users can then log in via their organization's identity provider (Google Workspace, Azure AD, Okta, etc.) through the `/auth/callback` route.

### Per-User API Key Sharing

Users can configure their own LLM provider API keys through the dashboard (**Settings > Provider Keys**). When a user has a personal key configured:

1. Their sessions use their personal key instead of the system key
2. **Key resolution** is tracked per-session — the dashboard shows a badge indicating which key was used (system, user, or agent override)
3. Admins can see aggregate usage broken down by key source
4. Share limits can be enforced to control user-provided key usage

This enables teams to share a DjinnBot instance while individual users bring their own API keys for cost management.

### CLI Authentication

The CLI stores credentials per server URL in `~/.config/djinnbot/auth.json` (mode `0600`):

```bash
djinn login                    # Interactive (email/password + optional 2FA)
djinn login --api-key <key>    # Login with an API key
djinn whoami                   # Check current user
djinn logout                   # Clear credentials and invalidate session
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

User-defined secrets (API keys, SSH keys, tokens) are encrypted with AES-256-GCM before storage in PostgreSQL:

- 256-bit key derived from `SECRET_ENCRYPTION_KEY`
- Random 96-bit nonce per encryption operation
- 128-bit authentication tag (GCM default)
- Storage format: `base64(nonce[12] + tag[16] + ciphertext)`

```bash
# Generate a strong encryption key
python3 -c "import secrets; print(secrets.token_hex(32))"
```

{{< callout type="warning" >}}
Without `SECRET_ENCRYPTION_KEY`, secrets are encrypted with an ephemeral key that changes on restart — making stored secrets permanently unrecoverable. Always set this in production. The `djinn setup` wizard generates this automatically.
{{< /callout >}}

### Internal Token (`ENGINE_INTERNAL_TOKEN`)

The plaintext secrets endpoint (`/v1/secrets/agents/{id}/env`) is protected by a shared secret token. Without it, the endpoint returns `403 Forbidden`.

The token is shared between three parties:
1. **API server** — validates the token
2. **Engine** — sends it when fetching secrets, injects it into agent containers
3. **Agent containers** — send it when using the `get_secret` tool at runtime

When `AUTH_ENABLED=true`, this token is **required** — the server refuses to start without it.

### Credential Injection

Provider API keys are injected into agent containers as environment variables — they're never baked into images or written to disk. The engine fetches keys from the database (resolving user vs. system keys) and passes them to containers at runtime.

## Network Security

### Default Configuration

| Service | Bound To | Port |
|---------|----------|------|
| Dashboard | `${BIND_HOST}:3000` | 3000 |
| API | `${BIND_HOST}:8000` | 8000 |
| mcpo | `${BIND_HOST}:8001` | 8001 |
| PostgreSQL | `${BIND_HOST}:5432` | 5432 |
| Redis | `${BIND_HOST}:6379` | 6379 |

`BIND_HOST` defaults to `0.0.0.0`. When using Traefik for SSL, it's set to `127.0.0.1` so only the reverse proxy is publicly accessible.

### Production Hardening

{{% steps %}}

### Enable authentication

Set `AUTH_ENABLED=true` and generate all required secrets.

### Enable SSL

Use Traefik (`djinn setup` configures this) or your own reverse proxy with TLS.

### Bind to localhost

Set `BIND_HOST=127.0.0.1` when behind a reverse proxy.

### Configure firewall

Block external access to PostgreSQL (5432), Redis (6379), and mcpo (8001) ports.

### Change defaults

Update PostgreSQL password, mcpo API key, and encryption key.

### Enable 2FA

Create your admin account with two-factor authentication enabled.

{{% /steps %}}

### SSL/TLS with Traefik

DjinnBot includes a Traefik reverse proxy stack (`proxy/docker-compose.yml`) that provides:

- Automatic Let's Encrypt certificate issuance and renewal
- HTTP to HTTPS redirection
- Proper SSE streaming support (flush interval configuration)
- Separate Docker network for proxy isolation

See [Installation](/docs/getting-started/installation#ssltls-with-traefik) for setup instructions.

## Comparison with Other Tools

Unlike tools that execute agent code directly on the host:

- DjinnBot agents **cannot access your files** outside their workspace
- DjinnBot agents **cannot read your SSH keys, browser cookies, or environment**
- DjinnBot agents **cannot install packages on your system**
- DjinnBot agents **cannot run as root on your machine**

The container boundary is a hard security line. The worst case scenario is an agent doing damage inside its own ephemeral container — which is destroyed after the step completes.
