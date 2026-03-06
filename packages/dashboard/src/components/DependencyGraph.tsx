import { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
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
import { Badge } from '@/components/ui/badge';
import { STATUS_HEX_COLORS, PRIORITY_HEX_COLORS } from './projects/constants';

interface GraphTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigned_agent: string | null;
  estimated_hours: number | null;
}

interface TaskNodeData extends GraphTask {
  isCritical: boolean;
}

interface GraphEdge {
  id: string;
  from_task_id: string;
  to_task_id: string;
  type: string;
}

interface DependencyGraphProps {
  tasks: GraphTask[];
  edges: GraphEdge[];
  criticalPath: string[];
  onTaskClick?: (taskId: string) => void;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'LR'
): { nodes: Node[]; edges: Edge[] } {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({
    rankdir: direction,
    nodesep: 50,
    ranksep: 80,
    marginx: 20,
    marginy: 20,
  });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const isHorizontal = direction === 'LR';

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      targetPosition: isHorizontal ? Position.Left : Position.Top,
      sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
      position: {
        x: nodeWithPosition.x - NODE_WIDTH / 2,
        y: nodeWithPosition.y - NODE_HEIGHT / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

function TaskNode({ data }: { data: TaskNodeData }) {
  const statusColor = STATUS_HEX_COLORS[data.status] || STATUS_HEX_COLORS.backlog;
  const borderColor = PRIORITY_HEX_COLORS[data.priority] || PRIORITY_HEX_COLORS.P2;
  const isCritical = data.isCritical;

  return (
    <div
      className={`rounded-lg border-2 bg-card shadow-sm px-3 py-2 cursor-pointer hover:shadow-md transition-shadow ${isCritical ? 'ring-2 ring-yellow-400/50' : ''}`}
      style={{ borderColor, width: NODE_WIDTH, minHeight: NODE_HEIGHT - 16 }}
    >
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0 !w-0 !h-0" />
      <div className="flex items-center gap-1.5 mb-1">
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: statusColor }}
        />
        <span className="text-[10px] font-medium text-muted-foreground uppercase">{data.status.replace('_', ' ')}</span>
        <Badge variant="outline" className="text-[9px] px-1 py-0 ml-auto" style={{ borderColor }}>
          {data.priority}
        </Badge>
      </div>
      <p className="text-xs font-medium leading-tight line-clamp-2">{data.title}</p>
      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
        {data.assigned_agent && <span>🤖 {data.assigned_agent}</span>}
        {data.estimated_hours && <span>{data.estimated_hours}h</span>}
        {isCritical && <span className="text-yellow-500">⚡ critical</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-transparent !border-0 !w-0 !h-0" />
    </div>
  );
}

const nodeTypes = { taskNode: TaskNode };

export function DependencyGraph({ tasks, edges: graphEdges, criticalPath, onTaskClick }: DependencyGraphProps) {
  const criticalSet = useMemo(() => new Set(criticalPath), [criticalPath]);

  const initialNodes: Node[] = useMemo(() =>
    tasks.map((task) => ({
      id: task.id,
      type: 'taskNode',
      data: {
        ...task,
        isCritical: criticalSet.has(task.id),
      },
      position: { x: 0, y: 0 },
    })),
    [tasks, criticalSet]
  );

  const initialEdges: Edge[] = useMemo(() =>
    graphEdges.map((edge) => {
      const isOnCriticalPath = criticalSet.has(edge.from_task_id) && criticalSet.has(edge.to_task_id);
      return {
        id: edge.id,
        source: edge.from_task_id,
        target: edge.to_task_id,
        type: 'smoothstep',
        animated: edge.type === 'informs',
        style: {
          stroke: isOnCriticalPath ? '#eab308' : edge.type === 'blocks' ? '#6b7280' : '#9ca3af',
          strokeWidth: isOnCriticalPath ? 2.5 : 1.5,
          strokeDasharray: edge.type === 'informs' ? '5 5' : undefined,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isOnCriticalPath ? '#eab308' : '#6b7280',
        },
        label: edge.type === 'informs' ? 'informs' : undefined,
        labelStyle: { fontSize: 10, fill: '#9ca3af' },
      };
    }),
    [graphEdges, criticalSet]
  );

  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => getLayoutedElements(initialNodes, initialEdges, 'LR'),
    [initialNodes, initialEdges]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  useEffect(() => {
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [layoutedNodes, layoutedEdges, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      onTaskClick?.(node.id);
    },
    [onTaskClick]
  );

  return (
    <div className="w-full h-[calc(100vh-240px)] min-h-[500px] rounded-lg border bg-background">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls className="!bg-card !border-border !shadow-md [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-accent" />
        <MiniMap
          nodeColor={(node) => STATUS_HEX_COLORS[node.data?.status] || '#6b7280'}
          style={{ background: 'hsl(var(--card))' }}
        />
      </ReactFlow>
    </div>
  );
}
