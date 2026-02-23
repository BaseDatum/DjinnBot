# Phase 4: Simplification

Clean up Dialog's codebase now that DjinnBot handles intelligence. Remove redundant code paths, unify data models, and strip the Settings UI to its essentials.

## Prerequisites

- Phase 1 complete (ingest pipeline working)
- Phase 2 complete (Grace-powered chat working, local fallback proven)
- Phase 3 complete (all intelligent features route through Grace when connected)

## Tasks

### 4.1 — Slim Down Settings

**Where:** `dialog/VibeTalk/Views/Settings/SettingsSidebar.swift`, `SettingsSections.swift`, `SettingsContainerView.swift`

When connected to DjinnBot, provider API keys become optional (Grace routes through the backend). Simplify the Settings surface:

- Collapse "Providers", "Cloud Models" content into a single "AI" section
- When DjinnBot is connected, show a note: "Chat and post-meeting actions route through DjinnBot. Provider keys are only needed for offline mode rewrites."
- Keep provider key fields for users who want offline dictation rewrites
- Remove redundant model selection fields (backend handles model routing)
- Target: reduce Settings from 9 categories to ~6

**Affected categories:**
- `providers` — merge cloud model config into this section
- `transcription` — keep as-is (local WhisperKit config is still needed)
- `djinnbot` — keep as-is
- `capture`, `output`, `input`, `meetings`, `appearance`, `system` — keep as-is

### 4.2 — Unify Data Models

**Where:** `dialog/VibeTalk/Models/`, `dialog/VibeTalk/Services/Meetings/MeetingStore.swift`

Repurpose `ConversationRecord` (currently unused scaffolding) as the canonical sync format:

- Map `MeetingSessionRecord` → `ConversationRecord` for backend transport
- Map `StandaloneNoteRecord` → `ConversationRecord` for backend transport
- Keep local storage format (`Meetings/*.json`, `Notes/*.json`) unchanged for backward compatibility
- `ConversationRecord` becomes the wire format for `DjinnBotIngestBridge`

**Steps:**
1. Audit `ConversationRecord` fields against `MeetingSessionRecord` and `StandaloneNoteRecord`
2. Add any missing fields (speaker turns, markers, review document)
3. Write mappers: `MeetingSessionRecord.toConversationRecord()`, `StandaloneNoteRecord.toConversationRecord()`
4. Update `DjinnBotIngestBridge` to use `ConversationRecord` as the transport type
5. Delete `ConversationStore` (unused, never wired up)

### 4.3 — Chat History Persistence via Backend

**Where:** `dialog/VibeTalk/Services/Meetings/MeetingChatState.swift`, `DjinnBotService.swift`

When connected, persist chat messages through DjinnBot's existing `ChatSession`/`ChatMessage` models:

- Chat messages sync to the backend as part of Grace's chat session
- Reopening a meeting in Dialog loads prior chat from the backend
- New: `DjinnBotService.loadChatHistory(sessionId:)` — fetches messages for a session
- New: `MeetingChatState.loadPersistedMessages()` — called when browsing a saved meeting
- Offline: chat stays ephemeral as today (in-memory only)

**Backend touches:**
- May need a new endpoint: `GET /v1/ingest/chat-history?meetingId=X` — returns chat messages associated with a meeting's ingest session
- Or: store the Grace session ID in the meeting's ingest response and use the existing `GET /v1/chat-sessions/{id}/messages` endpoint

### 4.4 — Delete Dead Code

**Where:** `dialog/VibeTalk/`

Remove code that's no longer needed after the above changes:

- `ConversationStore.swift` — never imported anywhere, confirmed dead
- `ConversationRecord.swift` — either repurpose (4.2) or delete if not needed
- Meeting-chat-specific provider code paths that are now handled by Grace
- Any duplicate model mapping that emerged from the unification

**Validation:**
```bash
# Verify no references to deleted types
grep -r "ConversationStore" VibeTalk/
# Build and test
swift build && swift test
```

## Design Principles

1. **Backward compatible storage.** Local JSON format stays the same. Users can downgrade without losing data.
2. **Settings reflect reality.** If a feature is handled by the backend, don't show its configuration in Dialog.
3. **Dead code is a liability.** Unused types and stores confuse future contributors and create false search results.
4. **Chat persistence is additive.** It enhances the experience when connected but doesn't break anything when offline.

## Testing

- Verify Settings UI reflects simplified categories
- Verify local storage format is unchanged (open old meeting records)
- Verify `ConversationRecord` mapping is lossless for both meeting and standalone notes
- Verify chat history loads when reopening a meeting (connected mode)
- Verify chat is ephemeral when offline
- Verify deleted code produces no build errors or test failures
- Run `swift build && swift test` — no regressions
