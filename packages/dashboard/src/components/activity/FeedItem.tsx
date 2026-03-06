/**
 * FeedItem — renders a single activity event in the unified live feed.
 *
 * Compact card with icon, summary, timestamp, and optional expandable detail.
 * Uses subtle left-border color coding instead of heavy Card borders.
 */

import { useState } from 'react';
import {
  Play,
  CheckCircle2,
  XCircle,
  MessageSquare,
  Zap,
  Radio,
  Inbox,
  ArrowRight,
  Wrench,
  RotateCcw,
  Send,
  Hash,
  ListChecks,
  CheckSquare,
  GitBranch,
  ChevronDown,
  Network,
  type LucideIcon,
} from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import type { ActivityEvent } from '@/hooks/useActivityStream';

// ── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function formatCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// ── Config per event type ────────────────────────────────────────────────────

interface EventConfig {
  icon: LucideIcon;
  color: string; // tailwind text color
  borderColor: string; // tailwind border-l color
  label: string;
  muted?: boolean; // low-priority events rendered smaller
}

function getEventConfig(type: string): EventConfig {
  switch (type) {
    case 'session_started':
      return { icon: Play, color: 'text-blue-400', borderColor: 'border-l-blue-500', label: 'Session Started' };
    case 'session_completed':
      return { icon: CheckCircle2, color: 'text-emerald-400', borderColor: 'border-l-emerald-500', label: 'Session Completed' };
    case 'session_failed':
      return { icon: XCircle, color: 'text-red-400', borderColor: 'border-l-red-500', label: 'Session Failed' };
    case 'work_started':
      return { icon: Play, color: 'text-blue-400', borderColor: 'border-l-blue-500', label: 'Work Started' };
    case 'work_complete':
      return { icon: CheckCircle2, color: 'text-emerald-400', borderColor: 'border-l-emerald-500', label: 'Work Complete' };
    case 'work_failed':
      return { icon: XCircle, color: 'text-red-400', borderColor: 'border-l-red-500', label: 'Work Failed' };
    case 'slack_message':
      return { icon: MessageSquare, color: 'text-purple-400', borderColor: 'border-l-purple-500', label: 'Slack' };
    case 'slack_reply_sent':
      return { icon: Send, color: 'text-purple-400', borderColor: 'border-l-purple-500', label: 'Slack Reply' };
    case 'pulse_started':
      return { icon: Radio, color: 'text-amber-400', borderColor: 'border-l-amber-500', label: 'Pulse Started' };
    case 'pulse_complete':
      return { icon: Zap, color: 'text-green-400', borderColor: 'border-l-green-500', label: 'Pulse Complete' };
    case 'inbox_received':
      return { icon: Inbox, color: 'text-cyan-400', borderColor: 'border-l-cyan-500', label: 'Message Received' };
    case 'message_received':
      return { icon: Inbox, color: 'text-cyan-400', borderColor: 'border-l-cyan-500', label: 'Message' };
    case 'message_sent':
      return { icon: Send, color: 'text-cyan-400', borderColor: 'border-l-cyan-500', label: 'Message Sent' };
    case 'task_claimed':
      return { icon: ListChecks, color: 'text-orange-400', borderColor: 'border-l-orange-500', label: 'Task Claimed' };
    case 'task_completed':
      return { icon: CheckSquare, color: 'text-emerald-400', borderColor: 'border-l-emerald-500', label: 'Task Completed' };
    case 'executor_spawned':
      return { icon: GitBranch, color: 'text-violet-400', borderColor: 'border-l-violet-500', label: 'Executor Spawned' };
    case 'swarm_started':
      return { icon: Network, color: 'text-indigo-400', borderColor: 'border-l-indigo-500', label: 'Swarm Started' };
    case 'swarm_completed':
      return { icon: Network, color: 'text-emerald-400', borderColor: 'border-l-emerald-500', label: 'Swarm Done' };
    case 'tool_install':
      return { icon: Wrench, color: 'text-amber-400', borderColor: 'border-l-amber-500', label: 'Tool Installed' };
    case 'sandbox_reset':
      return { icon: RotateCcw, color: 'text-red-400', borderColor: 'border-l-red-500', label: 'Sandbox Reset' };
    case 'state_change':
      return { icon: ArrowRight, color: 'text-zinc-500', borderColor: 'border-l-zinc-600', label: 'State Change', muted: true };
    default:
      return { icon: Hash, color: 'text-zinc-500', borderColor: 'border-l-zinc-600', label: type, muted: true };
  }
}

// ── Summary generators ───────────────────────────────────────────────────────

function getSummary(event: ActivityEvent): string {
  const d = event.data || {};

  switch (event.type) {
    case 'session_started':
      return d.userPrompt
        ? `Started session \u2014 "${d.userPrompt}"`
        : 'Started a new session';
    case 'session_completed': {
      const parts: string[] = ['Session completed'];
      if (d.durationMs) parts.push(`in ${formatDuration(d.durationMs)}`);
      const meta: string[] = [];
      if (d.toolCallCount) meta.push(`${d.toolCallCount} tool calls`);
      if (d.tokenCount) meta.push(`${formatTokens(d.tokenCount)} tokens`);
      if (d.cost) meta.push(formatCost(d.cost));
      if (meta.length) parts.push(`\u2014 ${meta.join(', ')}`);
      return parts.join(' ');
    }
    case 'session_failed':
      return d.error
        ? `Session failed \u2014 ${d.error}`
        : 'Session failed';
    case 'work_started':
      return `Started ${d.stepType || 'work'} step`;
    case 'work_complete': {
      const dur = d.durationMs ? ` in ${formatDuration(d.durationMs)}` : '';
      return `Completed ${d.stepType || 'work'} step${dur}`;
    }
    case 'work_failed':
      return d.error
        ? `Work failed \u2014 ${d.error}`
        : 'Work step failed';
    case 'slack_message':
      return d.direction === 'sent'
        ? `Sent Slack message${d.threadTs ? ` in thread` : ''}`
        : `Received Slack message${d.threadTs ? ` in thread` : ''}`;
    case 'slack_reply_sent':
      return d.channel
        ? `Replied in #${d.channel}`
        : 'Sent Slack reply';
    case 'pulse_started':
      return 'Pulse routine started';
    case 'pulse_complete': {
      const summary = d.summary || 'Pulse completed';
      const checks = d.checksCompleted ? ` (${d.checksCompleted} checks)` : '';
      return `${summary}${checks}`;
    }
    case 'inbox_received':
      return d.fromAgent
        ? `Received message from @${d.fromAgent}`
        : 'Received inbox message';
    case 'message_received':
      return d.from
        ? `Message from ${d.from}`
        : 'Message received';
    case 'task_claimed':
      return d.taskTitle
        ? `Claimed task: ${d.taskTitle}`
        : 'Claimed a task';
    case 'task_completed':
      return d.taskTitle
        ? `Completed task: ${d.taskTitle}`
        : 'Completed a task';
    case 'executor_spawned':
      return d.promptPreview
        ? `Spawned executor \u2014 "${d.promptPreview}"`
        : 'Spawned a new executor';
    case 'swarm_started':
      return `Swarm started \u2014 ${d.totalTasks || '?'} tasks (max ${d.maxConcurrent || 3} parallel)`;
    case 'swarm_completed': {
      const parts = [`Swarm ${d.status === 'success' ? 'completed' : 'failed'}`];
      if (d.completed != null) parts.push(`\u2014 ${d.completed}/${d.totalTasks || '?'} tasks`);
      if (d.durationMs) parts.push(`in ${formatDuration(d.durationMs)}`);
      return parts.join(' ');
    }
    case 'tool_install':
      return d.toolName
        ? `Installed tool: ${d.toolName}`
        : 'Installed a tool';
    case 'sandbox_reset':
      return 'Sandbox environment reset';
    case 'state_change':
      return d.newState
        ? `State \u2192 ${d.newState}`
        : 'State changed';
    default:
      return event.type;
  }
}

function getDetail(event: ActivityEvent): string | null {
  const d = event.data || {};

  switch (event.type) {
    case 'session_completed':
    case 'session_failed':
      return d.outputPreview || d.error || null;
    case 'slack_message':
      return d.message || null;
    case 'slack_reply_sent':
      return d.messagePreview || null;
    case 'executor_spawned':
      return d.promptPreview || null;
    case 'swarm_started':
    case 'swarm_completed':
      return d.swarmId || null;
    case 'inbox_received':
      return d.subject || null;
    case 'work_failed':
      return d.error || null;
    default:
      return null;
  }
}

function getSourceBadge(event: ActivityEvent): string | null {
  const d = event.data || {};
  if (event.type === 'session_started' && d.source) {
    return d.source;
  }
  return null;
}

// ── Component ────────────────────────────────────────────────────────────────

interface FeedItemProps {
  event: ActivityEvent;
  isNew?: boolean; // animate entrance
}

export function FeedItem({ event, isNew }: FeedItemProps) {
  const [expanded, setExpanded] = useState(false);
  const config = getEventConfig(event.type);
  const Icon = config.icon;
  const summary = getSummary(event);
  const detail = getDetail(event);
  const sourceBadge = getSourceBadge(event);
  const hasDetail = !!detail;

  return (
    <div
      className={cn(
        'border-l-2 pl-3 pr-3 py-2.5 transition-all duration-300',
        config.borderColor,
        config.muted ? 'opacity-60' : '',
        isNew && 'animate-in fade-in slide-in-from-top-1 duration-300',
      )}
    >
      <div className="flex items-start gap-2.5">
        {/* Icon */}
        <div className={cn('mt-0.5 shrink-0', config.color)}>
          <Icon className="h-4 w-4" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className={cn(
              'text-sm leading-snug truncate',
              config.muted ? 'text-muted-foreground' : 'text-foreground',
            )}>
              {summary}
            </p>
            {sourceBadge && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                {sourceBadge}
              </span>
            )}
            {(event.type === 'swarm_started' || event.type === 'swarm_completed') && event.data?.swarmId && (
              <Link
                to="/runs/swarm/$swarmId"
                params={{ swarmId: event.data.swarmId }}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 text-[10px] text-indigo-400 hover:text-indigo-300 hover:underline"
              >
                View swarm
              </Link>
            )}
          </div>

          {/* Expandable detail */}
          {hasDetail && expanded && (
            <p className="mt-1.5 text-xs text-muted-foreground whitespace-pre-wrap break-words bg-muted/30 rounded px-2 py-1.5 border border-border/50">
              {detail}
            </p>
          )}
        </div>

        {/* Right side: timestamp + expand */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {relativeTime(event.timestamp)}
          </span>
          {hasDetail && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-0.5 rounded hover:bg-muted/50 transition-colors"
            >
              <ChevronDown className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200',
                expanded && 'rotate-180',
              )} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
