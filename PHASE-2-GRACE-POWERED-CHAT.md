# Phase 2: Grace-Powered Chat

Route Dialog's workspace chat through Grace when connected to DjinnBot, giving responses grounded in the full knowledge graph rather than just the current meeting's transcript.

## Prerequisites

- Phase 1 complete (ingest endpoints, DjinnBotService, Grace agent)
- Grace has accumulated memories from at least a few ingested meetings

## Architecture

```
Dialog Chat Input                         DjinnBot Backend
                                          
User types message  ──────────────────→   Grace chat session
  @grace prefix (explicit)                  - recall relevant memories
  or default route (when connected)         - respond with full context
                                            - grounded in ALL prior meetings
  ←───────────────────────────────────    SSE token stream back to Dialog
                                          
Offline fallback:                         
  Local MeetingAssistantOrchestrator      
  + MeetingChatResponder (keyword match)  
```

## Tasks

### 2.1 — `@grace` Chat Prefix

**Where:** `dialog/VibeTalk/Services/Meetings/MeetingChatState.swift`

Add a new `RoutingDirective` case and handle it in `resolvedRouting(for:)`:

- `.grace(query: String, userMessage: String)` — when input starts with `@grace`
- Route to `DjinnBotService` which sends the message to Grace's chat session
- Grace has full knowledge graph context from all prior meetings, notes, dictations
- Return Grace's response as a chat message

**Also touches:**
- `MeetingChatCoordinator.swift` — add `sendGraceQuery()` method
- `DjinnBotService.swift` — add `chat(message:)` method that sends to Grace and returns response via SSE

### 2.2 — Grace as Default Chat When Connected

**Where:** `dialog/VibeTalk/Services/Meetings/MeetingChatState.swift`

Change the `defaultRoute` case in `resolvedRouting`:

- When `DjinnBotService.shared.isConfigured` is true, route default messages through Grace instead of local `MeetingAssistantOrchestrator`
- `@meeting` still uses local context only (for speed during live recording)
- `@history` and `@all` use Grace (semantic search > keyword matching)
- When offline/disconnected, fall back to existing local behavior

### 2.3 — Chat Response Streaming

**Where:** `dialog/VibeTalk/Services/DjinnBot/DjinnBotService.swift`

Add SSE streaming support for Grace's chat responses:

- Subscribe to the Redis-backed SSE stream for the active chat session
- Parse token deltas as they arrive
- Deliver tokens to `MeetingChatState` incrementally
- Display in chat UI as tokens arrive, not as a single block

**Approach:**
- Use `URLSession.AsyncBytes` for SSE parsing
- New `DjinnBotChatStream` helper that handles reconnection and parsing
- `MeetingChatState` gets a `@Published var streamingAssistantText: String` for live updates

### 2.4 — Grace-Powered `@history`

**Where:** `dialog/VibeTalk/Services/Meetings/MeetingChatCoordinator.swift`

Replace the local `sendHistoryQuery` implementation:

- Current: `MeetingStore.searchCatalog` (keyword match on metadata) → load up to 6 records → stuff into LLM context → query
- New: Send query to Grace → Grace searches her vault semantically → responds with grounded answer
- Keep local path as fallback when disconnected

**Why this is better:** Grace can search across hundreds of meetings using vector similarity, not just keyword matching on titles. She also has structured memories (decisions, commitments, people) that raw transcript search misses.

## Design Principles

1. **`@grace` first, then default.** Ship the explicit prefix first so users can A/B test the quality difference. Once validated, make it the default.
2. **`@meeting` stays local.** During live recording, latency matters. Local transcript + LLM is faster than round-tripping to the backend.
3. **`MeetingChatResponder` is the eternal fallback.** The crude keyword-matching local responder stays forever. It works offline with zero dependencies.
4. **Streaming is required.** Grace's responses can be long (she's thorough). Blocking until the full response is ready is unacceptable UX.

## Testing

- Verify `@grace` routes to backend and returns a response
- Verify default routing changes when `isConfigured` is true vs false
- Verify offline fallback works when backend is unreachable
- Verify `@meeting` still uses local context during live recording
- Verify streaming displays tokens incrementally
- Run `swift build && swift test` — no regressions
