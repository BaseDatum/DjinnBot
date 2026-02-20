import { AgentMessage } from '@/types/inbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { 
  AlertCircle, 
  Info, 
  FileQuestion, 
  HelpCircle, 
  Briefcase,
  MailOpen 
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface InboxMessageProps {
  message: AgentMessage;
  onMarkRead: () => void;
}

const MESSAGE_TYPE_CONFIG: Record<string, { icon: typeof Info; label: string; color: string }> = {
  info: { icon: Info, label: 'Info', color: 'text-blue-500' },
  review_request: { icon: FileQuestion, label: 'Review Request', color: 'text-purple-500' },
  help_request: { icon: HelpCircle, label: 'Help Request', color: 'text-orange-500' },
  urgent: { icon: AlertCircle, label: 'Urgent', color: 'text-red-500' },
  work_assignment: { icon: Briefcase, label: 'Work Assignment', color: 'text-green-500' },
};

export function InboxMessage({ message, onMarkRead }: InboxMessageProps) {
  const typeConfig = MESSAGE_TYPE_CONFIG[message.type] || MESSAGE_TYPE_CONFIG.info;
  const Icon = typeConfig.icon;

  return (
    <Card className={`p-4 ${!message.read ? 'bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800' : ''}`}>
      <div className="flex items-start gap-3">
        {/* Type icon */}
        <div className={`mt-1 ${typeConfig.color}`}>
          <Icon className="h-5 w-5" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={message.priority === 'urgent' ? 'destructive' : 'secondary'}>
                {message.priority === 'urgent' ? '🚨 URGENT' : typeConfig.label}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {formatDistanceToNow(message.timestamp, { addSuffix: true })}
              </span>
            </div>
            {!message.read && (
              <Button size="sm" variant="ghost" onClick={onMarkRead}>
                <MailOpen className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="mb-2">
            <span className="text-sm font-medium">From: {message.from}</span>
            {message.fromAgentId && (
              <span className="text-xs text-muted-foreground ml-2">({message.fromAgentId})</span>
            )}
          </div>

          {message.subject && (
            <div className="font-medium mb-1">{message.subject}</div>
          )}

          <div className="text-sm whitespace-pre-wrap break-words">{message.body}</div>

          {(message.runContext || message.stepContext) && (
            <div className="mt-2 text-xs text-muted-foreground">
              {message.runContext && <span>Run: {message.runContext}</span>}
              {message.stepContext && (
                <span className="ml-2">→ {message.stepContext}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
