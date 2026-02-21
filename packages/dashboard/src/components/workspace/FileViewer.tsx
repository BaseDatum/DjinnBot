import { useState, useEffect, useMemo } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import CodeMirror from '@uiw/react-codemirror';
import { githubDark } from '@uiw/codemirror-theme-github';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, ChevronRight, RotateCcw, GitCommit } from 'lucide-react';

const LANG_MAP: Record<string, () => any> = {
  '.js': () => javascript(),
  '.jsx': () => javascript({ jsx: true }),
  '.ts': () => javascript({ typescript: true }),
  '.tsx': () => javascript({ jsx: true, typescript: true }),
  '.py': () => python(),
  '.json': () => json(),
  '.yaml': () => yaml(),
  '.yml': () => yaml(),
  '.md': () => markdown(),
  '.html': () => html(),
  '.css': () => css(),
};

interface Commit {
  hash: string;
  short_hash: string;
  author: string;
  timestamp: number;
  subject: string;
  step_id?: string;
  agent_id?: string;
  summary?: string;
}

interface FileViewerProps {
  runId: string;
  path: string;
  content?: string;
  commitHash?: string;
  onCompare?: () => void;
}

export function FileViewer({ runId, path, content: initialContent, commitHash: initialCommit, onCompare }: FileViewerProps) {
  const [content, setContent] = useState(initialContent || '');
  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(initialCommit || null);
  const [currentCommitInfo, setCurrentCommitInfo] = useState<Commit | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(!!initialCommit);

  const ext = path.substring(path.lastIndexOf('.'));
  const extensions = useMemo(() => {
    const langFn = LANG_MAP[ext];
    return langFn ? [langFn()] : [];
  }, [ext]);

  // Load file history on mount
  useEffect(() => {
    loadFileHistory();
  }, [runId, path]);

  // Load file content when commit changes
  useEffect(() => {
    if (selectedCommit) {
      loadFileAtCommit(selectedCommit);
    } else if (initialContent) {
      setContent(initialContent);
      setCurrentCommitInfo(null);
    }
  }, [selectedCommit, initialContent]);

  const loadFileHistory = async () => {
    try {
      const response = await authFetch(`${API_BASE}/workspaces/${runId}/git/file-history/${path}`);
      if (!response.ok) {
        console.error('Failed to load file history');
        return;
      }
      const data = await response.json();
      setCommits(data.commits || []);
    } catch (err) {
      console.error('Failed to load file history:', err);
    }
  };

  const loadFileAtCommit = async (commitHash: string) => {
    setLoading(true);
    try {
      const response = await authFetch(`${API_BASE}/workspaces/${runId}/git/show/${commitHash}/${path}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to load file');
      }
      const data = await response.json();
      setContent(data.content);
      setCurrentCommitInfo(data.commit);
    } catch (err) {
      console.error('Failed to load file at commit:', err);
      setContent(`Error: ${err instanceof Error ? err.message : 'Failed to load file'}`);
    } finally {
      setLoading(false);
    }
  };

  const goToPreviousCommit = () => {
    if (!selectedCommit || commits.length === 0) return;
    const currentIdx = commits.findIndex((c) => c.hash === selectedCommit);
    if (currentIdx < commits.length - 1) {
      setSelectedCommit(commits[currentIdx + 1].hash);
    }
  };

  const goToNextCommit = () => {
    if (!selectedCommit || commits.length === 0) return;
    const currentIdx = commits.findIndex((c) => c.hash === selectedCommit);
    if (currentIdx > 0) {
      setSelectedCommit(commits[currentIdx - 1].hash);
    } else {
      // Next from first commit = current version
      setSelectedCommit(null);
    }
  };

  const goToCurrent = () => {
    setSelectedCommit(null);
  };

  const formatRelativeTime = (timestamp: number) => {
    const now = Date.now() / 1000;
    const diff = now - timestamp;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const currentCommitIndex = selectedCommit
    ? commits.findIndex((c) => c.hash === selectedCommit)
    : -1;
  const isHistoricalView = selectedCommit !== null;

  return (
    <div className="h-full flex flex-col">
      {/* File path header */}
      <div className="px-3 py-1.5 border-b border-zinc-800 text-xs text-zinc-400 font-mono bg-zinc-900/50">
        {path}
      </div>

      {/* Version controls header */}
      {commits.length > 0 && (
        <div className="flex-shrink-0 border-b border-zinc-800 bg-zinc-900/50 p-2 space-y-2">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowHistory(!showHistory)}
              className="text-xs h-7"
            >
              <GitCommit className="h-3 w-3 mr-1" />
              {isHistoricalView ? 'Historical View' : 'Current Version'}
            </Button>

            {showHistory && (
              <Select
                value={selectedCommit || 'current'}
                onValueChange={(value) =>
                  setSelectedCommit(value === 'current' ? null : value)
                }
              >
                <SelectTrigger className="text-xs h-7 w-[300px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">Current (working tree)</SelectItem>
                  {commits.map((commit) => (
                    <SelectItem key={commit.hash} value={commit.hash}>
                      <div className="flex items-center gap-2">
                        <code className="text-xs">{commit.short_hash}</code>
                        <span className="text-xs truncate max-w-[200px]">
                          {commit.summary || commit.subject}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {isHistoricalView && (
              <>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={goToPreviousCommit}
                    disabled={currentCommitIndex >= commits.length - 1}
                    className="h-7 px-2"
                    title="Previous commit"
                  >
                    <ChevronLeft className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={goToNextCommit}
                    disabled={currentCommitIndex < 0}
                    className="h-7 px-2"
                    title="Next commit"
                  >
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={goToCurrent}
                  className="text-xs h-7 ml-auto"
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Current Version
                </Button>
              </>
            )}
          </div>

          {/* Commit info banner */}
          {isHistoricalView && currentCommitInfo && (
            <div className="text-xs text-muted-foreground bg-blue-500/5 border border-blue-500/20 rounded px-2 py-1">
              <div className="flex items-center justify-between">
                <span>
                  <code className="text-blue-400">{currentCommitInfo.short_hash}</code>
                  {' - '}
                  {currentCommitInfo.subject}
                </span>
                <span>{formatRelativeTime(currentCommitInfo.timestamp)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* File content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-4 text-xs text-muted-foreground">Loading...</div>
        ) : (
          <CodeMirror
            value={content}
            theme={githubDark}
            extensions={extensions}
            editable={false}
            className="text-xs"
            basicSetup={{ lineNumbers: true, foldGutter: true }}
          />
        )}
      </div>

      {/* Actions footer */}
      {isHistoricalView && onCompare && (
        <div className="flex-shrink-0 border-t border-zinc-800 p-2 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCompare}
            className="text-xs"
          >
            Compare with Current
          </Button>
        </div>
      )}
    </div>
  );
}
