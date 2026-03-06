import { useState, useEffect } from 'react';
import { X, ChevronDown, ChevronRight, FileText, FilePlus, FileMinus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchCommitDiff, CommitDiff } from '@/lib/api';

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted';
}

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{
    type: 'context' | 'add' | 'delete';
    content: string;
    oldLineNum?: number;
    newLineNum?: number;
  }>;
}

interface DiffViewProps {
  runId: string;
  commitHash: string;
  onClose: () => void;
}

export function DiffView({ runId, commitHash, onClose }: DiffViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CommitDiff | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadDiff();
  }, [runId, commitHash]);

  const loadDiff = async () => {
    setLoading(true);
    setError(null);
    try {
      const diffData = await fetchCommitDiff(runId, commitHash);
      setData(diffData);
      // Auto-expand all files initially
      setExpandedFiles(new Set(diffData.files.map((f) => f.path)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diff');
    } finally {
      setLoading(false);
    }
  };

  const parseDiff = (diffText: string): Map<string, DiffHunk[]> => {
    const fileMap = new Map<string, DiffHunk[]>();
    const lines = diffText.split('\n');
    let currentFile: string | null = null;
    let currentHunk: DiffHunk | null = null;
    let oldLineNum = 0;
    let newLineNum = 0;

    for (const line of lines) {
      // File header: diff --git a/file b/file
      if (line.startsWith('diff --git')) {
        const match = line.match(/b\/(.+)$/);
        if (match) {
          currentFile = match[1];
          fileMap.set(currentFile, []);
        }
        continue;
      }

      // Hunk header: @@ -1,4 +1,6 @@
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (match && currentFile) {
          if (currentHunk) {
            fileMap.get(currentFile)?.push(currentHunk);
          }
          currentHunk = {
            oldStart: parseInt(match[1]),
            oldLines: parseInt(match[2] || '1'),
            newStart: parseInt(match[3]),
            newLines: parseInt(match[4] || '1'),
            lines: [],
          };
          oldLineNum = parseInt(match[1]);
          newLineNum = parseInt(match[3]);
        }
        continue;
      }

      // Skip metadata lines
      if (
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('index ') ||
        line.startsWith('new file') ||
        line.startsWith('deleted file') ||
        line.startsWith('Binary files')
      ) {
        continue;
      }

      // Diff content lines
      if (currentHunk && currentFile) {
        if (line.startsWith('+')) {
          currentHunk.lines.push({
            type: 'add',
            content: line.slice(1),
            newLineNum: newLineNum++,
          });
        } else if (line.startsWith('-')) {
          currentHunk.lines.push({
            type: 'delete',
            content: line.slice(1),
            oldLineNum: oldLineNum++,
          });
        } else if (line.startsWith(' ') || line === '') {
          currentHunk.lines.push({
            type: 'context',
            content: line.slice(1),
            oldLineNum: oldLineNum++,
            newLineNum: newLineNum++,
          });
        }
      }
    }

    // Push last hunk
    if (currentHunk && currentFile) {
      fileMap.get(currentFile)?.push(currentHunk);
    }

    return fileMap;
  };

  const toggleFile = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const renderUnifiedDiff = (hunks: DiffHunk[], filePath: string) => {
    return (
      <div className="font-mono text-xs">
        {hunks.map((hunk, hunkIdx) => (
          <div key={hunkIdx} className="mb-2">
            <div className="bg-blue-500/10 text-blue-400 px-2 py-1 text-[10px]">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, lineIdx) => (
              <div
                key={lineIdx}
                className={`flex ${
                  line.type === 'add'
                    ? 'bg-green-500/10'
                    : line.type === 'delete'
                    ? 'bg-red-500/10'
                    : 'bg-transparent'
                }`}
              >
                <span className="text-zinc-600 px-2 select-none w-12 text-right flex-shrink-0">
                  {line.oldLineNum || ''}
                </span>
                <span className="text-zinc-600 px-2 select-none w-12 text-right flex-shrink-0">
                  {line.newLineNum || ''}
                </span>
                <span
                  className={`px-2 ${
                    line.type === 'add'
                      ? 'text-green-400'
                      : line.type === 'delete'
                      ? 'text-red-400'
                      : 'text-zinc-500'
                  }`}
                >
                  {line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}
                </span>
                <code className="flex-1 pr-2 whitespace-pre">{line.content}</code>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
        <div className="bg-card border rounded-lg p-8">
          <p className="text-muted-foreground">Loading diff...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
        <div className="bg-card border rounded-lg p-8">
          <p className="text-destructive mb-4">{error}</p>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const diffMap = parseDiff(data.diff);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-card border rounded-lg w-full max-w-6xl h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h3 className="text-lg font-semibold">
              Commit {data.commit.short_hash}
            </h3>
            <p className="text-sm text-muted-foreground">{data.commit.subject}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Files summary */}
        <div className="px-4 py-2 border-b text-sm text-muted-foreground">
          {data.files.length} file{data.files.length !== 1 ? 's' : ''} changed
        </div>

        {/* File diffs */}
        <div className="flex-1 overflow-auto p-4">
          {data.files.map((file) => {
            const hunks = diffMap.get(file.path) || [];
            const isExpanded = expandedFiles.has(file.path);

            return (
              <div key={file.path} className="mb-4 border rounded-lg overflow-hidden">
                <div className="bg-zinc-900">
                  <button
                    onClick={() => toggleFile(file.path)}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-800 transition-colors text-left"
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                    {file.status === 'added' ? (
                      <FilePlus className="h-4 w-4 text-green-400" />
                    ) : file.status === 'deleted' ? (
                      <FileMinus className="h-4 w-4 text-red-400" />
                    ) : (
                      <FileText className="h-4 w-4 text-blue-400" />
                    )}
                    <span className="font-mono text-sm flex-1">{file.path}</span>
                    {file.additions > 0 && (
                      <span className="text-xs text-green-400">+{file.additions}</span>
                    )}
                    {file.deletions > 0 && (
                      <span className="text-xs text-red-400">-{file.deletions}</span>
                    )}
                  </button>
                  
                  {/* View file at commit buttons */}
                  <div className="flex gap-2 px-3 pb-2">
                    {file.status !== 'added' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-6"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Open file at parent commit (before changes)
                          window.open(
                            `/runs/${runId}?file=${encodeURIComponent(file.path)}&commit=${commitHash}^`,
                            '_blank'
                          );
                        }}
                      >
                        View Before
                      </Button>
                    )}
                    {file.status !== 'deleted' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-6"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Open file at this commit (after changes)
                          window.open(
                            `/runs/${runId}?file=${encodeURIComponent(file.path)}&commit=${commitHash}`,
                            '_blank'
                          );
                        }}
                      >
                        View After
                      </Button>
                    )}
                  </div>
                </div>

                {isExpanded && hunks.length > 0 && (
                  <div className="bg-zinc-950 p-2 overflow-x-auto">
                    {renderUnifiedDiff(hunks, file.path)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
