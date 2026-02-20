import { AggregatedTimelineItem, TimelineEvent } from '@/types/lifecycle';
import { format } from 'date-fns';
import { Wrench, MessageSquare, CheckCircle2, XCircle, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ExpandedTimelineItemProps {
  item: AggregatedTimelineItem;
}

export function ExpandedTimelineItem({ item }: ExpandedTimelineItemProps) {
  return (
    <div className="p-4 space-y-2">
      {item.events.map(event => (
        <EventDetail key={event.id} event={event} />
      ))}
    </div>
  );
}

interface EventDetailProps {
  event: TimelineEvent;
}

function EventDetail({ event }: EventDetailProps) {
  const timestamp = format(event.timestamp, 'HH:mm:ss.SSS');

  switch (event.type) {
    case 'work_started':
      return (
        <div className="flex items-start gap-2 text-sm">
          <div className="text-blue-500 mt-0.5">▶</div>
          <div>
            <div className="font-medium">Started {event.data.stepType} step</div>
            {event.data.input && (
              <div className="text-muted-foreground text-xs mt-1 font-mono">
                {truncate(event.data.input, 200)}
              </div>
            )}
            <div className="text-xs text-muted-foreground mt-1">{timestamp}</div>
          </div>
        </div>
      );

    case 'work_output':
      return (
        <div className="flex items-start gap-2 text-sm">
          <div className="text-gray-400 mt-0.5">📝</div>
          <div className="flex-1">
            <div className="prose prose-sm max-w-none dark:prose-invert">
              {event.data.chunk}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {timestamp} • {event.data.totalLength} chars
            </div>
          </div>
        </div>
      );

    case 'work_thinking':
      return (
        <details className="bg-purple-50 dark:bg-purple-900/20 rounded-md p-3">
          <summary className="cursor-pointer text-sm font-medium text-purple-700 dark:text-purple-400 flex items-center gap-2">
            <Brain className="h-4 w-4" />
            Thinking...
          </summary>
          <div className="mt-2 text-sm text-purple-900 dark:text-purple-200 whitespace-pre-wrap">
            {event.data.thinking}
          </div>
          <div className="text-xs text-purple-600 dark:text-purple-400 mt-2">{timestamp}</div>
        </details>
      );

    case 'work_tool_call':
      return (
        <div className="bg-amber-50 dark:bg-amber-900/20 rounded-md p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400 mb-2">
            <Wrench className="h-4 w-4" />
            Tool: {event.data.tool}
            <span className="text-xs text-muted-foreground ml-auto">
              {event.data.durationMs}ms
            </span>
          </div>
          
          <div className="text-xs space-y-2">
            <div>
              <div className="text-amber-600 dark:text-amber-400 font-medium mb-1">Arguments:</div>
              <pre className="bg-white dark:bg-gray-950 p-2 rounded text-xs overflow-x-auto">
                {JSON.stringify(event.data.args, null, 2)}
              </pre>
            </div>

            {event.data.result && (
              <div>
                <div className="text-green-600 dark:text-green-400 font-medium mb-1">Result:</div>
                <pre className="bg-white dark:bg-gray-950 p-2 rounded text-xs overflow-x-auto">
                  {typeof event.data.result === 'string' 
                    ? event.data.result 
                    : JSON.stringify(event.data.result, null, 2)}
                </pre>
              </div>
            )}

            {event.data.error && (
              <div>
                <div className="text-red-600 dark:text-red-400 font-medium mb-1">Error:</div>
                <pre className="bg-red-50 dark:bg-red-950 p-2 rounded text-xs overflow-x-auto text-red-700 dark:text-red-300">
                  {event.data.error}
                </pre>
              </div>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-2">{timestamp}</div>
        </div>
      );

    case 'work_complete':
      return (
        <div className="flex items-start gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium text-green-700 dark:text-green-400">
              Step completed
            </div>
            {event.data.outputs && Object.keys(event.data.outputs).length > 0 && (
              <div className="mt-1 text-xs">
                <div className="text-muted-foreground mb-1">Outputs:</div>
                <pre className="bg-muted p-2 rounded text-xs overflow-x-auto">
                  {JSON.stringify(event.data.outputs, null, 2)}
                </pre>
              </div>
            )}
            <div className="text-xs text-muted-foreground mt-1">
              {timestamp} • {event.data.durationMs}ms
              {event.data.tokensUsed && ` • ${event.data.tokensUsed} tokens`}
              {event.data.cost && ` • $${event.data.cost.toFixed(4)}`}
            </div>
          </div>
        </div>
      );

    case 'work_failed':
      return (
        <div className="flex items-start gap-2 text-sm">
          <XCircle className="h-4 w-4 text-red-500 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium text-red-700 dark:text-red-400">
              Step failed
            </div>
            <div className="text-red-600 dark:text-red-300 text-xs mt-1 bg-red-50 dark:bg-red-950 p-2 rounded">
              {event.data.error}
            </div>
            <div className="text-xs text-muted-foreground mt-1">{timestamp}</div>
          </div>
        </div>
      );

    case 'slack_message_sent':
    case 'slack_message_received':
      const isSent = event.type === 'slack_message_sent';
      return (
        <div className={cn(
          "flex items-start gap-2 text-sm p-2 rounded",
          isSent ? "bg-blue-50 dark:bg-blue-900/20" : "bg-gray-50 dark:bg-gray-900/20"
        )}>
          <MessageSquare className={cn(
            "h-4 w-4 mt-0.5",
            isSent ? "text-blue-500" : "text-gray-500"
          )} />
          <div className="flex-1">
            {!isSent && event.data.userName && (
              <div className="font-medium text-xs text-muted-foreground mb-1">
                {event.data.userName}
              </div>
            )}
            <div className="whitespace-pre-wrap">{event.data.message}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {timestamp} • #{event.data.channel}
            </div>
          </div>
        </div>
      );

    case 'pulse_check_complete':
      const isPassed = event.data.status === 'pass';
      const isSkipped = event.data.status === 'skip';
      return (
        <div className="flex items-start gap-2 text-sm">
          {isPassed && <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5" />}
          {!isPassed && !isSkipped && <XCircle className="h-4 w-4 text-red-500 mt-0.5" />}
          {isSkipped && <div className="h-4 w-4 text-gray-400 mt-0.5">○</div>}
          <div className="flex-1">
            <div className={cn(
              "font-medium",
              isPassed && "text-green-700 dark:text-green-400",
              !isPassed && !isSkipped && "text-red-700 dark:text-red-400",
              isSkipped && "text-gray-500"
            )}>
              {event.data.checkName} - {event.data.status}
            </div>
            {event.data.details && (
              <div className="text-xs text-muted-foreground mt-1">{event.data.details}</div>
            )}
            <div className="text-xs text-muted-foreground mt-1">{timestamp}</div>
          </div>
        </div>
      );

    case 'pulse_complete':
      return (
        <div className="bg-green-50 dark:bg-green-900/20 rounded-md p-3">
          <div className="font-medium text-green-700 dark:text-green-400 mb-2">
            Pulse Complete: {event.data.summary}
          </div>
          <div className="text-sm text-muted-foreground">
            Completed {event.data.checksCompleted} checks
            {event.data.checksFailed > 0 && ` (${event.data.checksFailed} failed)`}
            {' • '}
            {event.data.durationMs}ms
          </div>
          {event.data.taskStarted && (
            <div className="mt-2 text-sm">
              <div className="text-blue-600 dark:text-blue-400 font-medium">
                Started task: {event.data.taskStarted.taskTitle}
              </div>
              <div className="text-xs text-muted-foreground">
                {event.data.taskStarted.projectId}/{event.data.taskStarted.taskId}
              </div>
            </div>
          )}
          <div className="text-xs text-muted-foreground mt-2">{timestamp}</div>
        </div>
      );

    default:
      // Fallback for unknown event types
      return (
        <div className="text-sm text-muted-foreground">
          <div className="font-medium">{event.type}</div>
          <pre className="text-xs mt-1 bg-muted p-2 rounded overflow-x-auto">
            {JSON.stringify(event.data, null, 2)}
          </pre>
          <div className="text-xs mt-1">{timestamp}</div>
        </div>
      );
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '...';
}
