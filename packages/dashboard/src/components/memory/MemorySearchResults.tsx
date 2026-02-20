import { cn } from '@/lib/utils';
import { FileText } from 'lucide-react';

interface MemorySearchResult {
  agent_id: string;
  filename: string;
  snippet: string;
  score: number;
}

interface MemorySearchResultsProps {
  results: MemorySearchResult[];
  onSelect: (filename: string) => void;
  selectedFile: string | null;
  query: string;
  loading?: boolean;
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  
  return (
    <>
      {parts.map((part, i) => 
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

export function MemorySearchResults({ 
  results, 
  onSelect, 
  selectedFile, 
  query,
  loading 
}: MemorySearchResultsProps) {
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-sm text-muted-foreground">Searching...</div>
      </div>
    );
  }
  
  if (results.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-4">
        <FileText className="h-10 w-10 text-muted-foreground/50 mb-2" />
        <p className="text-sm text-muted-foreground">No matches for "{query}"</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Try a different search term</p>
      </div>
    );
  }
  
  return (
    <div className="h-full overflow-auto">
      <div className="px-3 py-2 text-xs text-muted-foreground border-b bg-muted/20">
        {results.length} result{results.length !== 1 ? 's' : ''} for "{query}"
      </div>
      {results.map((r) => (
        <button
          key={r.filename}
          onClick={() => onSelect(r.filename)}
          className={cn(
            "w-full text-left p-3 border-b hover:bg-muted/50 transition-colors",
            selectedFile === r.filename && "bg-primary/10"
          )}
        >
          <div className="flex items-center gap-2 mb-1">
            <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <span className="text-sm font-mono truncate">{r.filename}</span>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">
            <HighlightedSnippet text={r.snippet} query={query} />
          </p>
        </button>
      ))}
    </div>
  );
}
