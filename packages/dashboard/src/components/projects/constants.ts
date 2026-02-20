import { Clock, Settings, Play, AlertCircle, CheckCircle2, Lock } from 'lucide-react';

export const PRIORITY_COLORS: Record<string, string> = {
  P0: 'bg-red-500/10 text-red-500 border-red-500/30',
  P1: 'bg-orange-500/10 text-orange-500 border-orange-500/30',
  P2: 'bg-blue-500/10 text-blue-500 border-blue-500/30',
  P3: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30',
};

// Hex colors for components that need raw color values (ReactFlow, Canvas, etc.)
export const STATUS_HEX_COLORS: Record<string, string> = {
  backlog: '#6b7280',
  planning: '#8b5cf6',
  ready: '#3b82f6',
  in_progress: '#f59e0b',
  review: '#f97316',
  blocked: '#ef4444',
  done: '#22c55e',
  failed: '#dc2626',
};

// Tailwind classes for components using className
export const STATUS_BG_CLASSES: Record<string, string> = {
  backlog: 'bg-slate-400',
  planning: 'bg-purple-400',
  ready: 'bg-blue-400',
  in_progress: 'bg-yellow-400',
  review: 'bg-orange-400',
  blocked: 'bg-red-400',
  done: 'bg-green-500',
  failed: 'bg-red-600',
};

export const PRIORITY_BORDER_CLASSES: Record<string, string> = {
  P0: 'border-l-red-500',
  P1: 'border-l-orange-500',
  P2: 'border-l-blue-500',
  P3: 'border-l-slate-400',
};

export const PRIORITY_HEX_COLORS: Record<string, string> = {
  P0: '#ef4444',
  P1: '#f97316',
  P2: '#3b82f6',
  P3: '#6b7280',
};

export const STATUS_ICONS: Record<string, typeof Clock> = {
  backlog: Clock,
  planning: Settings,
  ready: Play,
  in_progress: Clock,
  review: AlertCircle,
  done: CheckCircle2,
  failed: AlertCircle,
  blocked: Lock,
};
