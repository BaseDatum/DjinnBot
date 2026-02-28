import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Search, Plus, RotateCcw, X, GripVertical } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { MemoryTree } from './MemoryTree';
import { MemoryViewer } from './MemoryViewer';
import { MemorySearchResults } from './MemorySearchResults';
import { CreateMemoryDialog } from './CreateMemoryDialog';
import { useMemoryWebSocket } from '@/hooks/useMemoryWebSocket';
import { fetchAgentMemory, fetchVaultFiles, searchMemory, MemorySearchResult } from '@/lib/api';

interface MemoryFile {
  filename: string;
  category: string | null;
  title: string | null;
  created_at: number | null;
  size_bytes: number;
  preview: string | null;
}

interface MemoryExplorerProps {
  agentId: string;
  /**
   * When set, fetches file listings from `/memory/vaults/{vaultId}` instead of
   * `/agents/{agentId}/memory`.  Useful for the shared vault page where the
   * vault ID is `"shared"` and there is no matching agent record.
   */
  vaultId?: string;
}

/**
 * Custom resizable split pane — no third-party library.
 * Drag the handle to resize the explorer (left) vs viewer (right).
 */
function useResizableSplit(initialWidthPx: number, minPx: number, maxPx: number) {
  const [width, setWidth] = useState(initialWidthPx);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [width]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    e.preventDefault();
    const delta = e.clientX - startX.current;
    const container = containerRef.current;
    const maxAllowed = container
      ? Math.min(maxPx, container.offsetWidth - 200)
      : maxPx;
    const next = Math.max(minPx, Math.min(maxAllowed, startWidth.current + delta));
    setWidth(next);
  }, [minPx, maxPx]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  return { width, containerRef, onPointerDown, onPointerMove, onPointerUp };
}

export function MemoryExplorer({ agentId, vaultId }: MemoryExplorerProps) {
  const effectiveVaultId = vaultId ?? agentId;
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [memories, setMemories] = useState<MemoryFile[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemorySearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  
  const { connected } = useMemoryWebSocket({
    agentId: effectiveVaultId,
    onUpdate: () => {
      refetchMemories();
    },
  });

  const {
    width: explorerWidth,
    containerRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  } = useResizableSplit(280, 150, 600);
  
  const refetchMemories = async () => {
    try {
      const data = vaultId
        ? await fetchVaultFiles(vaultId)
        : await fetchAgentMemory(agentId);
      setMemories(data);
      setLastUpdate(new Date());
    } catch (err) {
      console.error('Failed to fetch memories:', err);
    } finally {
      setLoading(false);
    }
  };
  
  useEffect(() => {
    refetchMemories();
  }, [effectiveVaultId]);
  
  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const results = await searchMemory(searchQuery, effectiveVaultId);
        setSearchResults(results);
      } catch (err) {
        console.error('Search failed:', err);
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    
    return () => clearTimeout(timer);
  }, [searchQuery, effectiveVaultId]);
  
  const filteredMemories = useMemo(() => {
    if (!searchQuery.trim()) return memories;
    const q = searchQuery.toLowerCase();
    return memories.filter(
      (m) =>
        m.filename.toLowerCase().includes(q) ||
        m.category?.toLowerCase().includes(q) ||
        m.title?.toLowerCase().includes(q)
    );
  }, [memories, searchQuery]);
  
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };
  
  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults(null);
  }, []);
  
  const handleCreate = () => {
    setCreateOpen(true);
  };
  
  const handleRefresh = () => {
    refetchMemories();
  };
  
  const formatLastUpdate = () => {
    if (!lastUpdate) return 'Never';
    const seconds = Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return lastUpdate.toLocaleTimeString();
  };
  
  return (
    <div className="h-[calc(100vh-220px)] border rounded-lg overflow-hidden flex flex-col bg-background">
      {/* Search bar */}
      <div className="p-2 border-b flex items-center gap-2 bg-muted/20">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search memories..."
            value={searchQuery}
            onChange={handleSearch}
            className="pl-9 pr-8 h-9"
          />
          {searchQuery && (
            <button
              onClick={clearSearch}
              className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button size="sm" onClick={handleCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          New
        </Button>
        <Button size="sm" variant="outline" onClick={handleRefresh} className="gap-1.5">
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>
      
      {/* Split pane — custom implementation */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 flex flex-row overflow-hidden"
        style={{ userSelect: 'none' }}
      >
        {/* Left: File explorer */}
        <div
          className="h-full flex flex-col overflow-hidden shrink-0"
          style={{ width: explorerWidth }}
        >
          {searchResults !== null ? (
            <MemorySearchResults 
              results={searchResults} 
              onSelect={setSelectedFile}
              selectedFile={selectedFile}
              query={searchQuery}
              loading={searching}
            />
          ) : (
            <MemoryTree 
              memories={filteredMemories} 
              selectedFile={selectedFile}
              onSelect={setSelectedFile} 
            />
          )}
        </div>

        {/* Drag handle */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="shrink-0 flex items-center justify-center bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-col-resize select-none"
          style={{ width: 8, touchAction: 'none' }}
          title="Drag to resize"
        >
          <GripVertical className="h-4 w-4 text-muted-foreground/50" />
        </div>

        {/* Right: File viewer */}
        <div className="h-full flex-1 min-w-0 flex flex-col overflow-hidden">
          <MemoryViewer 
            agentId={effectiveVaultId} 
            filename={selectedFile}
            onDelete={() => {
              setSelectedFile(null);
              refetchMemories();
            }}
          />
        </div>
      </div>
      
      {/* Status bar */}
      <div className="p-1.5 border-t text-xs text-muted-foreground flex items-center gap-2 bg-muted/20">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-300'}`} />
        <span>{connected ? 'Connected' : 'Disconnected'}</span>
        <span className="text-muted-foreground/50">·</span>
        <span>{filteredMemories.length} files</span>
        {filteredMemories.length !== memories.length && (
          <span className="text-muted-foreground/50">({memories.length} total)</span>
        )}
        <span className="text-muted-foreground/50">·</span>
        <span>Last update {formatLastUpdate()}</span>
      </div>
    </div>
  );
}
