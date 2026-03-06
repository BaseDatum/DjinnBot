---
title: Voice — STT & TTS
weight: 14
---

DjinnBot supports bidirectional voice: incoming voice messages are transcribed to text (STT), and agent responses can be spoken back as audio (TTS). This works across all messaging channels — Telegram, Discord, WhatsApp, Signal, Slack, and the dashboard.

## Architecture Overview

```mermaid
graph LR
    Voice["Voice message"] --> STT["STT (faster-whisper)"]
    STT --> Agent["Agent"]
    Agent --> TTS["TTS (Fish Audio / Voicebox)"]
    TTS --> Audio["Audio reply"]

    style Voice fill:#3b82f6,color:#fff
    style STT fill:#8b5cf6,color:#fff
    style Agent fill:#f59e0b,color:#fff
    style TTS fill:#8b5cf6,color:#fff
    style Audio fill:#10b981,color:#fff
```

Voice messages received on any channel are transcribed server-side at upload time. The transcript is stored as `extracted_text` on the attachment record, so agents read it as plain text — no special handling needed. If TTS is enabled for the agent, the response is synthesized back to audio and delivered as a native voice message on the channel.

## Speech-to-Text (STT)

### Engine: faster-whisper

STT uses [faster-whisper](https://github.com/SYSTRAN/faster-whisper), a CTranslate2-based reimplementation of OpenAI's Whisper. It runs approximately 4x faster than the original Python Whisper on CPU.

**Model:** `base` by default (~150 MB). Override with the `WHISPER_MODEL_SIZE` environment variable.

**Performance:** ~3-5 seconds per 30-second clip on CPU with INT8 quantization.

**Features:**
- Automatic language detection
- VAD (Voice Activity Detection) filtering to skip silence
- Lazy model loading — the model is downloaded on first use and cached

### Model Caching

The whisper model is persisted on JuiceFS at `/jfs/cache/whisper-models` so it survives container restarts without re-downloading. If JuiceFS is not mounted, it falls back to the default HuggingFace cache directory (ephemeral — re-downloads on restart).

Override the cache directory with the `WHISPER_MODEL_DIR` environment variable.

### How It Works

1. A voice message arrives on any channel (Telegram, Discord, WhatsApp, Signal, Slack)
2. The audio is uploaded and stored as a `ChatAttachment`
3. A background task converts the audio to 16kHz mono WAV via ffmpeg
4. faster-whisper transcribes the WAV with beam search (beam_size=5) and VAD filtering
5. The transcript is saved as `extracted_text` on the attachment
6. The agent receives the transcript as normal text input

No agent-side configuration is needed — STT happens automatically for all audio attachments.

## Text-to-Speech (TTS)

TTS converts agent text responses into audio. Two providers are supported:

| Provider | Type | Model | Cost | Latency |
|----------|------|-------|------|---------|
| **Fish Audio** | Cloud API | S1 | $15 / 1M UTF-8 bytes | Low (cloud) |
| **Voicebox** | Local (self-hosted) | Qwen3-TTS | Free | Depends on GPU |

### Fish Audio

[Fish Audio](https://fish.audio) is the default cloud TTS provider. It uses the S1 model and supports voice cloning via reference IDs.

**Setup:**
1. Get an API key from [fish.audio](https://fish.audio)
2. Add it in the dashboard under **Settings > TTS Providers > Fish Audio**
3. Or set it as an instance-level key via the admin panel

**Voice selection:** Fish Audio has a library of pre-built voices. Voices are browsable in the dashboard when configuring per-agent TTS settings. You can also use custom voice clones by providing a reference ID.

**API key resolution** follows the same priority chain as LLM keys:
1. User's own key (from per-user TTS provider settings)
2. Admin-shared key (granted by an admin to specific users or all users)
3. Instance-level key (global fallback)

**Cost calculation:** $15.00 per 1M UTF-8 bytes of input text. Costs are logged per-call in the `tts_call_logs` table and visible in the dashboard.

### Voicebox

[Voicebox](https://github.com/jamiepine/voicebox) is a local TTS server that runs Qwen3-TTS. It generates speech on your own hardware — no API key needed, no per-call cost.

**Setup:**
1. Install and run Voicebox (see the [Voicebox repo](https://github.com/jamiepine/voicebox))
2. In the dashboard under **Settings > TTS**, set the default provider to **Voicebox (Local)**
3. Configure the Voicebox URL (default: `http://localhost:8000`)
4. Use the health check in the dashboard to verify connectivity

**How Voicebox synthesis works:**
1. DjinnBot sends a `POST /generate` request with the text and optional voice profile ID
2. Voicebox returns a generation ID
3. DjinnBot fetches the audio via `GET /audio/{generation_id}`
4. The WAV output is converted to the channel's target format via ffmpeg

**Voice profiles:** Voicebox supports voice profiles. Select a profile in the per-agent TTS settings or let it use the default voice.

### Channel Audio Formats

Each messaging platform has its own preferred audio format. DjinnBot handles conversion automatically via ffmpeg:

| Channel | Format | Notes |
|---------|--------|-------|
| Telegram | OGG/Opus | Required for native voice messages |
| WhatsApp | OGG/Opus | Required for push-to-talk voice notes |
| Discord | OGG/Opus | Standard voice message format |
| Slack | MP3 | Native audio attachment |
| Signal | MP3 | Handles MP3 attachments |
| Dashboard | MP3 | Universal web playback |

For Fish Audio, audio is requested as MP3 and converted to OGG/Opus where needed (container remux via ffmpeg — no transcoding). Voicebox outputs WAV, which is transcoded to the target format.

### Per-Agent TTS Configuration

TTS is configured per-agent in the database (not YAML), so settings persist across container restarts. Each agent has:

| Setting | Description |
|---------|-------------|
| `tts_enabled` | Whether this agent generates voice replies |
| `tts_provider` | `fish-audio` or `voicebox` (overrides the global default) |
| `tts_voice_id` | Voice/profile ID for this agent |
| `tts_voice_name` | Display name of the selected voice |

Configure these in the dashboard under **Agents > [Agent Name] > TTS Settings**.

### When TTS Triggers

TTS is not generated for every response. It triggers when **all** of these conditions are met:

1. The incoming message was a **voice message** (voice-in, voice-out)
2. The agent has `tts_enabled: true` in its DB settings
3. TTS is **globally enabled** in admin settings
4. The response text is within the **character threshold** (default: 1000 characters)

This means agents only speak back when spoken to — text messages always get text replies.

### Global TTS Settings

Admins control TTS behavior from the dashboard (**Settings > TTS**):

| Setting | Default | Description |
|---------|---------|-------------|
| `ttsEnabled` | `true` | Global kill switch for all TTS |
| `defaultTtsProvider` | `fish-audio` | Default provider when no agent/user override exists |
| `ttsCharacterThreshold` | `1000` | Max response length that will be synthesized |
| `ttsMaxConcurrentRequests` | `5` | Concurrency limit (semaphore) for TTS API calls |
| `voiceboxUrl` | `http://localhost:8000` | Base URL of the Voicebox instance |

### Provider Resolution

When generating TTS, the provider is resolved in priority order:

1. **Agent DB settings** — per-agent `tts_provider` override
2. **User preference** — per-user default stored in global settings
3. **Admin default** — the `defaultTtsProvider` global setting
4. **Fallback** — `fish-audio`

### Rate Limiting & Cost Tracking

- A global semaphore limits concurrent TTS requests (configurable via `ttsMaxConcurrentRequests`)
- Every TTS call is logged to the `tts_call_logs` table with: provider, model, input size, output size, cost, latency, channel, and key source
- Logs are published to Redis (`djinnbot:tts-calls:live`) for real-time SSE streaming in the dashboard
- Fish Audio costs are calculated at $15.00 / 1M UTF-8 bytes; Voicebox calls are always $0

### API Endpoints

Key TTS-related endpoints under `/v1`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tts/voices` | List Fish Audio voices (proxied) |
| `GET` | `/tts/voices/{voice_id}` | Get Fish Audio voice details |
| `GET` | `/tts/voicebox/profiles` | List Voicebox voice profiles |
| `GET` | `/tts/voicebox/health` | Check Voicebox connectivity |
| `POST` | `/internal/tts/synthesize` | Generate speech (internal, called by engine) |
| `GET` | `/tts-calls` | Query TTS call logs |
| `GET` | `/agents/{agent_id}/tts-settings` | Get agent TTS settings |
| `PUT` | `/agents/{agent_id}/tts-settings` | Update agent TTS settings |
| `GET` | `/admin/tts-settings` | Get global TTS settings |
| `PUT` | `/admin/tts-settings` | Update global TTS settings |

## Dependencies

- **ffmpeg** — required for audio format conversion (STT and TTS)
- **faster-whisper** — Python package for STT (`pip install faster-whisper`)
- **fishaudio** — Python SDK for Fish Audio TTS (`pip install fishaudio`)
- **Voicebox** — optional, self-hosted TTS server (separate install)
