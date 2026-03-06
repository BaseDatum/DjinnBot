import { FileX, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface ConflictListProps {
  conflicts: string[];
  selectedFile?: string;
  onFileSelect: (file: string) => void;
}

/**
 * ConflictList - Display list of conflicting files
 * 
 * Shows all files with merge conflicts, allowing selection
 * to view/resolve individual files.
 */
export function ConflictList({ conflicts, selectedFile, onFileSelect }: ConflictListProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 px-3 py-2 text-sm font-medium border-b">
        <AlertCircle className="h-4 w-4 text-orange-600" />
        <span>{conflicts.length} Conflicting Files</span>
      </div>
      
      <div className="overflow-y-auto max-h-96">
        {conflicts.map((file, index) => (
          <button
            key={file}
            onClick={() => onFileSelect(file)}
            className={`
              w-full px-3 py-2 text-left text-sm
              flex items-center gap-2
              hover:bg-zinc-100 dark:hover:bg-zinc-800
              transition-colors
              ${selectedFile === file ? 'bg-zinc-100 dark:bg-zinc-800' : ''}
            `}
          >
            <FileX className="h-4 w-4 text-orange-600 flex-shrink-0" />
            <span className="flex-1 truncate font-mono text-xs">{file}</span>
            <Badge variant="outline" className="text-xs">
              {index + 1}
            </Badge>
          </button>
        ))}
      </div>
    </div>
  );
}
