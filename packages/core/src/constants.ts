export const DEFAULT_CHAT_MODEL = 'anthropic/claude-sonnet-4';

export const CHAT_MODEL_OPTIONS = [
  { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
  { value: 'anthropic/claude-opus-4', label: 'Claude Opus 4' },
  { value: 'openrouter/moonshotai/kimi-k2.5', label: 'Kimi K2.5' },
  { value: 'openrouter/google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'openrouter/openai/gpt-4o', label: 'GPT-4o' },
] as const;

/**
 * Canonical mapping from provider_id → environment variable that carries the API key.
 * This is the single source of truth used by:
 *   - PiMonoRunner (key injection from DB into process.env)
 *   - ContainerRunner (key injection into container env)
 *   - ChatSessionManager (key injection into chat container env)
 *   - main.ts syncProviderApiKeysToDb (syncing env vars to DB on startup)
 *
 * Matches the env var names that @mariozechner/pi-ai's getEnvApiKey() reads.
 * Reference: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md
 *
 * NOTE: amazon-bedrock and google-vertex are intentionally absent — their auth
 * is not a single env var (Bedrock accepts 6 credential sources; Vertex uses ADC).
 * Use isProviderConfigured() for those instead of a direct env-var lookup.
 */
export const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic:              'ANTHROPIC_API_KEY',
  openai:                 'OPENAI_API_KEY',
  google:                 'GEMINI_API_KEY',
  openrouter:             'OPENROUTER_API_KEY',
  xai:                    'XAI_API_KEY',
  opencode:               'OPENCODE_API_KEY',
  groq:                   'GROQ_API_KEY',
  cerebras:               'CEREBRAS_API_KEY',
  mistral:                'MISTRAL_API_KEY',
  zai:                    'ZAI_API_KEY',
  minimax:                'MINIMAX_API_KEY',
  'minimax-cn':           'MINIMAX_CN_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  'vercel-ai-gateway':    'AI_GATEWAY_API_KEY',
  huggingface:            'HF_TOKEN',
  'kimi-coding':          'KIMI_API_KEY',
  // qmdr: memory search embedding/reranking provider (OpenAI-compatible API)
  // The API key is stored under QMD_OPENAI_API_KEY; extra vars cover base URL,
  // embed model, rerank mode, etc. — all managed via the DB settings UI.
  qmdr:                   'QMD_OPENAI_API_KEY',
};

/**
 * Returns true if the given provider has credentials configured in process.env.
 * Handles providers with non-standard auth (amazon-bedrock, google-vertex) as
 * well as the standard single-env-var providers in PROVIDER_ENV_MAP.
 */
export function isProviderConfigured(provider: string): boolean {
  // Amazon Bedrock: multiple credential sources (matches pi-ai's getEnvApiKey logic)
  if (provider === 'amazon-bedrock') {
    return !!(
      process.env.AWS_PROFILE ||
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_BEARER_TOKEN_BEDROCK ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE
    );
  }

  // Google Vertex: Application Default Credentials
  if (provider === 'google-vertex') {
    return !!(
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      (process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_LOCATION)
    );
  }

  // Standard providers: check single env var
  const envVar = PROVIDER_ENV_MAP[provider];
  return !!(envVar && process.env[envVar]);
}
