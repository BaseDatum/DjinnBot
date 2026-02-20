---
title: Bot Interfaces
weight: 2
---

DjinnBot agents can interact through multiple interfaces. Currently Slack and the built-in dashboard chat are supported, with more platforms planned.

## Current Interfaces

### Dashboard Chat

The built-in chat interface at `http://localhost:3000/chat` requires no additional setup. Features:

- Select any agent and model
- Full tool access (code execution, file operations, web research)
- Persistent chat history
- Real-time streaming responses
- Supports onboarding and project-context sessions

This is the primary interface for users who don't use Slack.

### Slack

Each agent gets its own Slack bot via Socket Mode. See [Slack Bot Setup](/docs/guides/slack-setup) for configuration.

Features:
- Per-agent bot identity (name, avatar)
- Pipeline threads (watch agents collaborate)
- Direct mentions and DMs
- Active/passive thread participation

## Planned Interfaces

### Discord

Discord bot support is on the roadmap. The architecture mirrors Slack — each agent gets its own bot account, pipeline runs create threads, and agents respond to mentions.

### Microsoft Teams

Teams integration is planned for enterprise environments that standardize on the Microsoft ecosystem.

### Custom Webhooks

A generic webhook interface will allow integration with any chat platform or custom application. Send messages in, receive agent responses out, via simple HTTP.

### API-Only

The REST API and SSE streaming already allow building custom frontends. Any application that can make HTTP requests can interact with DjinnBot agents.

## Architecture for New Interfaces

Adding a new chat interface involves:

1. **Bridge service** — connects to the external platform's API (similar to `packages/slack/`)
2. **Event routing** — maps platform events to DjinnBot's event bus
3. **Per-agent identity** — manages bot accounts/tokens for each agent
4. **Thread mapping** — links platform threads to pipeline runs

The engine's event-driven architecture makes this straightforward — new interfaces subscribe to Redis events and publish commands back.

## Contributing an Interface

If you want to add support for a new platform, the Slack package (`packages/slack/`) is the reference implementation. The key files:

- `slack-bridge.ts` — routes events between Slack and the engine
- `agent-slack-runtime.ts` — manages per-agent Socket Mode connections
- `thread-manager.ts` — maps runs to Slack threads
- `slack-streamer.ts` — streams agent output to Slack messages

A new interface would implement the same patterns for a different platform.
