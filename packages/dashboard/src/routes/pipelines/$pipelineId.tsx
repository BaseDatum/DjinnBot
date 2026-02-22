import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Save, CheckCircle, AlertCircle, ChevronRight, Info } from 'lucide-react';
import { useState, useEffect } from 'react';
import { fetchPipelineRaw, updatePipeline, validatePipeline } from '@/lib/api';
import yaml from 'js-yaml';

interface Agent {
  id: string;
  name: string;
  emoji?: string;
  model?: string;
}

interface Step {
  id: string;
  agent: string;
  model?: string;
  outputs?: string[];
  structured_output?: boolean;
}

interface PipelineData {
  id: string;
  name: string;
  version?: string;
  description?: string;
  defaults?: {
    model?: string;
    timeout?: number;
  };
  agents: Agent[];
  steps: Step[];
}

export const Route = createFileRoute('/pipelines/$pipelineId')({
  component: PipelineDetailPage,
});

function PipelineDetailPage() {
  const { pipelineId } = Route.useParams() as { pipelineId: string };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [yamlContent, setYamlContent] = useState('');
  const [originalYaml, setOriginalYaml] = useState('');
  const [pipelineData, setPipelineData] = useState<PipelineData | null>(null);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{ valid: boolean; errors: string[]; warnings: string[] } | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Load pipeline data
  useEffect(() => {
    async function loadPipeline() {
      try {
        setLoading(true);
        setError(null);
        const response = await fetchPipelineRaw(pipelineId);
        setYamlContent(response.yaml);
        setOriginalYaml(response.yaml);
        
        // Parse YAML to get structured data
        try {
          const parsed = parseYaml(response.yaml);
          setPipelineData(parsed);
        } catch (e) {
          console.error('Failed to parse YAML:', e);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load pipeline');
      } finally {
        setLoading(false);
      }
    }

    loadPipeline();
  }, [pipelineId]);

  // Track changes
  useEffect(() => {
    setIsDirty(yamlContent !== originalYaml);
  }, [yamlContent, originalYaml]);

  // Parse YAML using js-yaml library
  function parseYaml(yamlStr: string): PipelineData {
    const parsed = yaml.load(yamlStr) as any;
    return {
      id: parsed.id || pipelineId,
      name: parsed.name || pipelineId,
      version: parsed.version,
      description: parsed.description,
      defaults: parsed.defaults || {},
      agents: (parsed.agents || []).map((a: any) => ({
        id: a.id || '',
        name: a.name || '',
        emoji: a.emoji,
        model: a.model,
      })),
      steps: (parsed.steps || []).map((s: any) => ({
        id: s.id || '',
        agent: s.agent || '',
        model: s.model,
        outputs: s.outputs,
        structured_output: s.structured_output,
      })),
    };
  }

  async function handleSave() {
    try {
      setSaving(true);
      await updatePipeline(pipelineId, yamlContent);
      setOriginalYaml(yamlContent);
      setIsDirty(false);
      
      // Re-parse
      try {
        const parsed = parseYaml(yamlContent);
        setPipelineData(parsed);
      } catch (e) {
        console.error('Failed to parse YAML:', e);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save pipeline');
    } finally {
      setSaving(false);
    }
  }

  async function handleValidate() {
    try {
      setValidating(true);
      const result = await validatePipeline(pipelineId);
      setValidationResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to validate pipeline');
    } finally {
      setValidating(false);
    }
  }

  if (loading) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Loading Pipeline...</h1>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <div className="mb-8">
          <Link to="/pipelines">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Pipelines
            </Button>
          </Link>
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

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <Link to="/pipelines">
          <Button variant="ghost" size="sm" className="mb-4">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Pipelines
          </Button>
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              {pipelineData?.name || pipelineId}
            </h1>
            <p className="text-muted-foreground mt-1">
              {pipelineData?.description || 'No description'}
            </p>
            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
              <span>Steps: {pipelineData?.steps.length || 0}</span>
              <span>•</span>
              <span>Agents: {pipelineData?.agents.length || 0}</span>
              {pipelineData?.defaults?.model && (
                <>
                  <span>•</span>
                  <span>Default model: {pipelineData.defaults.model}</span>
                </>
              )}
            </div>
          </div>
          {pipelineData?.version && (
            <Badge variant="outline">v{pipelineData.version}</Badge>
          )}
        </div>
      </div>

      {/* Visual Step Flow */}
      {pipelineData && pipelineData.steps.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-lg">Pipeline Flow</CardTitle>
            <CardDescription>Visual representation of the pipeline steps</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 overflow-x-auto pb-4">
              {pipelineData.steps.map((step, idx) => {
                const agent = pipelineData.agents.find(a => a.id === step.agent || a.name === step.agent);
                // Resolve model using precedence: step > pipeline agent > pipeline default
                // (agent config.yml and global fallback are server-side only)
                const resolvedModel = step.model || agent?.model || pipelineData.defaults?.model;
                const modelSource = step.model
                  ? 'step'
                  : agent?.model
                    ? 'pipeline agent'
                    : pipelineData.defaults?.model
                      ? 'pipeline default'
                      : null;
                return (
                  <div key={step.id || idx} className="flex items-center gap-2">
                    <Card className="min-w-[200px] bg-muted/50">
                      <CardContent className="p-4">
                        <div className="font-mono text-sm font-semibold mb-1">
                          {step.id}
                        </div>
                        <div className="text-xs text-muted-foreground mb-2">
                          {agent?.emoji || '🤖'} {agent?.name || step.agent}
                        </div>
                        {resolvedModel ? (
                          <div className="flex items-center gap-1">
                            <Badge variant="secondary" className="text-xs">
                              {resolvedModel}
                            </Badge>
                            {modelSource && (
                              <span className="text-[10px] text-muted-foreground">
                                ({modelSource})
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-[10px] text-muted-foreground italic">
                            agent default / global fallback
                          </span>
                        )}
                        {step.structured_output && (
                          <Badge variant="outline" className="text-xs ml-1 mt-1">
                            structured
                          </Badge>
                        )}
                        {step.outputs && step.outputs.length > 0 && (
                          <div className="mt-2 text-xs text-muted-foreground">
                            Outputs: {step.outputs.join(', ')}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                    {idx < pipelineData.steps.length - 1 && (
                      <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agents and Defaults Panel */}
      <div className="grid gap-6 md:grid-cols-2 mb-6">
        {/* Agents */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Agents</CardTitle>
            <CardDescription>Specialized agents in this pipeline</CardDescription>
          </CardHeader>
          <CardContent>
            {pipelineData && pipelineData.agents.length > 0 ? (
              <div className="space-y-2">
                {pipelineData.agents.map((agent, idx) => (
                  <Link
                    key={agent.id || idx}
                    to="/agents/$agentId"
                    params={{ agentId: agent.id }}
                    search={{ tab: 'persona' }}
                    className="flex items-center justify-between rounded-md border p-3 hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{agent.emoji || '🤖'}</span>
                      <span className="font-medium">{agent.name || agent.id}</span>
                    </div>
                    {agent.model && (
                      <Badge variant="secondary" className="text-xs">
                        {agent.model}
                      </Badge>
                    )}
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No agents configured</p>
            )}
          </CardContent>
        </Card>

        {/* Defaults & Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Defaults & Settings</CardTitle>
            <CardDescription>Pipeline-level configuration</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {pipelineData?.defaults?.model && (
                <div className="flex items-center justify-between rounded-md border p-3">
                  <span className="text-sm font-medium">Default Model</span>
                  <Badge variant="outline">{pipelineData.defaults.model}</Badge>
                </div>
              )}
              {pipelineData?.defaults?.timeout && (
                <div className="flex items-center justify-between rounded-md border p-3">
                  <span className="text-sm font-medium">Timeout</span>
                  <Badge variant="outline">{pipelineData.defaults.timeoutSeconds}s</Badge>
                </div>
              )}
              
              {/* Model Precedence Info */}
              <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 text-blue-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="text-xs font-medium text-blue-400 mb-1">
                      Model Precedence
                    </div>
                    <div className="text-xs text-blue-300/80 space-y-0.5">
                      <div>1. Step model <span className="text-blue-400/60">(per-step override)</span></div>
                      <div>2. Pipeline agent model <span className="text-blue-400/60">(agent block in pipeline YAML)</span></div>
                      <div>3. Pipeline default model <span className="text-blue-400/60">(pipeline defaults)</span></div>
                      <div>4. Agent default model <span className="text-blue-400/60">(agent config.yml)</span></div>
                      <div>5. Global fallback</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Validation Results */}
      {validationResult && (
        <Card className={`mb-6 ${validationResult.valid ? 'border-green-500/50' : 'border-destructive/50'}`}>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              {validationResult.valid ? (
                <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              )}
              <div className="flex-1">
                <div className="font-medium mb-2">
                  {validationResult.valid ? 'Validation Passed' : 'Validation Failed'}
                </div>
                {validationResult.errors.length > 0 && (
                  <div className="mb-2">
                    <div className="text-sm font-medium text-destructive mb-1">Errors:</div>
                    <ul className="text-sm text-destructive/80 list-disc list-inside space-y-1">
                      {validationResult.errors.map((err, idx) => (
                        <li key={idx}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {validationResult.warnings.length > 0 && (
                  <div>
                    <div className="text-sm font-medium text-yellow-500 mb-1">Warnings:</div>
                    <ul className="text-sm text-yellow-500/80 list-disc list-inside space-y-1">
                      {validationResult.warnings.map((warn, idx) => (
                        <li key={idx}>{warn}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* YAML Editor */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">YAML Editor</CardTitle>
              <CardDescription>
                Edit the raw pipeline configuration
                {isDirty && <span className="text-yellow-500 ml-2">• Unsaved changes</span>}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleValidate}
                disabled={validating}
              >
                {validating ? 'Validating...' : 'Validate'}
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || !isDirty}
              >
                <Save className="mr-2 h-4 w-4" />
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <textarea
            value={yamlContent}
            onChange={(e) => setYamlContent(e.target.value)}
            className="w-full min-h-[500px] bg-muted font-mono text-sm p-4 rounded-md border resize-y"
            spellCheck={false}
          />
        </CardContent>
      </Card>
    </div>
  );
}
