# Phase 3: Smarter Features via Grace

Leverage Grace's accumulated knowledge graph to make Dialog proactively useful. Grace stops being reactive (only processing what you send her) and starts anticipating what you need.

## Prerequisites

- Phase 1 complete (ingest pipeline, Grace agent, memories accumulating)
- Phase 2 complete (Grace-powered chat working in Dialog)

## Tasks

### 3.1 — Grace-Powered Post-Meeting Actions

**Where:** `dialog/VibeTalk/Services/Meetings/MeetingChatCoordinator.swift`

Route "Enhance Notes", "Draft Summary", "Draft Email", "Generate Contract", "Create Checklist" through Grace when connected:

- Current: These actions use `MeetingAssistantOrchestrator` which calls LLM providers directly with only the current meeting's transcript + notes as context
- New: Send to Grace via `DjinnBotService.chat()`. Grace has full knowledge graph context, so:
  - "Draft Email" knows the recipient's name, title, and company from prior meetings
  - "Draft Summary" references relevant project context and prior decisions
  - "Enhance Notes" can fill in names and context the user abbreviated
- Keep local `MeetingAssistantOrchestrator` as offline fallback

**Touches:**
- `MeetingChatCoordinator.swift` — `draftPostMeetingSummary`, `draftPostMeetingEmail`, `enhanceHumanNotesWithTranscript`, `runTranscriptAction`, `runDrawerSkill`
- Each gets a `if DjinnBotService.shared.isConfigured` branch that routes to Grace

### 3.2 — Grace Pulse: Commitment Tracking

**Where:** `agents/grace/config.yml`

Enable Grace's pulse routine:

- Set `pulse_enabled: true`
- Set `pulse_interval_minutes: 120` (every 2 hours during business hours)
- Grace wakes up, runs the routine in `PULSE.md`:
  - `recall("commitment deadline")` — find approaching/overdue commitments
  - `recall("action item pending")` — find unresolved action items
  - `recall("follow-up needed")` — find promised follow-ups
  - If anything is overdue or due today, DM the user via Slack
- Only messages the user when there's something actionable

**No Dialog changes needed.** This is purely backend — Grace operates independently and messages via Slack.

### 3.3 — Pre-Meeting Context Briefing

**Where:** `dialog/VibeTalk/Services/DjinnBot/DjinnBotService.swift`, `MeetingSessionManager.swift`

When opening a meeting note that has participant names, fetch context from Grace:

- New endpoint: `POST /v1/ingest/briefing` (or reuse Grace chat) — accepts participant names, returns briefing
- Grace searches her vault for:
  - Prior meetings with those participants
  - Open commitments involving those participants
  - Relevant project status
  - Relationship context (titles, companies, how they connect)
- Display as a subtle context card above the note editor or in the chat rail

**Dialog touches:**
- `MeetingSessionManager` — when loading a meeting record with participants, call `DjinnBotService.fetchBriefing(participants:)`
- New `MeetingBriefingView` — compact card showing Grace's briefing
- Only shows when connected and participants are known

### 3.4 — Meeting Auto-Title via Grace

**Where:** `dialog/VibeTalk/Services/Meetings/MeetingSessionManager.swift`

After meeting ends, send transcript to Grace for intelligent title generation:

- Current: Title is generated locally via `MeetingAssistantOrchestrator` or defaults to "Meeting - [date]"
- New: Grace generates title using knowledge graph context — references known projects, people, and topics
- Example: "Q1 Partnership Review with Sarah Chen (Acme)" instead of "Meeting - Feb 23"
- Fall back to local title generation when offline

**Touches:**
- `MeetingSessionManager` — in the post-recording flow, after ingest, request title from Grace
- `DjinnBotService` — add `generateMeetingTitle(transcript:participants:)` method
- Update the saved record's title when Grace's response arrives (async)

## Design Principles

1. **Grace is the intelligence layer, Dialog is the interface.** Dialog captures and displays. Grace thinks and remembers.
2. **Every feature has an offline fallback.** Connected mode is better, but disconnected mode still works.
3. **Pulse is opt-in.** The user must explicitly enable Grace's pulse in the DjinnBot UI. It's off by default in config.yml.
4. **Briefings are non-blocking.** Pre-meeting context loads in the background. The user can start recording immediately — the briefing appears when ready.
5. **Auto-title is a background enhancement.** The local title shows immediately. Grace's improved title replaces it asynchronously if/when it arrives.

## Testing

- Verify post-meeting actions route through Grace when connected
- Verify post-meeting actions fall back to local when disconnected
- Verify Grace pulse runs on schedule and sends Slack DMs for overdue items
- Verify pre-meeting briefing loads and displays correctly
- Verify auto-title updates the record after Grace responds
- Run `swift build && swift test` — no regressions
