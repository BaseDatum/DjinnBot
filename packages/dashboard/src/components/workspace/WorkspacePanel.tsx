import { useState, useEffect, useCallback, useRef } from 'react';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { fetchWorkspaceFiles, fetchWorkspaceFile } from '@/lib/api';
import { FolderOpen } from 'lucide-react';

interface WorkspacePanelProps {
  runId: string;
  fileChangedEvents: Array<{ path: string; timestamp: number }>;
}

export function WorkspacePanel({ runId, fileChangedEvents }: WorkspacePanelProps) {
  const [files, setFiles] = useState<Array<{ path: string; size: number; modified: number }>>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [changedPaths, setChangedPaths] = useState<Set<string>>(new Set());
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Load file list
  const loadFiles = useCallback(async () => {
    try {
      const data = await fetchWorkspaceFiles(runId);
      setFiles(data.files || []);
    } catch {
      // Workspace may not exist yet
    }
  }, [runId]);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // Refresh on file changed events (debounced)
  useEffect(() => {
    if (fileChangedEvents.length === 0) return;
    
    const latest = fileChangedEvents[fileChangedEvents.length - 1];
    setChangedPaths(prev => new Set([...prev, latest.path]));
    
    // Clear changed indicator after 10s
    const timer = setTimeout(() => {
      changeTimersRef.current.delete(timer);
      setChangedPaths(prev => {
        const next = new Set(prev);
        next.delete(latest.path);
        return next;
      });
    }, 10000);
    changeTimersRef.current.add(timer);
    
    // Debounced refresh
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(loadFiles, 1000);
  }, [fileChangedEvents, loadFiles]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of changeTimersRef.current) clearTimeout(timer);
      changeTimersRef.current.clear();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // Load file content on selection
  const handleSelect = async (path: string) => {
    setSelectedPath(path);
    setLoading(true);
    try {
      const data = await fetchWorkspaceFile(runId, path);
      setFileContent(data.content);
    } catch (err) {
      setFileContent(`Error loading file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  // Auto-refresh viewed file when it changes
  useEffect(() => {
    if (!selectedPath || fileChangedEvents.length === 0) return;
    const latest = fileChangedEvents[fileChangedEvents.length - 1];
    if (latest.path === selectedPath) {
      // Re-fetch the file content
      fetchWorkspaceFile(runId, selectedPath)
        .then(data => setFileContent(data.content))
        .catch(() => {});
    }
  }, [fileChangedEvents, selectedPath, runId]);

  return (
    <div className="h-full flex flex-col bg-zinc-950 rounded-md border border-zinc-800">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 text-xs text-zinc-400">
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="font-medium">Workspace Files</span>
        <span className="text-zinc-600">({files.length})</span>
      </div>
      
      {selectedPath ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 min-h-0">
            {loading ? (
              <div className="p-4 text-xs text-zinc-500">Loading...</div>
            ) : (
              <FileViewer runId={runId} path={selectedPath} content={fileContent} />
            )}
          </div>
          <button
            onClick={() => setSelectedPath(null)}
            className="px-3 py-1.5 border-t border-zinc-800 text-xs text-zinc-500 hover:text-zinc-400 text-left"
          >
            ← Back to file list
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <FileTree
            files={files}
            selectedPath={selectedPath}
            changedPaths={changedPaths}
            onSelect={handleSelect}
          />
        </div>
      )}
    </div>
  );
}
