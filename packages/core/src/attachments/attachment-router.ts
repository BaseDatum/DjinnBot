/**
 * Smart Attachment Router — decides the most token-efficient strategy
 * for each attachment based on its type, size, and the current model's
 * capabilities.
 *
 * Routing strategies:
 *  - inline:          Small text/code files injected directly as context
 *  - vault_reference: PDFs and large documents referenced via vault (not inlined)
 *  - suggest_swap:    Image sent to a non-vision model → suggest model switch
 *  - transcribe:      Audio files → text transcription via whisper.cpp
 *  - unsupported:     File type we cannot process
 */

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  estimatedTokens?: number;
}

// ── Routing decisions ────────────────────────────────────────────────────────

export type AttachmentRoute =
  | InlineRoute
  | VaultReferenceRoute
  | SuggestSwapRoute
  | UnsupportedRoute;

export interface InlineRoute {
  strategy: 'inline';
  attachment: AttachmentMeta;
}

export interface VaultReferenceRoute {
  strategy: 'vault_reference';
  attachment: AttachmentMeta;
  /** Human-readable note to inject as context instead of full text */
  contextNote: string;
}

export interface SuggestSwapRoute {
  strategy: 'suggest_swap';
  attachment: AttachmentMeta;
  requiredCapability: 'vision';
  /** Suggested vision-capable models the user could switch to */
  suggestedModels: string[];
}

export interface UnsupportedRoute {
  strategy: 'unsupported';
  attachment: AttachmentMeta;
  reason: string;
}

// ── Model capabilities ──────────────────────────────────────────────────────

export interface ModelCapabilities {
  vision: boolean;
  audio: boolean;
}

/**
 * Providers whose modern models are known to support vision (image input).
 * Matches the VISION_CAPABLE_PROVIDERS set in model-resolver.ts.
 */
const VISION_CAPABLE_PROVIDERS = new Set([
  'xai', 'openai', 'anthropic', 'google', 'opencode', 'openrouter',
]);

/**
 * Extract model capabilities from a "provider/model-id" string.
 *
 * This is a best-effort heuristic — we check the provider against known
 * vision-capable providers and the model's input array if available.
 */
export function getModelCapabilities(modelString: string): ModelCapabilities {
  const parts = modelString.split('/');
  const provider = parts[0] ?? '';

  // OpenRouter models are generally vision-capable (the router handles it)
  // Custom providers are assumed text-only unless proven otherwise
  const vision = VISION_CAPABLE_PROVIDERS.has(provider) ||
    provider.startsWith('openrouter');

  return {
    vision,
    audio: false, // Future: Gemini/GPT-4o audio input
  };
}

// ── Routing thresholds ──────────────────────────────────────────────────────

/** Below this token count, inline the text directly */
const INLINE_TOKEN_THRESHOLD = 4_000;

/** Suggested vision models when user's model doesn't support images */
const SUGGESTED_VISION_MODELS = [
  'anthropic/claude-sonnet-4',
  'openrouter/openai/gpt-4o',
  'openrouter/google/gemini-2.5-flash',
];

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Route an attachment to its optimal handling strategy.
 *
 * @param attachment   The attachment metadata from upload
 * @param modelString  Current model in "provider/model-id" format
 * @param vaultStatus  Vault ingest status for this attachment (from DB)
 */
export function routeAttachment(
  attachment: AttachmentMeta,
  modelString: string,
  vaultStatus?: string | null,
): AttachmentRoute {
  const caps = getModelCapabilities(modelString);
  const mime = attachment.mimeType;

  // ── Images ──────────────────────────────────────────────────────────────
  if (attachment.isImage || mime.startsWith('image/')) {
    if (caps.vision) {
      return { strategy: 'inline', attachment };
    }
    return {
      strategy: 'suggest_swap',
      attachment,
      requiredCapability: 'vision',
      suggestedModels: SUGGESTED_VISION_MODELS,
    };
  }

  // ── Audio ───────────────────────────────────────────────────────────────
  // Audio files are transcribed server-side at upload time (faster-whisper).
  // By the time the agent-runtime sees them, extracted_text contains the
  // transcript.  Route as inline — the /text endpoint returns the transcript.
  if (mime.startsWith('audio/')) {
    return { strategy: 'inline', attachment };
  }

  // ── PDFs — always vault-reference, never inline ─────────────────────────
  if (mime === 'application/pdf') {
    if (vaultStatus === 'ingested') {
      return {
        strategy: 'vault_reference',
        attachment,
        contextNote:
          `[Document "${attachment.filename}" has been ingested into shared memory. ` +
          `Use the recall tool with scope="shared" to search it, or read_document to access specific sections.]`,
      };
    }
    // Vault ingest pending or failed — still don't inline the full text.
    // The context-assembler's document inventory will pick it up once ingested.
    // For now, inject a lightweight note that it's being processed.
    if (vaultStatus === 'pending') {
      return {
        strategy: 'vault_reference',
        attachment,
        contextNote:
          `[Document "${attachment.filename}" is being processed and will be available in shared memory shortly. ` +
          `Use read_document to check availability.]`,
      };
    }
    // Failed or null — fall through to inline as text (fallback)
    // But still use vault_reference strategy to avoid huge token waste
    return {
      strategy: 'vault_reference',
      attachment,
      contextNote:
        `[Document "${attachment.filename}" (PDF, ${attachment.sizeBytes} bytes) is available. ` +
        `Use read_document tool to access its contents by section or page.]`,
    };
  }

  // ── Large text/code/CSV files — vault if over threshold ─────────────────
  const estimatedTokens = attachment.estimatedTokens ?? Math.ceil(attachment.sizeBytes / 4);
  if (estimatedTokens > INLINE_TOKEN_THRESHOLD) {
    return {
      strategy: 'vault_reference',
      attachment,
      contextNote:
        `[File "${attachment.filename}" (${mime}, ~${estimatedTokens} tokens) is too large to inline. ` +
        `The file contents are available via the read_document tool.]`,
    };
  }

  // ── Small text/code files — inline directly ─────────────────────────────
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/x-yaml'
  ) {
    return { strategy: 'inline', attachment };
  }

  // ── Unsupported ─────────────────────────────────────────────────────────
  return {
    strategy: 'unsupported',
    attachment,
    reason: `File type ${mime} is not supported for context injection.`,
  };
}

/**
 * Route multiple attachments and return decisions for each.
 */
export function routeAttachments(
  attachments: AttachmentMeta[],
  modelString: string,
  vaultStatuses?: Map<string, string | null>,
): AttachmentRoute[] {
  return attachments.map((att) =>
    routeAttachment(att, modelString, vaultStatuses?.get(att.id)),
  );
}
