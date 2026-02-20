"""Shared constants for the djinnbot API."""

# Default model for chat sessions
DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4"

# Available chat models (for validation/documentation)
CHAT_MODEL_OPTIONS = [
    "anthropic/claude-sonnet-4",
    "anthropic/claude-opus-4",
    "openrouter/moonshotai/kimi-k2.5",
    "openrouter/google/gemini-2.5-pro",
    "openrouter/openai/gpt-4o",
]
