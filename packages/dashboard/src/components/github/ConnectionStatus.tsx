import { API_BASE } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { CheckCircle2, XCircle, RefreshCw, ExternalLink } from 'lucide-react';

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

interface ConnectionStatusProps {
  projectId: string;
  installation: GitHubInstallation | null;
  onRefresh: () => void;
}

export function ConnectionStatus({ projectId, installation, onRefresh }: ConnectionStatusProps) {
  const isConnected = installation !== null;

  const handleInstall = () => {
    // Redirect to GitHub App installation flow
    window.location.href = `${API_BASE}/github/install?project_id=${projectId}`;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            {isConnected ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <XCircle className="h-5 w-5 text-red-500" />
            )}
            Connection Status
          </CardTitle>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isConnected ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Repository</p>
                <p className="font-medium flex items-center gap-2">
                  {installation.owner}/{installation.repo}
                  <a
                    href={`https://github.com/${installation.owner}/${installation.repo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:text-blue-600"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground mb-1">Installation ID</p>
                <p className="font-medium font-mono">{installation.installationId}</p>
              </div>
            </div>

            {installation.permissions && Object.keys(installation.permissions).length > 0 && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">Permissions</p>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(installation.permissions).map(([key, value]) => (
                    <Badge key={key} variant="secondary">
                      {key}: {value}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {installation.events && installation.events.length > 0 && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">Subscribed Events</p>
                <div className="flex flex-wrap gap-2">
                  {installation.events.map((event) => (
                    <Badge key={event} variant="outline">
                      {event}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              Connected {new Date(installation.createdAt).toLocaleDateString()}
            </div>
          </div>
        ) : (
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-4">
              No GitHub App installation found for this project
            </p>
            <Button onClick={handleInstall}>
              Install GitHub App
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
