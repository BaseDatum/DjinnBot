/**
 * FileUploadZone — drag-and-drop + paste + file picker for chat attachments.
 *
 * Manages the upload lifecycle:
 * 1. User drops/pastes/picks files
 * 2. Files are uploaded to the server immediately (via uploadChatAttachment)
 * 3. Pending attachment previews are displayed as chips
 * 4. When the user sends a message, attachment IDs are included
 *
 * Supports: images (jpeg/png/gif/webp), PDFs, text, code files.
 * Client-side image compression for large photos (>4MP).
 */

import { useState, useCallback, useRef, type DragEvent } from 'react';
import { Paperclip, X, FileText, Image as ImageIcon, Loader2 } from 'lucide-react';
import { uploadChatAttachment } from '@/lib/api';
import { cn } from '@/lib/utils';

const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30 MB
const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.pdf', '.txt', '.md', '.csv', '.json',
  '.py', '.js', '.ts', '.html', '.css', '.xml', '.yaml', '.yml',
]);

export interface PendingAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  estimatedTokens: number | null;
  uploading?: boolean;
  error?: string;
}

type AttachmentUpdater = PendingAttachment[] | ((prev: PendingAttachment[]) => PendingAttachment[]);

interface FileUploadZoneProps {
  agentId: string;
  sessionId: string;
  disabled?: boolean;
  attachments: PendingAttachment[];
  onAttachmentsChange: (update: AttachmentUpdater) => void;
  children: React.ReactNode;
}

export function FileUploadZone({
  agentId,
  sessionId,
  disabled,
  attachments,
  onAttachmentsChange,
  children,
}: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    
    for (const file of fileArray) {
      // Validate extension
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        continue; // silently skip unsupported files
      }

      // Validate size
      if (file.size > MAX_FILE_SIZE) {
        onAttachmentsChange([...attachments, {
          id: `err_${Date.now()}`,
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          isImage: false,
          estimatedTokens: null,
          error: 'File too large (max 30MB)',
        }]);
        continue;
      }

      // Add uploading placeholder
      const placeholderId = `uploading_${Date.now()}_${file.name}`;
      const placeholder: PendingAttachment = {
        id: placeholderId,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        isImage: file.type.startsWith('image/'),
        estimatedTokens: null,
        uploading: true,
      };
      
      onAttachmentsChange(prev => [...prev, placeholder]);

      try {
        const result = await uploadChatAttachment(agentId, sessionId, file);
        // Replace placeholder with real attachment
        onAttachmentsChange(prev =>
          prev.map(a => a.id === placeholderId ? {
            id: result.id,
            filename: result.filename,
            mimeType: result.mimeType,
            sizeBytes: result.sizeBytes,
            isImage: result.isImage,
            estimatedTokens: result.estimatedTokens,
          } : a)
        );
      } catch (err) {
        // Replace placeholder with error
        onAttachmentsChange(prev =>
          prev.map(a => a.id === placeholderId ? {
            ...a,
            uploading: false,
            error: err instanceof Error ? err.message : 'Upload failed',
          } : a)
        );
      }
    }
  }, [agentId, sessionId, attachments, onAttachmentsChange]);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer?.items?.length) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounterRef.current = 0;
    if (disabled) return;
    if (e.dataTransfer?.files?.length) {
      processFiles(e.dataTransfer.files);
    }
  }, [disabled, processFiles]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (disabled) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      processFiles(files);
    }
  }, [disabled, processFiles]);

  // Register paste listener on mount
  const pasteRegistered = useRef(false);
  if (!pasteRegistered.current) {
    pasteRegistered.current = true;
    document.addEventListener('paste', handlePaste as any);
  }

  return (
    <div
      className="relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg">
          <div className="text-primary font-medium text-sm">Drop files to attach</div>
        </div>
      )}

      {children}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        accept={Array.from(ALLOWED_EXTENSIONS).join(',')}
        onChange={e => {
          if (e.target.files?.length) {
            processFiles(e.target.files);
            e.target.value = ''; // reset so same file can be re-selected
          }
        }}
      />
    </div>
  );
}

/** Paperclip button that opens the file picker */
export function AttachButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="p-2 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
      title="Attach file"
      type="button"
    >
      <Paperclip className="h-4 w-4" />
    </button>
  );
}

export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: (id: string) => void;
}) {
  const Icon = attachment.isImage ? ImageIcon : FileText;
  const sizeStr = attachment.sizeBytes < 1024
    ? `${attachment.sizeBytes}B`
    : attachment.sizeBytes < 1024 * 1024
      ? `${Math.round(attachment.sizeBytes / 1024)}KB`
      : `${(attachment.sizeBytes / (1024 * 1024)).toFixed(1)}MB`;

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs',
        'border bg-muted/50 max-w-[200px]',
        attachment.error && 'border-destructive/50 bg-destructive/5',
      )}
    >
      {attachment.uploading ? (
        <Loader2 className="h-3 w-3 animate-spin shrink-0" />
      ) : (
        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate" title={attachment.filename}>
        {attachment.filename}
      </span>
      <span className="text-muted-foreground shrink-0">({sizeStr})</span>
      {attachment.error && (
        <span className="text-destructive truncate" title={attachment.error}>
          {attachment.error}
        </span>
      )}
      <button
        onClick={() => onRemove(attachment.id)}
        className="ml-auto shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10"
        title="Remove"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
