import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Play, RotateCcw, Square, ChevronDown, ChevronRight, Brain, X, Trash2 } from 'lucide-react';
import { useState, useEffect, useRef, Fragment } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { fetchRun, fetchRunLogs, restartStep, cancelRun, restartRun, startRun, deleteRun, API_BASE } from '@/lib/api';
import { WorkspacePanel } from '@/components/workspace/WorkspacePanel';
import { GitHistory } from '@/components/workspace/GitHistory';
import { useSSE } from '@/hooks/useSSE';
import { SlackChatFeed, type SlackMessage } from '@/components/SlackChatFeed';
import { getStatusVariant, formatDuration } from '@/lib/format';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { KeySourceBadge } from '@/components/ui/KeySourceBadge';
import { LlmCallLog } from '@/components/admin/LlmCallLog';
import { SessionTokenStats } from '@/components/ui/SessionTokenStats';
import { ToolCallCard } from '@/components/ToolCallCard';
import { AgentActivityBar } from '@/components/AgentActivityBar';
import { ContainerStatusCard } from '@/components/container/ContainerStatus';
import { ContainerEventStream } from '@/components/container/ContainerEventStream';
import { MountInfo } from '@/components/container/MountInfo';
import type { ContainerEvent, ContainerStatus } from '@/types/container';

interface Step {
  id: string;
  step_id: string;
  agent_id: string;
  status: string;
  outputs: Record<string, string>;
  error: string | null;
  retry_count: number;
  started_at: number | null;
  completed_at: number | null;
  model_used?: string | null;
}

interface RunDetail {
  id: string;
  pipeline_id?: string;
  agent_id?: string;
  status: string;
  created_at: number;
  completed_at?: number | null;
  duration?: string;
  task?: string;
  context?: string;
  steps?: Step[];
  workspace_type?: string | null;
  workspace_has_git?: boolean;
}

/** A segment of agent output — either text, thinking, event, or tool_call */
interface OutputSegment {
  type: 'text' | 'thinking' | 'event' | 'tool_call';
  content: string;
  stepId?: string;
  timestamp?: number;
  toolName?: string;
  toolCallId?: string;
  args?: string;
  result?: string;
  isError?: boolean;
  durationMs?: number;
  toolStatus?: 'running' | 'complete' | 'error';
}

export const Route = createFileRoute('/runs/$runId')({
  component: RunDetailPage,
});

/** Expandable thinking block component */
function ThinkingBlock({ content, stepId }: { content: string; stepId?: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-2 rounded-md border border-purple-500/30 bg-purple-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-purple-400 hover:text-purple-300 transition-colors"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Brain className="h-3 w-3" />
        <span className="font-medium">Agent Thinking</span>
        {stepId && <span className="text-purple-500/60">({stepId})</span>}
        {!expanded && (
          <span className="ml-2 truncate text-purple-500/50 max-w-[300px]">
            {content.slice(0, 80)}…
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-purple-500/20 px-3 py-2 text-xs text-purple-300/80 whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-auto">
          {content}
        </div>
      )}
    </div>
  );
}

/** Compact horizontal step timeline */
function StepTimeline({ steps, onRestartStep }: { steps: Step[]; onRestartStep: (stepId: string, agentId: string) => void }) {
  // Any step that isn't currently running can be restarted
  const canRestart = (status: string) => status !== 'running' && status !== 'queued';
  return (
    <div className="flex items-center gap-1 overflow-x-auto py-2 px-1">
      {steps.map((step, idx) => (
        <Fragment key={step.step_id}>
          {idx > 0 && <div className="h-px w-4 bg-zinc-700 flex-shrink-0" />}
          <button
            onClick={() => canRestart(step.status) ? onRestartStep(step.step_id, step.agent_id) : undefined}
            title={canRestart(step.status) ? `Restart ${step.step_id}` : undefined}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs flex-shrink-0 ${
              canRestart(step.status) ? 'hover:ring-1 hover:ring-zinc-500 cursor-pointer' : 'cursor-default'
            } ${
              step.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400' :
              step.status === 'running' ? 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/30' :
              step.status === 'queued' ? 'bg-yellow-500/10 text-yellow-400' :
              step.status === 'failed' ? 'bg-red-500/10 text-red-400' :
              'bg-zinc-800 text-zinc-500'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${
              step.status === 'completed' ? 'bg-emerald-400' :
              step.status === 'running' ? 'bg-blue-400 animate-pulse' :
              step.status === 'queued' ? 'bg-yellow-400 animate-pulse' :
              step.status === 'failed' ? 'bg-red-400' :
              'bg-zinc-600'
            }`} />
            <span className="font-mono">{step.step_id}</span>
            <span className="text-zinc-600">{step.agent_id}</span>
            {step.model_used && (
              <span className="text-zinc-600 font-mono text-[10px]" title={step.model_used}>
                {step.model_used.length > 20 ? step.model_used.slice(0, 20) + '...' : step.model_used}
              </span>
            )}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

function RunDetailPage() {
  const { runId } = Route.useParams() as { runId: string };
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [segments, setSegments] = useState<OutputSegment[]>([]);
  const [slackMessages, setSlackMessages] = useState<SlackMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [agentState, setAgentState] = useState<{ state: string; toolName?: string } | null>(null);
  const [fileChangedEvents, setFileChangedEvents] = useState<Array<{ path: string; timestamp: number }>>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [restartModal, setRestartModal] = useState<{ stepId: string; agentId: string } | null>(null);
  const [restartContext, setRestartContext] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; desc: string; action: () => void } | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  
  // Container events state
  const [containerEvents, setContainerEvents] = useState<ContainerEvent[]>([]);
  const [containerStatus, setContainerStatus] = useState<ContainerStatus | null>(null);

  // Auto-scroll to bottom when new segments appear
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments]);

  // Load initial run data
  useEffect(() => {
    async function loadRun() {
      try {
        setLoading(true);
        setError(null);
        const data = await fetchRun(runId);
        setRun(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load run');
      } finally {
        setLoading(false);
      }
    }
    loadRun();
  }, [runId]);

  // Hydrate historical events when run data first arrives or after a restart
  // (historyLoaded gates this so we don't re-run on every minor run state update)
  useEffect(() => {
    if (!run || historyLoaded) return;
    
    fetchRunLogs(runId).then((logs) => {
      const historicalSegments: OutputSegment[] = [];
      const historicalSlackMessages: SlackMessage[] = [];
      
      for (const event of logs) {
        switch (event.type) {
          case 'STEP_OUTPUT': {
            const last = historicalSegments[historicalSegments.length - 1];
            if (last?.type === 'text' && last?.stepId === event.stepId) {
              last.content += event.chunk;
            } else {
              historicalSegments.push({ type: 'text', content: event.chunk, stepId: event.stepId, timestamp: event.timestamp });
            }
            break;
          }
          case 'STEP_THINKING': {
            const last = historicalSegments[historicalSegments.length - 1];
            if (last?.type === 'thinking' && last?.stepId === event.stepId) {
              last.content += event.chunk;
            } else {
              historicalSegments.push({ type: 'thinking', content: event.chunk, stepId: event.stepId, timestamp: event.timestamp });
            }
            break;
          }
          case 'STEP_STARTED':
          case 'STEP_COMPLETE':
          case 'STEP_FAILED':
          case 'RUN_COMPLETE':
          case 'RUN_FAILED': {
            const msg =
              event.type === 'STEP_STARTED' ? `▶️ Step ${event.stepId} started` :
              event.type === 'STEP_COMPLETE' ? `✅ Step ${event.stepId} completed` :
              event.type === 'STEP_FAILED' ? `❌ Step ${event.stepId} failed: ${event.error}` :
              event.type === 'RUN_COMPLETE' ? '🎉 Run completed!' :
              `💥 Run failed: ${event.error}`;
            historicalSegments.push({ type: 'event', content: msg, stepId: event.stepId, timestamp: event.timestamp });
            break;
          }
          case 'SLACK_MESSAGE': {
            historicalSlackMessages.push({
              agentId: event.agentId,
              agentName: event.agentName,
              agentEmoji: event.agentEmoji,
              userId: event.userId,
              userName: event.userName,
              message: event.message,
              isAgent: event.isAgent,
              threadTs: event.threadTs,
              messageTs: event.messageTs,
              timestamp: event.timestamp,
            });
            break;
          }
          case 'TOOL_CALL_START': {
            historicalSegments.push({
              type: 'tool_call',
              content: '',
              stepId: event.stepId,
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              args: event.args,
              toolStatus: 'running',
              timestamp: event.timestamp,
            });
            break;
          }
          case 'TOOL_CALL_END': {
            const idx = [...historicalSegments].reverse().findIndex(
              s => s.type === 'tool_call' && s.toolCallId === event.toolCallId
            );
            if (idx >= 0) {
              const realIdx = historicalSegments.length - 1 - idx;
              historicalSegments[realIdx] = {
                ...historicalSegments[realIdx],
                result: event.result,
                isError: event.isError,
                durationMs: event.durationMs,
                toolStatus: event.isError ? 'error' : 'complete',
              };
            }
            break;
          }
        }
      }
      
      setSegments(historicalSegments);
      setSlackMessages(historicalSlackMessages);
      setHistoryLoaded(true);
    }).catch((err) => {
      console.warn('Failed to load historical logs:', err);
      setHistoryLoaded(true);
    });
  }, [run, runId]);

  // Connect to SSE for live updates
  const { status: sseStatus } = useSSE<any>({
    url: `${API_BASE}/events/stream/${runId}`,
    enabled: run?.status === 'running' && historyLoaded,
    onMessage: (event) => {
      switch (event.type) {
        case 'STEP_OUTPUT':
          setSegments(prev => {
            // Append to existing text segment for same step, or create new
            const last = prev[prev.length - 1];
            if (last?.type === 'text' && last?.stepId === event.stepId) {
              return [...prev.slice(0, -1), { ...last, content: last.content + event.chunk }];
            }
            return [...prev, { type: 'text', content: event.chunk, stepId: event.stepId, timestamp: event.timestamp }];
          });
          break;

        case 'STEP_THINKING':
          setSegments(prev => {
            // Append to existing thinking segment for same step
            const last = prev[prev.length - 1];
            if (last?.type === 'thinking' && last?.stepId === event.stepId) {
              return [...prev.slice(0, -1), { ...last, content: last.content + event.chunk }];
            }
            return [...prev, { type: 'thinking', content: event.chunk, stepId: event.stepId, timestamp: event.timestamp }];
          });
          break;

        case 'STEP_STARTED':
        case 'STEP_COMPLETE':
        case 'STEP_FAILED':
        case 'RUN_COMPLETE':
        case 'RUN_FAILED': {
          const msg =
            event.type === 'STEP_STARTED' ? `▶️ Step ${event.stepId} started (session: ${event.sessionId || 'n/a'})` :
            event.type === 'STEP_COMPLETE' ? `✅ Step ${event.stepId} completed` :
            event.type === 'STEP_FAILED' ? `❌ Step ${event.stepId} failed: ${event.error}` :
            event.type === 'RUN_COMPLETE' ? '🎉 Run completed!' :
            `💥 Run failed: ${event.error}`;
          setSegments(prev => [...prev, { type: 'event', content: msg, stepId: event.stepId, timestamp: event.timestamp }]);
          
          // Update run status
          if (event.type === 'RUN_COMPLETE') {
            setRun(prev => prev ? { ...prev, status: 'completed' } : prev);
            setAgentState(null);
          }
          if (event.type === 'RUN_FAILED') {
            setRun(prev => prev ? { ...prev, status: 'failed' } : prev);
            setAgentState(null);
          }
          if (event.type === 'STEP_COMPLETE' || event.type === 'STEP_FAILED') {
            // Refresh run data to get updated steps
            fetchRun(runId).then(data => setRun(data)).catch(() => {});
          }
          break;
        }

        case 'SLACK_MESSAGE':
          setSlackMessages(prev => [...prev, {
            agentId: event.agentId,
            agentName: event.agentName,
            agentEmoji: event.agentEmoji,
            userId: event.userId,
            userName: event.userName,
            message: event.message,
            isAgent: event.isAgent,
            threadTs: event.threadTs,
            messageTs: event.messageTs,
            timestamp: event.timestamp,
          }]);
          break;

        case 'TOOL_CALL_START':
          setSegments(prev => [...prev, {
            type: 'tool_call',
            content: '',
            stepId: event.stepId,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
            toolStatus: 'running',
            timestamp: event.timestamp,
          }]);
          break;

        case 'TOOL_CALL_END':
          setSegments(prev => {
            const idx = [...prev].reverse().findIndex(
              s => s.type === 'tool_call' && s.toolCallId === event.toolCallId && s.toolStatus === 'running'
            );
            if (idx >= 0) {
              const realIdx = prev.length - 1 - idx;
              const updated = [...prev];
              updated[realIdx] = {
                ...updated[realIdx],
                result: event.result,
                isError: event.isError,
                durationMs: event.durationMs,
                toolStatus: event.isError ? 'error' : 'complete',
              };
              return updated;
            }
            return prev;
          });
          break;

        case 'AGENT_STATE':
          setAgentState({ state: event.state, toolName: event.toolName });
          break;

        case 'FILE_CHANGED':
          setFileChangedEvents(prev => [...prev, { path: event.path, timestamp: event.timestamp }]);
          break;
        
        // Container lifecycle events (published by engine via ContainerRunner)
        case 'CONTAINER_CREATED':
        case 'CONTAINER_STARTING':
        case 'CONTAINER_READY':
        case 'CONTAINER_STOPPING':
        case 'CONTAINER_DESTROYED':
          setContainerEvents(prev => [...prev, event as ContainerEvent]);
          if (event.type === 'CONTAINER_READY') setContainerStatus('ready' as ContainerStatus);
          if (event.type === 'CONTAINER_DESTROYED') setContainerStatus(null);
          break;

        // Container status events (from container's internal protocol)
        case 'ready':
        case 'busy':
        case 'idle':
        case 'error':
        case 'exiting':
          setContainerStatus(event.type as ContainerStatus);
          setContainerEvents(prev => [...prev, event as ContainerEvent]);
          break;
        
        // Container step events
        case 'stepStart':
        case 'stepEnd':
          setContainerEvents(prev => [...prev, event as ContainerEvent]);
          break;
        
        // Container tool events
        case 'toolStart':
        case 'toolEnd':
          setContainerEvents(prev => [...prev, event as ContainerEvent]);
          break;
        
        // Container output events
        case 'stdout':
        case 'stderr':
          setContainerEvents(prev => [...prev, event as ContainerEvent]);
          break;
        
        // Container messaging events
        case 'agentMessage':
        case 'slackDm':
          setContainerEvents(prev => [...prev, event as ContainerEvent]);
          break;
      }
    },
  });

  const handleRestart = async () => {
    if (!restartModal) return;
    setRestarting(true);
    try {
      await restartStep(runId, restartModal.stepId, restartContext || undefined);
      // Clear stale output and reset hydration state so the log re-fetches
      // cleanly and SSE reconnects once the run transitions to running.
      setSegments([]);
      setSlackMessages([]);
      setHistoryLoaded(false);
      setAgentState(null);
      setContainerEvents([]);
      setContainerStatus(null);
      const data = await fetchRun(runId);
      setRun(data);
      setRestartModal(null);
      setRestartContext('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to restart step');
    } finally {
      setRestarting(false);
    }
  };

  const handleDeleteRun = async () => {
    setConfirmAction({
      title: 'Delete Run',
      desc: 'Are you sure you want to delete this run? This action cannot be undone.',
      action: async () => {
        try {
          await deleteRun(runId);
          navigate({ to: '/runs' });
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to delete run');
        }
      }
    });
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8">
        <Link to="/runs" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to runs
        </Link>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Loading run details...</p>
        </div>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="p-4 md:p-8">
        <Link to="/runs" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to runs
        </Link>
        <Card>
          <CardContent className="p-4 md:p-8">
            <p className="text-destructive">Error: {error || 'Run not found'}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8">
      <div className="mb-8">
        <Link to="/runs" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to runs
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl md:text-3xl font-bold tracking-tight font-mono truncate">{run.id.substring(0, 12)}…</h1>
            <p className="text-muted-foreground">
              {run.pipeline_id ? `Pipeline: ${run.pipeline_id}` : run.agent_id ? `Agent: ${run.agent_id}` : 'Unknown source'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {run.status === 'running' ? (
              <Button variant="outline" onClick={() => {
                setConfirmAction({
                  title: 'Stop Run',
                  desc: 'Are you sure you want to stop this run? This cannot be undone.',
                  action: async () => {
                    try {
                      await cancelRun(runId);
                      const data = await fetchRun(runId);
                      setRun(data);
                    } catch (err) {
                      alert(err instanceof Error ? err.message : 'Failed to stop run');
                    }
                  }
                });
              }}>
                <Square className="mr-2 h-4 w-4" />
                Stop
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => {
                  setConfirmAction({
                    title: 'Restart Run',
                    desc: 'Are you sure you want to restart this run from scratch? All progress will be lost.',
                    action: async () => {
                      try {
                        const data = await restartRun(runId);
                        setRun(data);
                        setSegments([]);
                        setSlackMessages([]);
                      } catch (err) {
                        alert(err instanceof Error ? err.message : 'Failed to restart run');
                      }
                    }
                  });
                }}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Restart
                </Button>
                <Button onClick={async () => {
                  if (!run?.pipeline_id || !run?.task) return;
                  try {
                    const newRun = await startRun(run.pipeline_id, run.task);
                    navigate({ to: '/runs/$runId', params: { runId: newRun.id } });
                  } catch (err) {
                    alert(err instanceof Error ? err.message : 'Failed to start new run');
                  }
                }}>
                  <Play className="mr-2 h-4 w-4" />
                  Run Again
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={handleDeleteRun} className="text-destructive hover:text-destructive">
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </div>
        </div>
      </div>

      {/* Compact Step Timeline */}
      {run.steps && run.steps.length > 0 && (
        <Card className="mb-4">
          <CardContent className="py-2">
            <StepTimeline steps={run.steps} onRestartStep={(stepId, agentId) => setRestartModal({ stepId, agentId })} />
          </CardContent>
        </Card>
      )}

      {/* Git History — only shown for git workspace runs */}
      {(run.workspace_type === 'git_worktree' || (!run.workspace_type && run.workspace_has_git)) && (
        <GitHistory runId={runId} />
      )}

      {/* Container Status */}
      {containerStatus && (
        <div className="mb-4">
          <ContainerStatusCard 
            status={containerStatus} 
            runId={run?.id}
            lastUpdate={containerEvents.length > 0 ? containerEvents[containerEvents.length - 1].timestamp : undefined}
          />
        </div>
      )}

      {/* Main Split Pane */}
      <div className="h-[calc(100vh-16rem)]">
        <PanelGroup orientation="vertical" id="djinnbot-run-panels-outer">
          <Panel defaultSize={70} minSize={40}>
            <PanelGroup orientation="horizontal" id="djinnbot-run-panels-inner">
              <Panel defaultSize={60} minSize={30}>
                <Card className="h-full flex flex-col">
                  <CardHeader className="flex-shrink-0 py-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">Agent Output</CardTitle>
                      <AgentActivityBar
                        runStatus={run.status}
                        agentState={agentState}
                        sseStatus={sseStatus}
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 overflow-auto p-0">
                    <div className="p-4 font-mono text-sm">
                      {segments.length > 0 ? (
                        segments.map((seg, i) => {
                          if (seg.type === 'thinking') {
                            return <ThinkingBlock key={i} content={seg.content} stepId={seg.stepId} />;
                          }
                          if (seg.type === 'event') {
                            return (
                              <div key={i} className="my-2 py-1 px-2 rounded bg-zinc-800/50 text-xs text-zinc-400 border-l-2 border-zinc-600">
                                {seg.content}
                              </div>
                            );
                          }
                          if (seg.type === 'tool_call') {
                            return (
                              <ToolCallCard
                                key={i}
                                toolName={seg.toolName!}
                                args={seg.args}
                                result={seg.result}
                                isError={seg.isError}
                                durationMs={seg.durationMs}
                                status={seg.toolStatus!}
                              />
                            );
                          }
                          return <MarkdownRenderer key={i} content={seg.content} />;
                        })
                      ) : (
                        <p className="text-zinc-500">
                          {run.status === 'running' ? 'Waiting for agent output...' : 'No output recorded'}
                        </p>
                      )}
                      <div ref={logEndRef} />
                    </div>
                  </CardContent>
                </Card>
              </Panel>

              <PanelResizeHandle className="w-1.5 bg-zinc-800 hover:bg-zinc-600 transition-colors cursor-col-resize mx-1" />

              <Panel defaultSize={40} minSize={20} collapsible>
                <WorkspacePanel runId={runId} fileChangedEvents={fileChangedEvents} />
              </Panel>
            </PanelGroup>
          </Panel>

          <PanelResizeHandle className="h-1.5 bg-zinc-800 hover:bg-zinc-600 transition-colors cursor-row-resize my-1" />

          <Panel defaultSize={30} minSize={15} collapsible>
            <ContainerEventStream 
              events={containerEvents}
              maxHeight="100%"
            />
          </Panel>
        </PanelGroup>
      </div>

      {/* Collapsible Details Footer */}
      <div className="mt-4">
        <button
          onClick={() => setDetailsOpen(!detailsOpen)}
          className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-400 mb-2"
        >
          {detailsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Run Details & Chat
        </button>
        {detailsOpen && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Run Details</CardTitle></CardHeader>
              <CardContent>
                <dl className="space-y-2">
                  <div className="flex justify-between">
                    <dt className="text-sm text-muted-foreground">Status</dt>
                    <dd><Badge variant={getStatusVariant(run.status) as any}>{run.status}</Badge></dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-sm text-muted-foreground">Started</dt>
                    <dd className="text-sm">{new Date(run.created_at).toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-sm text-muted-foreground">Duration</dt>
                    <dd className="text-sm">{formatDuration(run.created_at, run.completed_at, run.duration)}</dd>
                  </div>
                  {run.pipeline_id && (
                    <div className="flex justify-between">
                      <dt className="text-sm text-muted-foreground">Pipeline</dt>
                      <dd className="text-sm">{run.pipeline_id}</dd>
                    </div>
                  )}
                  {run.task && (
                    <div className="flex flex-col gap-1">
                      <dt className="text-sm text-muted-foreground">Task</dt>
                      <dd className="text-sm break-words">{run.task}</dd>
                    </div>
                  )}
                  {run.initiated_by_user_id && (
                    <div className="flex justify-between">
                      <dt className="text-sm text-muted-foreground">Initiated By</dt>
                      <dd className="text-sm font-mono text-xs">{run.initiated_by_user_id.substring(0, 12)}...</dd>
                    </div>
                  )}
                  {run.model_override && (
                    <div className="flex justify-between">
                      <dt className="text-sm text-muted-foreground">Model Override</dt>
                      <dd className="text-sm font-mono text-xs">{run.model_override}</dd>
                    </div>
                  )}
                  {run.key_resolution && (
                    <div className="flex flex-col gap-1">
                      <dt className="text-sm text-muted-foreground">Keys Used</dt>
                      <dd>
                        <KeySourceBadge keyResolution={run.key_resolution} showProviders showKeyDetails />
                      </dd>
                    </div>
                  )}
                  {/* Token usage summary */}
                  <div className="flex flex-col gap-1">
                    <dt className="text-sm text-muted-foreground">Token Usage</dt>
                    <dd><SessionTokenStats runId={runId} compact={false} /></dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
            {/* LLM Call Log */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">LLM API Calls</CardTitle>
              </CardHeader>
              <CardContent>
                <LlmCallLog runId={runId} maxHeight="350px" live={run.status === 'running' || run.status === 'pending'} />
              </CardContent>
            </Card>

            {(slackMessages.length > 0 || run.status === 'running') && (
              <SlackChatFeed messages={slackMessages} />
            )}
          </div>
        )}
        
        {/* Agent Mount Info - shows what directories the agent has access to */}
        {detailsOpen && (run.agent_id || (run.steps && run.steps.length > 0)) && (
          <div className="mt-4">
            <MountInfo 
              agentId={run.agent_id || run.steps?.[0]?.agent_id || 'unknown'} 
              runId={runId} 
            />
          </div>
        )}
      </div>

      {/* Restart Step Modal */}
      {restartModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setRestartModal(null)}>
          <div className="bg-card border rounded-lg p-4 md:p-6 w-[calc(100%-2rem)] max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Restart Step</h3>
              <button onClick={() => setRestartModal(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Restart <span className="font-mono font-medium text-foreground">{restartModal.stepId}</span> (agent: {restartModal.agentId})
            </p>
            <label className="block text-sm font-medium mb-1.5">Additional Context (optional)</label>
            <textarea
              value={restartContext}
              onChange={(e) => setRestartContext(e.target.value)}
              placeholder="Provide guidance for the agent on this retry..."
              className="w-full h-24 rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setRestartModal(null)}>Cancel</Button>
              <Button onClick={handleRestart} disabled={restarting}>
                <RotateCcw className="h-4 w-4 mr-1.5" />
                {restarting ? 'Restarting...' : 'Restart Step'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Dialog */}
      {confirmAction && (
        <ConfirmDialog
          open={!!confirmAction}
          onOpenChange={(open) => !open && setConfirmAction(null)}
          title={confirmAction.title}
          description={confirmAction.desc}
          confirmLabel={confirmAction.title}
          variant="destructive"
          onConfirm={() => {
            confirmAction.action();
            setConfirmAction(null);
          }}
        />
      )}
    </div>
  );
}
