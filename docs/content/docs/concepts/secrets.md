---
title: Secrets Management
weight: 9
---

DjinnBot includes a built-in secrets management system for storing sensitive values — API keys, tokens, SSH keys, and other credentials — that agents need during execution.

## How It Works

Secrets are stored in PostgreSQL, encrypted at rest with **AES-256-GCM**. The encryption scheme uses:

- 256-bit key derived from the `SECRET_ENCRYPTION_KEY` environment variable
- Random 96-bit nonce per encryption operation
- 128-bit authentication tag (GCM default)
- Storage format: `base64(nonce[12] + tag[16] + ciphertext)`

Plaintext secret values are **never** returned by the API to the dashboard or any external client. All list and detail endpoints return masked previews only (e.g., `ghp_...abc1`).

## Secret Types

Secrets support different types to help organize credentials:

- **API keys** — third-party service credentials
- **Tokens** — GitHub PATs, OAuth tokens, etc.
- **SSH keys** — for git operations or server access
- **Custom** — any sensitive value

## Agent Access Control

Secrets are **not** globally available to all agents. You explicitly grant each secret to specific agents:

1. Create a secret in the dashboard or via API
2. Grant the secret to one or more agents
3. Only granted agents receive the secret in their container environment

This prevents agents from accessing credentials they don't need.

## How Secrets Reach Agents

When the engine spawns an agent container:

1. It calls the internal endpoint `GET /v1/secrets/agents/{agent_id}/env`
2. The API decrypts the agent's granted secrets and returns them as an environment variable map
3. The engine injects these as environment variables into the container

This is the **only** endpoint that returns plaintext values, and it's an internal endpoint called only by the engine — not exposed to the dashboard or external clients.

## Managing Secrets

### Via Dashboard

1. Go to **Settings** in the dashboard
2. Navigate to the **Secrets** section
3. Create, update, or delete secrets
4. Grant or revoke agent access

### Via API

```bash
# List secrets (masked, no plaintext)
GET /v1/secrets/

# Create a secret
POST /v1/secrets/
{
  "name": "GITHUB_TOKEN",
  "description": "GitHub PAT for repo access",
  "secret_type": "token",
  "value": "ghp_actual_secret_value"
}

# Grant to an agent
POST /v1/secrets/{secret_id}/grant/{agent_id}

# Revoke from an agent
DELETE /v1/secrets/{secret_id}/grant/{agent_id}

# List secrets granted to an agent (masked)
GET /v1/secrets/agents/{agent_id}

# Delete a secret (and all its grants)
DELETE /v1/secrets/{secret_id}
```

## Encryption Key

The encryption key is configured via the `SECRET_ENCRYPTION_KEY` environment variable:

```bash
# Generate a strong key
python3 -c "import secrets; print(secrets.token_hex(32))"
```

{{< callout type="warning" >}}
**Production requirement:** Without `SECRET_ENCRYPTION_KEY` set, the system auto-generates an ephemeral key on first use. This key is lost if the database is reset or the service restarts without persisting it, making all stored secrets **permanently unrecoverable**. Always set this variable in production.
{{< /callout >}}

## Security Properties

- Secrets are encrypted before touching the database — PostgreSQL never sees plaintext
- Each encryption uses a unique random nonce — identical secrets produce different ciphertexts
- GCM authentication tags prevent tampering — any modification is detected on decryption
- The dashboard and API only expose masked previews — you can verify a secret exists without seeing its value
- Agent containers receive secrets only at spawn time via environment variables — they're not written to disk inside the container
