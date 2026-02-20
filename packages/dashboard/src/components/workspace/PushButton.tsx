import { useState } from 'react';
import { API_BASE } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Upload, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

interface PushButtonProps {
  runId: string;
  disabled?: boolean;
  onSuccess?: () => void;
  className?: string;
}

export function PushButton({ runId, disabled = false, onSuccess, className }: PushButtonProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  const handlePush = async () => {
    setLoading(true);
    setShowConfirm(false);

    try {
      const res = await fetch(`${API_BASE}/workspaces/${runId}/git/push`, {
        method: 'POST',
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Push failed');
      }

      const commitCount = data.commits_pushed || 0;
      toast.success(`Pushed ${commitCount} commit${commitCount !== 1 ? 's' : ''} to remote`);

      onSuccess?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to push';
      toast.error(`Push failed: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        onClick={() => setShowConfirm(true)}
        disabled={disabled || loading}
        variant="secondary"
        className={className}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Upload className="h-4 w-4 mr-2" />
        )}
        Push to Remote
      </Button>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Push to Remote Repository?</AlertDialogTitle>
            <AlertDialogDescription>
              This will push the merged changes from the main branch to the remote repository.
              Make sure you've reviewed the changes before pushing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handlePush}>
              Push Changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
