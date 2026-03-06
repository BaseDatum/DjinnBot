import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDownCircle, ExternalLink, Loader2, RefreshCw, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  fetchUpdateCheck,
  forceUpdateCheck,
  applyUpdate,
  type UpdateCheckResult,
} from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { UpdateOverlay } from '@/components/layout/UpdateOverlay';

/**
 * Small icon button shown in the sidebar footer when an update is available.
 * Clicking opens a dialog with release notes, a link to the release, and
 * an "Update Now" button that triggers the engine to pull + recreate.
 *
 * Once the update is triggered, a full-page animated overlay takes over
 * that polls the API and auto-reloads when the new version is live.
 */
export function UpdateIndicator() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const queryClient = useQueryClient();

  // Poll for update status every hour (server caches it, so this is cheap)
  const { data: updateCheck } = useQuery<UpdateCheckResult>({
    queryKey: ['system-update-check'],
    queryFn: fetchUpdateCheck,
    staleTime: 60 * 60 * 1000, // 1 hour
    refetchInterval: 60 * 60 * 1000, // 1 hour
    retry: 1,
  });

  const refreshMutation = useMutation({
    mutationFn: forceUpdateCheck,
    onSuccess: (data) => {
      queryClient.setQueryData(['system-update-check'], data);
    },
  });

  const applyMutation = useMutation({
    mutationFn: (version?: string) => applyUpdate(version ?? undefined),
    onSuccess: () => {
      // Close the dialog and show the full-page overlay
      setDialogOpen(false);
      setShowOverlay(true);
    },
  });

  const handleRefresh = useCallback(() => {
    refreshMutation.mutate();
  }, [refreshMutation]);

  const handleApply = useCallback(() => {
    if (!updateCheck?.latest_version) return;
    applyMutation.mutate(updateCheck.latest_version);
  }, [applyMutation, updateCheck]);

  // Don't render anything if no update is available (and overlay not active)
  if (!updateCheck?.update_available && !showOverlay) {
    return null;
  }

  return (
    <>
      {/* Full-page update overlay (shown after triggering update) */}
      {showOverlay && updateCheck?.latest_version && (
        <UpdateOverlay targetVersion={updateCheck.latest_version} />
      )}

      {/* Sidebar indicator button */}
      {updateCheck?.update_available && (
        <button
          onClick={() => setDialogOpen(true)}
          className={cn(
            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
            'text-emerald-600 dark:text-emerald-400',
            'transition-colors hover:bg-emerald-50 dark:hover:bg-emerald-950/30',
          )}
          title={`Update available: ${updateCheck.latest_version}`}
        >
          <ArrowDownCircle className="h-4 w-4" />
          <span className="flex-1 text-left">Update available</span>
          <span className="text-xs opacity-70">{updateCheck.latest_version}</span>
        </button>
      )}

      {/* Update dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowDownCircle className="h-5 w-5 text-emerald-500" />
              DjinnBot Update Available
            </DialogTitle>
            <DialogDescription>
              {updateCheck?.current_version} &rarr; {updateCheck?.latest_version}
            </DialogDescription>
          </DialogHeader>

          {/* Release info */}
          <div className="flex-1 overflow-y-auto space-y-4 min-h-0">
            {/* Release name */}
            {updateCheck?.release_name && (
              <div>
                <h3 className="text-base font-semibold">{updateCheck.release_name}</h3>
                {updateCheck.published_at && (
                  <p className="text-xs text-muted-foreground">
                    Published {new Date(updateCheck.published_at).toLocaleDateString()}
                  </p>
                )}
              </div>
            )}

            {/* Release notes (markdown) */}
            {updateCheck?.release_body && (
              <div className="rounded-md border bg-muted/30 p-4 text-sm overflow-y-auto max-h-[40vh]">
                <MarkdownRenderer content={updateCheck.release_body} />
              </div>
            )}

            {/* Link to release */}
            {updateCheck?.release_url && (
              <a
                href={updateCheck.release_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View release on GitHub
              </a>
            )}

            {/* Error message */}
            {applyMutation.isError && (
              <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">
                Failed to trigger update: {(applyMutation.error as Error)?.message || 'Unknown error'}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between pt-2 border-t">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshMutation.isPending}
            >
              {refreshMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1.5" />
              )}
              Re-check
            </Button>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
                Later
              </Button>
              <Button
                size="sm"
                onClick={handleApply}
                disabled={applyMutation.isPending}
              >
                {applyMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    Updating...
                  </>
                ) : (
                  <>
                    <ArrowDownCircle className="h-4 w-4 mr-1.5" />
                    Update Now
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
