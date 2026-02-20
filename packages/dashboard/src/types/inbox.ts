export type MessageType = 'info' | 'review_request' | 'help_request' | 'urgent' | 'work_assignment';
export type MessagePriority = 'normal' | 'high' | 'urgent';
export type InboxFilter = 'all' | 'unread' | 'urgent' | 'review_request' | 'help_request';

export interface AgentMessage {
  id: string;
  from: string;
  fromAgentId: string | null;
  type: MessageType;
  priority: MessagePriority;
  subject: string | null;
  body: string;
  runContext: string | null;
  stepContext: string | null;
  timestamp: number;
  read: boolean;
  readAt: number | null;
}

export interface InboxResponse {
  messages: AgentMessage[];
  unreadCount: number;
  totalCount: number;
  hasMore: boolean;
}

export interface SendMessageRequest {
  from: string;
  fromAgentId?: string;
  type: MessageType;
  priority: MessagePriority;
  subject?: string;
  body: string;
  runContext?: string;
  stepContext?: string;
}

export interface SendMessageResponse {
  message: AgentMessage;
}

export interface MarkReadResponse {
  updated: number;
  unreadCount: number;
}

export interface ClearInboxResponse {
  deleted: number;
}
