import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Workflow, Bot, GitBranch, AlertCircle } from 'lucide-react';
import { useState, useEffect } from 'react';
import { fetchPipelines } from '@/lib/api';

interface Agent {
  name: string;
  model?: string;
}

interface Step {
  id: string;
  agent: string;
}

interface Pipeline {
  id: string;
  name: string;
  version: string;
  description?: string;
  steps: Step[];
  agents: Agent[];
}

export const Route = createFileRoute('/pipelines/' as any)({
  component: PipelinesPage,
});

export function PipelinesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);

  useEffect(() => {
    async function loadPipelines() {
      try {
        setLoading(true);
        setError(null);
        const response = await fetchPipelines();
        setPipelines(Array.isArray(response) ? response : response.pipelines || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load pipelines');
      } finally {
        setLoading(false);
      }
    }

    loadPipelines();
  }, []);

  if (loading) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <div className="mb-8 flex items-center gap-3">
          <Workflow className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Pipelines</h1>
            <p className="text-muted-foreground">
              Configure and orchestrate agent workflows
            </p>
          </div>
        </div>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Loading pipelines...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <div className="mb-8 flex items-center gap-3">
          <Workflow className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Pipelines</h1>
            <p className="text-muted-foreground">
              Configure and orchestrate agent workflows
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="p-4 md:p-8">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <p>Error: {error}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (pipelines.length === 0) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <div className="mb-8 flex items-center gap-3">
          <Workflow className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Pipelines</h1>
            <p className="text-muted-foreground">
              Configure and orchestrate agent workflows
            </p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
                <Workflow className="h-6 w-6" />
              </div>
              <div>
                <CardTitle>No Pipelines Yet</CardTitle>
                <CardDescription>
                  Create your first pipeline to orchestrate agent workflows
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                Pipelines define multi-step workflows with specialized agents.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <div className="mb-8 flex items-center gap-3">
        <Workflow className="h-8 w-8 shrink-0" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Pipelines</h1>
          <p className="text-muted-foreground">
            Configure and orchestrate agent workflows
          </p>
        </div>
      </div>

      <div className="grid gap-6">
        {pipelines.map((pipeline) => (
          <Link key={pipeline.id} to={`/pipelines/${pipeline.id}`}>
            <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
                      <Workflow className="h-6 w-6" />
                    </div>
                    <div>
                      <CardTitle className="text-xl">{pipeline.name}</CardTitle>
                      <CardDescription>
                        {pipeline.description || 'No description'}
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant="outline">v{pipeline.version}</Badge>
                </div>
              </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:gap-6 grid-cols-1 md:grid-cols-2">
                {/* Agents Section */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Bot className="h-4 w-4 text-muted-foreground" />
                    <h4 className="text-sm font-medium">
                      Agents ({pipeline.agents?.length || 0})
                    </h4>
                  </div>
                  {pipeline.agents && pipeline.agents.length > 0 ? (
                    <div className="space-y-2">
                      {pipeline.agents.map((agent, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between rounded-md border p-2"
                        >
                          <span className="text-sm font-medium">{agent.name}</span>
                          {agent.model && (
                            <Badge variant="secondary" className="text-xs">
                              {agent.model}
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No agents configured</p>
                  )}
                </div>

                {/* Steps Section */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    <h4 className="text-sm font-medium">
                      Steps ({pipeline.steps?.length || 0})
                    </h4>
                  </div>
                  {pipeline.steps && pipeline.steps.length > 0 ? (
                    <div className="space-y-2">
                      {pipeline.steps.map((step, idx) => (
                        <div
                          key={step.id || idx}
                          className="flex items-center gap-3 rounded-md border p-2"
                        >
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                            {idx + 1}
                          </span>
                          <span className="font-mono text-sm">{step.id}</span>
                          <Badge variant="outline" className="ml-auto text-xs">
                            {step.agent}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No steps configured</p>
                  )}
                </div>
              </div>
            </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
