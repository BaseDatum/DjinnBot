import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConnectionStatus } from './ConnectionStatus';
import { EventAssignments } from './EventAssignments';
import { WebhookLog } from './WebhookLog';

interface GitHubInstallation {
  id: string;
  projectId: string;
  installationId: number;
  owner: string;
  repo: string;
  permissions: Record<string, string>;
  events: string[];
  createdAt: string;
  updatedAt: string;
}

interface GitHubSettingsProps {
  projectId: string;
}

export function GitHubSettings({ projectId }: GitHubSettingsProps) {
  const [installation, setInstallation] = useState<GitHubInstallation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchInstallation();
  }, [projectId]);

  async function fetchInstallation() {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch(`${API_BASE}/projects/${projectId}/github/status`);
      if (response.ok) {
        const data = await response.json();
        setInstallation(data);
      } else if (response.status === 404) {
        // No installation found - this is expected for projects without GitHub integration
        setInstallation(null);
      } else {
        throw new Error('Failed to load GitHub status');
      }
    } catch (err) {
      console.error('Failed to fetch GitHub installation:', err);
      setError(err instanceof Error ? err.message : 'Failed to load GitHub status');
      toast.error('Failed to load GitHub status');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">GitHub Integration</h2>
        <p className="text-muted-foreground mt-1">
          Connect your repository and configure automated agent responses
        </p>
      </div>

      <ConnectionStatus 
        projectId={projectId}
        installation={installation} 
        onRefresh={fetchInstallation} 
      />

      {installation && (
        <>
          <EventAssignments projectId={projectId} />
          <WebhookLog projectId={projectId} />
        </>
      )}
    </div>
  );
}
