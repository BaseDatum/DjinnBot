import { TimelineEventData } from '@/types/lifecycle';
import {
  ArrowRight,
  Mail,
  Zap,
  Wrench,
  RotateCcw,
  Plus,
  Minus,
} from 'lucide-react';
import { format } from 'date-fns';

interface TimelineEventProps {
  event: TimelineEventData;
  isLast: boolean;
}

const EVENT_CONFIG: Record<string, {
  icon: typeof ArrowRight;
  color: string;
  bgColor: string;
}> = {
  state_change: {
    icon: ArrowRight,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
  },
  message: {
    icon: Mail,
    color: 'text-purple-500',
    bgColor: 'bg-purple-100 dark:bg-purple-900/30',
  },
  pulse: {
    icon: Zap,
    color: 'text-green-500',
    bgColor: 'bg-green-100 dark:bg-green-900/30',
  },
  tool_install: {
    icon: Wrench,
    color: 'text-orange-500',
    bgColor: 'bg-orange-100 dark:bg-orange-900/30',
  },
  sandbox_reset: {
    icon: RotateCcw,
    color: 'text-red-500',
    bgColor: 'bg-red-100 dark:bg-red-900/30',
  },
  work_queued: {
    icon: Plus,
    color: 'text-cyan-500',
    bgColor: 'bg-cyan-100 dark:bg-cyan-900/30',
  },
  work_dequeued: {
    icon: Minus,
    color: 'text-gray-500',
    bgColor: 'bg-gray-100 dark:bg-gray-900/30',
  },
};

export function TimelineEvent({ event, isLast }: TimelineEventProps) {
  const config = EVENT_CONFIG[event.type] || {
    icon: ArrowRight,
    color: 'text-muted-foreground',
    bgColor: 'bg-muted',
  };
  const Icon = config.icon;

  const renderEventDescription = () => {
    const data = event.data || {};

    switch (event.type) {
      case 'state_change':
        return (
          <div>
            <span className="font-medium">{data.fromState}</span>
            {' → '}
            <span className="font-medium">{data.toState}</span>
            {data.step && data.runId && (
              <span className="text-muted-foreground text-sm ml-2">
                ({data.step}, {data.runId})
              </span>
            )}
          </div>
        );

      case 'message':
        return (
          <div>
            Message from <span className="font-medium">{data.from}</span>
            {data.messageType && (
              <span className="text-muted-foreground text-sm ml-2">
                ({data.messageType})
              </span>
            )}
          </div>
        );

      case 'pulse':
        return (
          <div>
            Pulse: {data.summary || 'completed'}
            {data.checksCompleted !== undefined && (
              <span className="text-muted-foreground text-sm ml-2">
                ({data.checksCompleted} checks)
              </span>
            )}
          </div>
        );

      case 'tool_install':
        return (
          <div>
            Installed tool: <span className="font-medium">{data.toolName}</span>
          </div>
        );

      case 'sandbox_reset':
        return <div>Sandbox environment reset</div>;

      case 'work_queued':
        return (
          <div>
            Work queued
            {data.queueDepth !== undefined && (
              <span className="text-muted-foreground text-sm ml-2">
                (queue: {data.queueDepth})
              </span>
            )}
          </div>
        );

      case 'work_dequeued':
        return (
          <div>
            Work dequeued
            {data.queueDepth !== undefined && (
              <span className="text-muted-foreground text-sm ml-2">
                (queue: {data.queueDepth})
              </span>
            )}
          </div>
        );

      default:
        return <div>Unknown event type</div>;
    }
  };

  return (
    <div className="flex gap-3">
      {/* Timeline line */}
      <div className="flex flex-col items-center">
        <div className={`rounded-full p-1.5 ${config.bgColor}`}>
          <Icon className={`h-4 w-4 ${config.color}`} />
        </div>
        {!isLast && (
          <div className="w-0.5 flex-1 bg-border mt-2 mb-1 min-h-[20px]" />
        )}
      </div>

      {/* Event content */}
      <div className="flex-1 pb-4">
        <div className="text-xs text-muted-foreground mb-1">
          {format(event.timestamp, 'HH:mm:ss')}
        </div>
        <div className="text-sm">{renderEventDescription()}</div>
      </div>
    </div>
  );
}
