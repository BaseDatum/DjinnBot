import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  MarkerType,
  Position,
  Handle,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { Loader2, Check, X, SkipForward, Ban, Circle, Crosshair } from 'lucide-react';
import type { SwarmTask } from '@/hooks/useSwarmSSE';

// ── Constants ──────────────────────────────────────────────────────────────

const NODE_WIDTH = 240;
const NODE_HEIGHT = 88;

const STATUS_COLORS: Record<string, string> = {
  pending:   '#3f3f46', // zinc-700
  ready:     '#1e3a5f', // blue-900ish
  running:   '#1d4ed8', // blue-700
  completed: '#15803d', // green-700
  failed:    '#b91c1c', // red-700
  skipped:   '#52525b', // zinc-600
  cancelled: '#52525b',
};

const STATUS_BORDER: Record<string, string> = {
  pending:   '#71717a',
  ready:     '#3b82f6',
  running:   '#60a5fa',
  completed: '#22c55e',
  failed:    '#ef4444',
  skipped:   '#71717a',
  cancelled: '#71717a',
};

// ── Layout ─────────────────────────────────────────────────────────────────

function layoutDAG(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 100, marginx: 20, marginy: 20 });

  nodes.forEach(n => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach(e => g.setEdge(e.source, e.target));
  dagre.layout(g);

  const laid = nodes.map(n => {
    const pos = g.node(n.id);
    return {
      ...n,
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });

  return { nodes: laid, edges };
}

// ── Task Node ──────────────────────────────────────────────────────────────

interface TaskNodeData {
  task: SwarmTask;
  elapsed?: number;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':   return <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />;
    case 'completed': return <Check className="w-3.5 h-3.5 text-green-400" />;
    case 'failed':    return <X className="w-3.5 h-3.5 text-red-400" />;
    case 'skipped':   return <SkipForward className="w-3.5 h-3.5 text-zinc-400" />;
    case 'cancelled': return <Ban className="w-3.5 h-3.5 text-zinc-400" />;
    case 'ready':     return <Crosshair className="w-3.5 h-3.5 text-blue-400" />;
    default:          return <Circle className="w-3.5 h-3.5 text-zinc-500" />;
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function SwarmTaskNode({ data }: { data: TaskNodeData }) {
  const { task, elapsed } = data;
  const bg = STATUS_COLORS[task.status] || STATUS_COLORS.pending;
  const border = STATUS_BORDER[task.status] || STATUS_BORDER.pending;
  const isRunning = task.status === 'running';

  const durationMs = task.started_at && task.completed_at
    ? task.completed_at - task.started_at
    : elapsed ?? 0;

  return (
    <div
      className={`rounded-lg border-2 shadow-sm px-3 py-2 cursor-pointer hover:shadow-md transition-all ${isRunning ? 'ring-1 ring-blue-400/40 animate-pulse' : ''}`}
      style={{ backgroundColor: bg, borderColor: border, width: NODE_WIDTH, minHeight: NODE_HEIGHT - 16 }}
    >
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0 !w-0 !h-0" />
      <div className="flex items-center gap-1.5 mb-1">
        <StatusIcon status={task.status} />
        <span className="text-[10px] font-medium text-zinc-300 uppercase tracking-wide">{task.status}</span>
        {durationMs > 0 && (
          <span className="text-[10px] text-zinc-400 ml-auto font-mono">{formatDuration(durationMs)}</span>
        )}
      </div>
      <p className="text-xs font-medium text-zinc-100 leading-tight line-clamp-2">{task.title}</p>
      {task.error && (
        <p className="text-[10px] text-red-300 mt-1 line-clamp-1">{task.error}</p>
      )}
      {task.outputs?.summary && (
        <p className="text-[10px] text-green-300 mt-1 line-clamp-1">{task.outputs.summary}</p>
      )}
      <Handle type="source" position={Position.Right} className="!bg-transparent !border-0 !w-0 !h-0" />
    </div>
  );
}

const nodeTypes = { swarmTask: SwarmTaskNode };

// ── Main Component ─────────────────────────────────────────────────────────

interface SwarmDAGProps {
  tasks: SwarmTask[];
  onTaskClick?: (taskKey: string) => void;
}

export function SwarmDAG({ tasks, onTaskClick }: SwarmDAGProps) {
  const now = Date.now();

  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const nodes: Node[] = tasks.map(t => ({
      id: t.key,
      type: 'swarmTask',
      data: {
        task: t,
        elapsed: t.status === 'running' && t.started_at ? now - t.started_at : undefined,
      } satisfies TaskNodeData,
      position: { x: 0, y: 0 },
    }));

    const edges: Edge[] = [];
    for (const t of tasks) {
      for (const dep of t.dependencies) {
        const depTask = tasks.find(d => d.key === dep);
        const isComplete = depTask?.status === 'completed';
        const isFailed = depTask?.status === 'failed' || depTask?.status === 'skipped';

        edges.push({
          id: `${dep}->${t.key}`,
          source: dep,
          target: t.key,
          type: 'smoothstep',
          animated: t.status === 'running' || t.status === 'ready',
          style: {
            stroke: isComplete ? '#22c55e' : isFailed ? '#ef4444' : '#71717a',
            strokeWidth: isComplete ? 2 : 1.5,
            strokeDasharray: isFailed ? '4 4' : undefined,
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        });
      }
    }

    return layoutDAG(nodes, edges);
  }, [tasks, now]);

  const [, , onNodesChange] = useNodesState(initialNodes);
  const [, , onEdgesChange] = useEdgesState(initialEdges);

  const handleNodeClick = useCallback((_: any, node: Node) => {
    onTaskClick?.(node.id);
  }, [onTaskClick]);

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={initialNodes}
        edges={initialEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#27272a" gap={20} size={1} />
        <Controls className="!bg-zinc-800 !border-zinc-700 !shadow-lg" />
      </ReactFlow>
    </div>
  );
}
