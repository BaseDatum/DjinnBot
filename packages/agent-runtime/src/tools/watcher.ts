import { watch, type FSWatcher } from 'chokidar';
import { stat } from 'node:fs/promises';

export interface FileChangeEvent {
  type: 'fileChange';
  requestId?: string;
  path: string;
  changeType: 'create' | 'modify' | 'delete';
}

export type FileWatcherPublisher = {
  publishEvent(event: FileChangeEvent): Promise<void>;
};

export interface WatcherOptions {
  workspacePath?: string;
  debounceMs?: number;
  ignored?: string[];
}

const DEFAULT_IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/*.log',
  '**/.DS_Store',
];

export function startFileWatcher(
  publisher: FileWatcherPublisher,
  requestId: string | undefined,
  options: WatcherOptions = {}
): FSWatcher {
  const {
    workspacePath = '/workspace',
    debounceMs = 100,
    ignored = DEFAULT_IGNORED,
  } = options;

  // Track pending events for debouncing
  const pending = new Map<string, NodeJS.Timeout>();

  const watcher = watch(workspacePath, {
    ignored,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: debounceMs,
      pollInterval: 50,
    },
  });

  const publishChange = async (
    path: string,
    changeType: 'create' | 'modify' | 'delete'
  ) => {
    // Clear any pending event for this path
    const existing = pending.get(path);
    if (existing) {
      clearTimeout(existing);
    }

    // Debounce
    const timeout = setTimeout(async () => {
      pending.delete(path);

      // Get file size for non-delete events
      let size: number | undefined;
      if (changeType !== 'delete') {
        try {
          const stats = await stat(path);
          size = stats.size;
        } catch {
          // File may have been deleted between event and stat
        }
      }

      await publisher.publishEvent({
        type: 'fileChange',
        requestId,
        path: path.replace(workspacePath, ''),
        changeType,
      });
    }, debounceMs);

    pending.set(path, timeout);
  };

  watcher.on('add', (path) => publishChange(path, 'create'));
  watcher.on('change', (path) => publishChange(path, 'modify'));
  watcher.on('unlink', (path) => publishChange(path, 'delete'));

  watcher.on('error', (err) => {
    console.error('[FileWatcher] Error:', err);
  });

  console.log(`[FileWatcher] Watching ${workspacePath}`);

  return watcher;
}
