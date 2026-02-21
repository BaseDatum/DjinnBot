/**
 * Attachment handling for multimodal chat messages.
 *
 * Fetches file content from the API server and converts attachments into
 * pi-agent-core content blocks that can be passed to Agent.prompt().
 *
 * Image attachments → ImageContent (base64)
 * Document/code attachments → TextContent (extracted text or raw text)
 */

import type { ImageContent, TextContent } from '@mariozechner/pi-ai';

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  estimatedTokens?: number;
}

/**
 * Fetch attachment content from the API server and convert to LLM content blocks.
 *
 * Images are fetched as binary and base64-encoded for vision models.
 * Non-image files fetch the extracted text from the /text endpoint.
 */
export async function buildAttachmentBlocks(
  attachments: AttachmentMeta[],
  apiBaseUrl: string,
): Promise<(TextContent | ImageContent)[]> {
  const blocks: (TextContent | ImageContent)[] = [];

  for (const att of attachments) {
    try {
      if (att.isImage) {
        const block = await fetchImageBlock(att, apiBaseUrl);
        if (block) blocks.push(block);
      } else {
        const block = await fetchTextBlock(att, apiBaseUrl);
        if (block) blocks.push(block);
      }
    } catch (err) {
      console.warn(`[Attachments] Failed to process ${att.filename}:`, err);
      blocks.push({
        type: 'text',
        text: `[Attachment "${att.filename}" could not be loaded: ${err instanceof Error ? err.message : String(err)}]`,
      });
    }
  }

  return blocks;
}

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

  const data = await res.json() as { extractedText?: string; filename?: string; mimeType?: string };
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
