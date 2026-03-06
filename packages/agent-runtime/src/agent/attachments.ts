/**
 * Attachment handling for multimodal chat messages.
 *
 * Fetches file content from the API server and converts attachments into
 * pi-agent-core content blocks that can be passed to Agent.prompt().
 *
 * Uses the Smart Attachment Router to decide how each attachment should
 * be handled:
 *   - Images on vision models → base64 ImageContent
 *   - PDFs → lightweight vault reference (NOT full text inline)
 *   - Audio → inline text (transcribed server-side by faster-whisper)
 *   - Small text/code → inline TextContent
 *   - Large text/code → vault reference note
 *   - Images on non-vision models → text note suggesting model swap
 */

import type { ImageContent, TextContent } from '@mariozechner/pi-ai';
import {
  routeAttachments,
  type AttachmentRoute,
} from '@djinnbot/core';

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  estimatedTokens?: number;
}

/**
 * Build LLM content blocks for attachments using the Smart Attachment Router.
 *
 * The router decides per-attachment whether to inline, vault-reference,
 * transcribe, or suggest a model swap.  This eliminates the previous
 * behaviour of dumping full PDF text into context (~25K tokens wasted).
 */
export async function buildAttachmentBlocks(
  attachments: AttachmentMeta[],
  apiBaseUrl: string,
  modelString?: string,
): Promise<(TextContent | ImageContent)[]> {
  const blocks: (TextContent | ImageContent)[] = [];
  const model = modelString || process.env.AGENT_MODEL || 'unknown/unknown';

  // Fetch vault ingest statuses for all attachments in parallel
  const vaultStatuses = new Map<string, string | null>();
  await Promise.all(
    attachments.map(async (att) => {
      try {
        const meta = await fetchAttachmentMeta(att.id, apiBaseUrl);
        vaultStatuses.set(att.id, meta?.vaultIngestStatus ?? null);
      } catch {
        vaultStatuses.set(att.id, null);
      }
    }),
  );

  // Route each attachment
  const routes = routeAttachments(attachments, model, vaultStatuses);

  for (const route of routes) {
    try {
      const block = await processRoute(route, apiBaseUrl);
      if (block) blocks.push(block);
    } catch (err) {
      console.warn(
        `[Attachments] Failed to process ${route.attachment.filename}:`,
        err,
      );
      blocks.push({
        type: 'text',
        text: `[Attachment "${route.attachment.filename}" could not be loaded: ${err instanceof Error ? err.message : String(err)}]`,
      });
    }
  }

  return blocks;
}

/**
 * Process a single routing decision into an LLM content block.
 */
async function processRoute(
  route: AttachmentRoute,
  apiBaseUrl: string,
): Promise<TextContent | ImageContent | null> {
  switch (route.strategy) {
    case 'inline': {
      if (route.attachment.isImage || route.attachment.mimeType.startsWith('image/')) {
        return fetchImageBlock(route.attachment, apiBaseUrl);
      }
      return fetchTextBlock(route.attachment, apiBaseUrl);
    }

    case 'vault_reference': {
      // Lightweight context note — saves 10K-25K tokens vs inlining full PDFs
      return {
        type: 'text',
        text: route.contextNote,
      };
    }

    case 'suggest_swap': {
      // Non-vision model received an image — tell the agent so it can
      // inform the user.  Don't waste tokens sending the image bytes.
      const models = route.suggestedModels.join(', ');
      return {
        type: 'text',
        text:
          `[User attached image "${route.attachment.filename}" but the current model does not support vision. ` +
          `Suggest the user switch to a vision-capable model such as: ${models}. ` +
          `Once they switch, they can re-send the image.]`,
      };
    }

    case 'unsupported': {
      return {
        type: 'text',
        text: `[Attachment "${route.attachment.filename}": ${route.reason}]`,
      };
    }

    default:
      return null;
  }
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchImageBlock(
  att: AttachmentMeta,
  apiBaseUrl: string,
): Promise<ImageContent | null> {
  const url = `${apiBaseUrl}/v1/chat/attachments/${att.id}/content`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[Attachments] Failed to fetch image ${att.id}: HTTP ${res.status}`);
    return null;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const base64 = buffer.toString('base64');

  return {
    type: 'image',
    data: base64,
    mimeType: att.mimeType,
  };
}

async function fetchTextBlock(
  att: AttachmentMeta,
  apiBaseUrl: string,
): Promise<TextContent | null> {
  const url = `${apiBaseUrl}/v1/chat/attachments/${att.id}/text`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[Attachments] Failed to fetch text for ${att.id}: HTTP ${res.status}`);
    return null;
  }

  const data = (await res.json()) as {
    extractedText?: string;
    filename?: string;
    mimeType?: string;
  };
  const extractedText = data.extractedText;

  if (!extractedText) {
    return {
      type: 'text',
      text: `[File: ${att.filename} (${att.mimeType}, ${att.sizeBytes} bytes) — no text content extracted]`,
    };
  }

  return {
    type: 'text',
    text: `[File: ${att.filename}]\n${extractedText}`,
  };
}

/**
 * Fetch attachment metadata including vault ingest status.
 */
async function fetchAttachmentMeta(
  attachmentId: string,
  apiBaseUrl: string,
): Promise<{
  vaultIngestStatus?: string | null;
  vaultDocSlug?: string | null;
  vaultChunkCount?: number | null;
  pdfPageCount?: number | null;
} | null> {
  try {
    const url = `${apiBaseUrl}/v1/chat/attachments/${attachmentId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      vaultIngestStatus: (data.vaultIngestStatus as string) ?? null,
      vaultDocSlug: (data.vaultDocSlug as string) ?? null,
      vaultChunkCount: (data.vaultChunkCount as number) ?? null,
      pdfPageCount: (data.pdfPageCount as number) ?? null,
    };
  } catch {
    return null;
  }
}


