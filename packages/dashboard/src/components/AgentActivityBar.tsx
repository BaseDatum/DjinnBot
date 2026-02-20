import { Brain, Pencil, Wrench, Clock, CheckCircle, XCircle, type LucideIcon } from 'lucide-react';

interface AgentActivityBarProps {
  runStatus: string;
  agentState: { state: string; toolName?: string } | null;
  sseStatus: string;
}

const STATE_CONFIG: Record<string, { icon: LucideIcon; label: string; color: string; bg: string; border: string; animate: string }> = {
  thinking: {
    icon: Brain,
    label: 'Thinking...',
    color: 'text-purple-400',
    bg: 'bg-purple-500/10',
    border: 'border-purple-500/30',
    animate: 'animate-pulse',
  },
  streaming: {
    icon: Pencil,
    label: 'Generating...',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
    animate: 'animate-pulse',
  },
  tool_calling: {
    icon: Wrench,
    label: 'Running tool',
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    animate: 'animate-spin',
  },
  idle: {
    icon: Clock,
    label: 'Waiting...',
    color: 'text-zinc-400',
    bg: 'bg-zinc-500/5',
    border: 'border-zinc-500/20',
    animate: '',
  },
};

export function AgentActivityBar({ runStatus, agentState, sseStatus }: AgentActivityBarProps) {
  if (runStatus === 'completed') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-xs">
        <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-emerald-400 font-medium">Completed</span>
      </div>
    );
  }
  if (runStatus === 'failed') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-xs">
        <XCircle className="h-3.5 w-3.5 text-red-400" />
        <span className="text-red-400 font-medium">Failed</span>
      </div>
    );
  }
  
  if (!agentState || runStatus !== 'running') return null;
  
  const config = STATE_CONFIG[agentState.state] ?? STATE_CONFIG.idle;
  const Icon = config.icon;
  const label = agentState.state === 'tool_calling' && agentState.toolName
    ? `Running: ${agentState.toolName}`
    : config.label;
  
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md ${config.bg} border ${config.border} text-xs`}>
      <Icon className={`h-3.5 w-3.5 ${config.color} ${config.animate}`} />
      <span className={`${config.color} font-medium`}>{label}</span>
      {sseStatus !== 'connected' && (
        <span className="text-zinc-500 ml-2">(SSE: {sseStatus})</span>
      )}
    </div>
  );
}
