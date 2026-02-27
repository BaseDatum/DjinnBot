/**
 * Shared attachment processing for channel bridges (Slack, Discord, Signal, Telegram, WhatsApp).
 *
 * Each channel downloads files from its platform CDN and re-uploads them
 * to DjinnBot's internal storage via the upload-bytes API.  This module
 * centralises that flow so every channel bridge uses the same logic.
 */

export interface ChannelFile {
  /** Download URL on the platform CDN */
  url: string;
  /** Original filename */
  name: string;
  /** MIME type reported by the platform */
  mimeType: string;
  /** Optional auth header for downloading (e.g. Slack bot token) */
  authHeader?: string;
  /** Raw bytes — if already downloaded (e.g. Baileys provides buffer directly) */
  buffer?: Buffer;
}

export interface ProcessedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  estimatedTokens?: number;
}

/**
 * MIME types that DjinnBot can meaningfully process.
 * If a file's type is not in this set, we skip it and return a reason.
 */
const PROCESSABLE_MIME_PREFIXES = [
  'image/',
  'audio/',
  'application/pdf',
  'text/',
  'application/json',
  'application/xml',
  'application/x-yaml',
];

function isSupportedMime(mime: string): boolean {
  return PROCESSABLE_MIME_PREFIXES.some(
    (prefix) => mime === prefix || mime.startsWith(prefix),
  );
}

/**
 * Download files from a platform CDN and re-upload them to DjinnBot storage.
 *
 * Returns an array of processed attachment metadata ready for the
 * ChatSessionManager.sendMessage() attachments parameter.
 *
 * Unsupported file types are skipped with a warning log.
 */
export async function processChannelAttachments(
  files: ChannelFile[],
  apiBaseUrl: string,
  sessionId: string,
  logPrefix = '[ChannelBridge]',
): Promise<ProcessedAttachment[]> {
  const attachments: ProcessedAttachment[] = [];

  for (const file of files) {
    try {
      // Pre-flight MIME check — skip unsupported types before downloading
      if (!isSupportedMime(file.mimeType)) {
        console.warn(
          `${logPrefix} Skipping unsupported file type: ${file.name} (${file.mimeType})`,
        );
        continue;
      }

      // Download if not already buffered
      let buffer = file.buffer;
      if (!buffer) {
        const headers: Record<string, string> = {};
        if (file.authHeader) {
          headers['Authorization'] = file.authHeader;
        }

        const dlRes = await fetch(file.url, { headers });
        if (!dlRes.ok) {
          console.warn(
            `${logPrefix} Failed to download ${file.name}: HTTP ${dlRes.status}`,
          );
          continue;
        }
        buffer = Buffer.from(await dlRes.arrayBuffer());
      }

      // Re-upload to DjinnBot storage
      const formData = new FormData();
      formData.append('file', new Blob([buffer]), file.name);

      const uploadUrl =
        `${apiBaseUrl}/v1/internal/chat/attachments/upload-bytes` +
        `?session_id=${encodeURIComponent(sessionId)}` +
        `&filename=${encodeURIComponent(file.name)}` +
        `&mime_type=${encodeURIComponent(file.mimeType)}`;

      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
      });

      if (uploadRes.ok) {
        const result = (await uploadRes.json()) as {
          id: string;
          filename: string;
          mimeType: string;
          sizeBytes: number;
          estimatedTokens?: number;
        };
        attachments.push({
          id: result.id,
          filename: result.filename,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          isImage: result.mimeType.startsWith('image/'),
          estimatedTokens: result.estimatedTokens,
        });
        console.log(
          `${logPrefix} Uploaded ${file.name} as ${result.id} (${result.mimeType}, ${result.sizeBytes} bytes)`,
        );
      } else {
        const errText = await uploadRes.text().catch(() => '');
        console.warn(
          `${logPrefix} Upload failed for ${file.name}: HTTP ${uploadRes.status} ${errText.slice(0, 200)}`,
        );
      }
    } catch (err) {
      console.warn(
        `${logPrefix} Failed to process ${file.name}:`,
        err,
      );
    }
  }

  return attachments;
}
