import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { X, Check, AlertCircle, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConflictList } from './ConflictList';
import { ConflictMarkerView } from './ConflictMarkerView';

interface ConflictResolverProps {
  runId: string;
  conflicts: string[];
  onClose: () => void;
  onResolved: () => void;
}

interface ConflictData {
  file: string;
  oursContent: string;
  theirsContent: string;
  baseContent?: string;
  conflictMarkers: string;
}

type ResolutionStrategy = 'ours' | 'theirs' | 'manual' | null;

/**
 * ConflictResolver - Main UI for resolving merge conflicts
 * 
 * Provides three resolution modes:
 * 1. Quick resolution (accept all from one side)
 * 2. File-by-file selection
 * 3. Manual editing (future enhancement)
 */
export function ConflictResolver({ runId, conflicts, onClose, onResolved }: ConflictResolverProps) {
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [conflictData, setConflictData] = useState<Map<string, ConflictData>>(new Map());
  const [selectedFile, setSelectedFile] = useState<string>(conflicts[0] || '');
  const [resolutions, setResolutions] = useState<Map<string, ResolutionStrategy>>(new Map());

  useEffect(() => {
    fetchConflictData();
  }, [runId]);

  const fetchConflictData = async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch conflict data for all files
      const dataMap = new Map<string, ConflictData>();
      
      for (const file of conflicts) {
        const res = await authFetch(`${API_BASE}/workspaces/${runId}/conflicts/${encodeURIComponent(file)}`);
        if (!res.ok) {
          throw new Error(`Failed to fetch conflict data for ${file}`);
        }
        const data = await res.json();
        dataMap.set(file, data);
      }

      setConflictData(dataMap);
      setSelectedFile(conflicts[0] || '');
    } catch (err) {
      setError((err as Error).message || 'Failed to load conflict data');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickResolve = async (strategy: 'ours' | 'theirs') => {
    setResolving(true);
    setError(null);

    try {
      const res = await authFetch(`${API_BASE}/workspaces/${runId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategy,
          resolveAll: true,
        }),
      });

      const data = await res.json();

      if (data.success) {
        onResolved();
      } else {
        setError(data.error || 'Failed to resolve conflicts');
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to resolve conflicts');
    } finally {
      setResolving(false);
    }
  };

  const handleManualResolve = async () => {
    setResolving(true);
    setError(null);

    // Check that all files have a resolution
    const unresolvedFiles = conflicts.filter(f => !resolutions.get(f));
    if (unresolvedFiles.length > 0) {
      setError(`${unresolvedFiles.length} file(s) not resolved yet`);
      setResolving(false);
      return;
    }

    try {
      // Build resolution map
      const resolutionMap: Record<string, string> = {};
      conflicts.forEach(file => {
        const strategy = resolutions.get(file);
        if (strategy) {
          resolutionMap[file] = strategy;
        }
      });

      const res = await authFetch(`${API_BASE}/workspaces/${runId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolutions: resolutionMap,
        }),
      });

      const data = await res.json();

      if (data.success) {
        onResolved();
      } else {
        setError(data.error || 'Failed to resolve conflicts');
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to resolve conflicts');
    } finally {
      setResolving(false);
    }
  };

  const setResolution = (file: string, strategy: ResolutionStrategy) => {
    const newResolutions = new Map(resolutions);
    if (strategy === null) {
      newResolutions.delete(file);
    } else {
      newResolutions.set(file, strategy);
    }
    setResolutions(newResolutions);
  };

  const currentConflict = conflictData.get(selectedFile);
  const currentResolution = resolutions.get(selectedFile);
  const resolvedCount = Array.from(resolutions.values()).filter(r => r !== null).length;
  const currentIndex = conflicts.indexOf(selectedFile);

  const goToPrevious = () => {
    if (currentIndex > 0) {
      setSelectedFile(conflicts[currentIndex - 1]);
    }
  };

  const goToNext = () => {
    if (currentIndex < conflicts.length - 1) {
      setSelectedFile(conflicts[currentIndex + 1]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="border-b px-4 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Resolve Merge Conflicts</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {conflicts.length} file(s) have conflicts
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
          </div>
        ) : (
          <>
            {/* Quick Resolution Options */}
            <div className="border-b px-4 py-3 space-y-2">
              <div className="text-sm font-medium">Quick Resolution</div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleQuickResolve('ours')}
                  disabled={resolving}
                  className="flex-1"
                >
                  Accept All from Main
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleQuickResolve('theirs')}
                  disabled={resolving}
                  className="flex-1"
                >
                  Accept All from Run
                </Button>
              </div>
              <p className="text-xs text-zinc-500">
                Or resolve files individually below
              </p>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex min-h-0">
              {/* Left: File List */}
              <div className="w-72 border-r flex flex-col">
                <ConflictList
                  conflicts={conflicts}
                  selectedFile={selectedFile}
                  onFileSelect={setSelectedFile}
                />
              </div>

              {/* Right: Conflict View & Resolution */}
              <div className="flex-1 flex flex-col min-w-0">
                {currentConflict ? (
                  <>
                    {/* File Navigation */}
                    <div className="border-b px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {currentIndex + 1} of {conflicts.length}
                        </span>
                        <Badge variant={currentResolution ? 'default' : 'outline'}>
                          {currentResolution ? `Using ${currentResolution === 'ours' ? 'main' : 'run'}` : 'Unresolved'}
                        </Badge>
                      </div>
                      
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={goToPrevious}
                          disabled={currentIndex === 0}
                        >
                          <ChevronLeft className="h-4 w-4" />
                          Previous
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={goToNext}
                          disabled={currentIndex === conflicts.length - 1}
                        >
                          Next
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    {/* Conflict Marker View */}
                    <div className="flex-1 overflow-auto p-4">
                      <ConflictMarkerView
                        file={selectedFile}
                        content={currentConflict.conflictMarkers}
                      />
                    </div>

                    {/* Resolution Buttons */}
                    <div className="border-t px-4 py-3 flex gap-2">
                      <Button
                        variant={currentResolution === 'ours' ? 'default' : 'outline'}
                        onClick={() => setResolution(selectedFile, 'ours')}
                        className="flex-1"
                      >
                        <Check className="h-4 w-4 mr-2" />
                        Keep Main Version
                      </Button>
                      <Button
                        variant={currentResolution === 'theirs' ? 'default' : 'outline'}
                        onClick={() => setResolution(selectedFile, 'theirs')}
                        className="flex-1"
                      >
                        <Check className="h-4 w-4 mr-2" />
                        Keep Run Version
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-zinc-500">
                    Select a file to view conflicts
                  </div>
                )}
              </div>
            </div>

            {/* Error Display */}
            {error && (
              <div className="px-4 py-2 border-t">
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              </div>
            )}

            {/* Footer */}
            <div className="border-t px-4 py-3 flex items-center justify-between">
              <div className="text-sm text-zinc-600 dark:text-zinc-400">
                {resolvedCount} of {conflicts.length} files resolved
              </div>

              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose} disabled={resolving}>
                  Cancel
                </Button>
                <Button
                  onClick={handleManualResolve}
                  disabled={resolving || resolvedCount < conflicts.length}
                >
                  {resolving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Commit Resolution
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
