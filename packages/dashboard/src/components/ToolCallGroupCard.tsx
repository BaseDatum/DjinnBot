/**
 * ToolCallGroupCard — Collapsible group of consecutive tool calls.
 *
 * Shows a compact summary header with status counts. Clicking expands to
 * show each individual tool call. Auto-expands when any tool call is
 * currently running, auto-collapses once all are complete.
 */

import { useState, useEffect, useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Wrench,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react';
import { ToolCallCard } from './ToolCallCard';
import type { ChatMessageData } from '@/components/chat/ChatMessage';

interface ToolCallGroupCardProps {
  /** The consecutive tool_call messages in this group. */
  calls: ChatMessageData[];
  /** Whether any call in the group is currently streaming (running). */
  hasRunning: boolean;
}

type ToolStatus = 'running' | 'complete' | 'error';

function getCallStatus(call: ChatMessageData): ToolStatus {
  if (call.result) {
    return call.isError ? 'error' : 'complete';
  }
  return 'running';
}

export function ToolCallGroupCard({ calls, hasRunning }: ToolCallGroupCardProps) {
  const [expanded, setExpanded] = useState(false);
  // Track the user's explicit intent: 'expanded' | 'collapsed' | null (no opinion).
  // Auto-expand/collapse only fire when this is null — once the user clicks
  // the toggle, their choice is respected until the group is done.
  const userIntentRef = useRef<'expanded' | 'collapsed' | null>(null);
  // Auto-expand when a call starts running, auto-collapse when all finish
  const prevHasRunning = useRef(hasRunning);
  // Debounce timer for auto-collapse — prevents flicker when tool calls
  // arrive in quick succession (the brief gap between tool_end and the
  // next tool_start would trigger a collapse/expand flash).
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleToggle = () => {
    setExpanded(prev => {
      const next = !prev;
      userIntentRef.current = next ? 'expanded' : 'collapsed';
      return next;
    });
  };

  useEffect(() => {
    if (hasRunning && !prevHasRunning.current) {
      // A new tool started — cancel any pending auto-collapse
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      // Only auto-expand if the user hasn't explicitly collapsed
      if (userIntentRef.current !== 'collapsed') {
        setExpanded(true);
      }
    } else if (!hasRunning && prevHasRunning.current && calls.length > 1) {
      // All tools finished — debounce the auto-collapse so that
      // if another tool_start arrives shortly, we don't flicker.
      // Only auto-collapse if the user hasn't explicitly expanded.
      if (userIntentRef.current !== 'expanded') {
        collapseTimerRef.current = setTimeout(() => {
          collapseTimerRef.current = null;
          setExpanded(false);
          // Reset user intent once the group settles so that future
          // tool runs in this group can auto-expand again.
          userIntentRef.current = null;
        }, 800);
      }
    }
    prevHasRunning.current = hasRunning;
  }, [hasRunning, calls.length]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    };
  }, []);

  // Count statuses
  const counts = { running: 0, complete: 0, error: 0 };
  for (const call of calls) {
    counts[getCallStatus(call)]++;
  }

  const totalDuration = calls.reduce((sum, c) => sum + (c.durationMs || 0), 0);

  // Single tool call — just render the card directly, no group chrome
  if (calls.length === 1) {
    const call = calls[0];
    const status = getCallStatus(call);
    return (
      <div className="group flex gap-3">
        <div className="w-8" />
        <div className="flex-1 max-w-[85%] overflow-hidden">
          <ToolCallCard
            toolName={call.toolName || 'unknown'}
            args={call.args ? JSON.stringify(call.args, null, 2) : undefined}
            result={call.result}
            isError={call.isError}
            durationMs={call.durationMs}
            status={status}
          />
        </div>
      </div>
    );
  }

  // Overall status for the group border/bg color
  const groupStatus: ToolStatus =
    counts.running > 0 ? 'running' :
    counts.error > 0 ? 'error' : 'complete';

  const borderColor =
    groupStatus === 'running' ? 'border-amber-500/40' :
    groupStatus === 'error' ? 'border-red-500/40' :
    'border-emerald-500/30';

  const bgColor =
    groupStatus === 'running' ? 'bg-amber-500/5' :
    groupStatus === 'error' ? 'bg-red-500/5' :
    'bg-emerald-500/5';

  return (
    <div className="group flex gap-3">
      <div className="w-8" />
      <div className="flex-1 max-w-[85%] overflow-hidden">
        <div className={`my-2 rounded-md border ${borderColor} ${bgColor}`}>
          {/* Summary header */}
          <button
            onClick={handleToggle}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-white/[0.02] transition-colors"
          >
            {expanded
              ? <ChevronDown className="h-3 w-3 text-zinc-400 shrink-0" />
              : <ChevronRight className="h-3 w-3 text-zinc-400 shrink-0" />}
            <Wrench className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
            <span className="font-medium text-zinc-300">
              {calls.length} tool call{calls.length !== 1 ? 's' : ''}
            </span>

            {/* Status badges */}
            <div className="flex items-center gap-2 ml-auto">
              {counts.complete > 0 && (
                <span className="flex items-center gap-1 text-emerald-400">
                  <CheckCircle className="h-3 w-3" />
                  <span>{counts.complete}</span>
                </span>
              )}
              {counts.error > 0 && (
                <span className="flex items-center gap-1 text-red-400">
                  <XCircle className="h-3 w-3" />
                  <span>{counts.error}</span>
                </span>
              )}
              {counts.running > 0 && (
                <span className="flex items-center gap-1 text-amber-400">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{counts.running}</span>
                </span>
              )}
              {totalDuration > 0 && counts.running === 0 && (
                <span className="text-zinc-500">
                  {(totalDuration / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          </button>

          {/* Expanded: individual tool calls */}
          {expanded && (
            <div className="border-t border-zinc-800/50">
              {calls.map((call, idx) => {
                const status = getCallStatus(call);
                return (
                  <div
                    key={call.id}
                    className={idx > 0 ? 'border-t border-zinc-800/30' : ''}
                  >
                    <ToolCallCard
                      toolName={call.toolName || 'unknown'}
                      args={call.args ? JSON.stringify(call.args, null, 2) : undefined}
                      result={call.result}
                      isError={call.isError}
                      durationMs={call.durationMs}
                      status={status}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
