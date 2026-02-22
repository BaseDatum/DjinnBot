export interface Session {
  id: string;
  agent_id: string;
  source: string;
  source_id?: string;
  status: 'starting' | 'running' | 'completed' | 'failed';
  user_prompt?: string;
  output?: string;
  error?: string;
  model?: string;
  turn_count: number;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  key_resolution?: {
    source?: string;
    userId?: string | null;
    resolvedProviders?: string[];
    providerSources?: Record<string, { source: string; masked_key: string }>;
  } | null;
}

export interface SessionEvent {
  id: string;
  event_type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface SessionList {
  sessions: Session[];
  total: number;
  hasMore: boolean;
}

export interface SessionDetail extends Session {
  events: SessionEvent[];
}
