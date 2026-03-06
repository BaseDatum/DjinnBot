---
title: LLM Providers
weight: 1
---

DjinnBot supports a wide range of LLM providers through [pi-mono](https://github.com/badlogic/pi-mono). You can use cloud APIs, local models, or any OpenAI-compatible endpoint.

## Supported Providers

### Cloud Providers

| Provider | Env Variable | Models |
|----------|-------------|--------|
| **OpenRouter** | `OPENROUTER_API_KEY` | All models (Claude, GPT, Gemini, Kimi, Llama, etc.) |
| **Anthropic** | `ANTHROPIC_API_KEY` | Claude Sonnet, Opus, Haiku |
| **OpenAI** | `OPENAI_API_KEY` | GPT-4o, GPT-4, o1, o3 |
| **Google** | `GEMINI_API_KEY` | Gemini 2.5 Pro, Flash |
| **xAI** | `XAI_API_KEY` | Grok 4 |
| **Groq** | `GROQ_API_KEY` | Llama, Mixtral (fast inference) |
| **Mistral** | `MISTRAL_API_KEY` | Mistral Large, Codestral |
| **Cerebras** | `CEREBRAS_API_KEY` | Llama (fast inference) |
| **Azure OpenAI** | `AZURE_OPENAI_API_KEY` | GPT models via Azure |
| **Amazon Bedrock** | AWS credentials | Claude, Llama, Titan |
| **Google Vertex** | GCP ADC | Gemini, PaLM |
| **Hugging Face** | `HF_TOKEN` | Open models via Inference API |

### Why OpenRouter is Recommended

OpenRouter acts as a unified gateway — one API key gives you access to every major model. This means:

- Test different models per agent without managing multiple keys
- Fall back to alternative models if one is down
- Access the latest models as they launch
- Single billing for everything

## Configuring Providers

### Via .env File

Add API keys to your `.env`:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key
ANTHROPIC_API_KEY=sk-ant-your-key
OPENAI_API_KEY=sk-your-key
```

### Via Dashboard

1. Go to **Settings** → **Providers**
2. Enter API keys for each provider
3. Keys are encrypted at rest using `SECRET_ENCRYPTION_KEY`

Dashboard-configured keys take precedence over `.env` keys.

## Model Selection

### Per-Agent

Set the default model in `agents/<id>/config.yml`:

```yaml
model: anthropic/claude-sonnet-4
thinking_model: anthropic/claude-opus-4
thinking_level: medium
```

### Per-Pipeline Step

Override in pipeline YAML:

```yaml
steps:
  - id: SPEC
    agent: eric
    model: anthropic/claude-opus-4    # Use Opus for requirements
  - id: IMPLEMENT
    agent: yukihiro
    model: openrouter/moonshotai/kimi-k2.5  # Use Kimi for coding
```

### Global Defaults

Set in the dashboard Settings page:
- **Default working model** — used when no model is specified
- **Default thinking model** — used for extended reasoning

## Extended Thinking

Some models support extended thinking (reasoning tokens). Configure per-agent:

```yaml
thinking_level: medium    # off, low, medium, high
```

Supported models include Claude Sonnet 4+, Claude Opus 4+, and other reasoning-capable models. The system automatically detects which models support thinking.

## Custom Providers (OpenAI-Compatible)

You can add any OpenAI-compatible endpoint as a custom provider through the dashboard:

1. Go to **Settings** → **Providers**
2. Click **Add Custom Provider**
3. Enter:
   - Provider name/slug
   - Base URL (e.g., `http://localhost:11434/v1` for Ollama)
   - API key (if required)
4. Use the model in agent config: `custom-myollama/llama3.3`

This works with:
- **Ollama** — local models with OpenAI-compatible API
- **LM Studio** — local model runner
- **vLLM** — production inference server
- **text-generation-webui** — with OpenAI extension
- **LocalAI** — drop-in OpenAI replacement
- Any OpenAI-compatible API endpoint

## Local Models via Ollama

To use local models:

1. Install [Ollama](https://ollama.com) on your host
2. Pull a model: `ollama pull llama3.3`
3. Ollama serves at `http://localhost:11434/v1` by default
4. Add as a custom provider in DjinnBot settings:
   - Base URL: `http://host.docker.internal:11434/v1` (use `host.docker.internal` from inside Docker)
   - No API key needed
5. Set agent model: `custom-ollama/llama3.3`

{{< callout type="warning" >}}
Local models work for chat and simple tasks but may not reliably produce structured output or use tools. For production pipeline execution, cloud models (Claude, GPT-4, Kimi) are recommended.
{{< /callout >}}

## Memory Search Provider

ClawVault's semantic search (QMDR) uses a separate provider for embeddings and reranking. By default, this uses OpenRouter with:

- **Embeddings:** `openai/text-embedding-3-small`
- **Reranking:** `openai/gpt-4o-mini` (LLM-based reranking)

Configure via environment variables:

```bash
QMD_OPENAI_API_KEY=${OPENROUTER_API_KEY}
QMD_OPENAI_BASE_URL=https://openrouter.ai/api/v1
QMD_EMBED_PROVIDER=openai
QMD_OPENAI_EMBED_MODEL=openai/text-embedding-3-small
QMD_RERANK_PROVIDER=openai
QMD_RERANK_MODE=llm
QMD_OPENAI_MODEL=openai/gpt-4o-mini
```

These are set in `docker-compose.yml` for the engine service. Adjust if you want to use a different embedding provider.
