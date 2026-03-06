import { useSSE } from './useSSE';
import { API_BASE } from '@/lib/api';

// Define lifecycle event types
export type LifecycleEventType =
  | 'AGENT_STATE_CHANGED'
  | 'AGENT_WORK_QUEUED'
  | 'AGENT_WORK_DEQUEUED'
  | 'AGENT_MESSAGE_RECEIVED'
  | 'AGENT_PULSE_COMPLETED'
  | 'AGENT_TOOL_INSTALLED'
  | 'AGENT_SANDBOX_RESET';

export interface LifecycleEvent {
  type: LifecycleEventType;
  agentId: string;
  timestamp: number;
  [key: string]: any;
}

interface UseAgentLifecycleOptions {
  agentId?: string;
  onEvent?: (event: LifecycleEvent) => void;
  enabled?: boolean;
}

export function useAgentLifecycle({
  agentId,
  onEvent,
  enabled = true,
}: UseAgentLifecycleOptions = {}) {
  const { status, lastMessage, lastEventTime } = useSSE<LifecycleEvent>({
    url: `${API_BASE}/events/events`,
    enabled,
    onMessage: (event) => {
      // Validate it's a lifecycle event
      if (!event?.type?.startsWith('AGENT_')) return;

      // Filter by agentId if specified
      if (agentId && event.agentId !== agentId) return;

      onEvent?.(event);
    },
  });

  return {
    status,
    lastEvent: lastMessage,
    lastEventTime,
  };
}