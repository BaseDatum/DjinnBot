import { useState } from 'react';
import { API_BASE } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { GitMerge, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ConflictResolver } from './ConflictResolver';

interface MergeButtonProps {
  runId: string;
  disabled?: boolean;
  onSuccess?: () => void;
  className?: string;
}

type MergeStrategy = 'merge' | 'squash' | 'rebase';

export function MergeButton({ runId, disabled = false, onSuccess, className }: MergeButtonProps) {
  const [strategy, setStrategy] = useState<MergeStrategy>('merge');
  const [loading, setLoading] = useState(false);
  const [conflicts, setConflicts] = useState<string[] | null>(null);

  const handleMerge = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/workspaces/${runId}/git/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        // Check if merge failed due to conflicts
        if (data.conflicts && data.conflicts.length > 0) {
          setConflicts(data.conflicts);
          return; // Don't throw - show conflict resolver instead
        }
        throw new Error(data.error || 'Merge failed');
      }

      toast.success(`Changes merged using ${strategy} strategy`);

      onSuccess?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to merge';
      toast.error(`Merge failed: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleConflictsResolved = () => {
    setConflicts(null);
    toast.success('Conflicts resolved and merged successfully');
    onSuccess?.();
  };

  const handleConflictsClosed = () => {
    setConflicts(null);
  };

  return (
    <>
      <div className={`flex items-center gap-2 ${className || ''}`}>
        <Select
          value={strategy}
          onValueChange={(v) => setStrategy(v as MergeStrategy)}
          disabled={disabled || loading}
        >
          <SelectTrigger className="w-[140px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge">Merge</SelectItem>
            <SelectItem value="squash">Squash</SelectItem>
            <SelectItem value="rebase">Rebase</SelectItem>
          </SelectContent>
        </Select>

        <Button
          onClick={handleMerge}
          disabled={disabled || loading}
          className="flex-1"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <GitMerge className="h-4 w-4 mr-2" />
          )}
          Merge to Main
        </Button>
      </div>

      {/* Conflict Resolver Modal */}
      {conflicts && conflicts.length > 0 && (
        <ConflictResolver
          runId={runId}
          conflicts={conflicts}
          onClose={handleConflictsClosed}
          onResolved={handleConflictsResolved}
        />
      )}
    </>
  );
}
