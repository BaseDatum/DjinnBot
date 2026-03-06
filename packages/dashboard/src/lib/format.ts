/**
 * Map run/step status to Badge variant.
 */
export function getStatusVariant(status: string): string {
  switch (status) {
    case 'completed': return 'success';
    case 'failed': return 'destructive';
    case 'running': return 'default';
    default: return 'outline';
  }
}

/**
 * Format a duration from run timestamps.
 */
export function formatDuration(createdAt: number, completedAt?: number | null, preformatted?: string): string {
  if (preformatted) return preformatted;
  if (!createdAt) return 'N/A';
  const start = new Date(createdAt);
  const end = completedAt ? new Date(completedAt) : new Date();
  const seconds = Math.floor((end.getTime() - start.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Format a "provider/model-id" string into "Provider · model-name".
 */
export function formatModelChip(model: string): string {
  const slashIdx = model.indexOf('/');
  if (slashIdx === -1) return model;
  const provider = model.slice(0, slashIdx);
  const modelName = model.slice(slashIdx + 1).split('/').pop() ?? model;
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
  return `${providerLabel} · ${modelName}`;
}

/**
 * Format a timestamp as relative time (e.g., "5m ago").
 */
export function formatTimeAgo(timestamp: number): string {
  const now = new Date();
  const seconds = Math.floor((now.getTime() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
