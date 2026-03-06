import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { sendAgentMessage } from '@/lib/api';
import { MessageType, MessagePriority } from '@/types/inbox';
import { ChevronDown, Send, X, Loader2 } from 'lucide-react';

interface ComposeMessageProps {
  agentId: string;
  onMessageSent?: () => void;
  onCancel?: () => void;
}

export function ComposeMessage({ agentId, onMessageSent, onCancel }: ComposeMessageProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState<MessagePriority>('normal');
  const [type, setType] = useState<MessageType>('info');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    if (!message.trim()) {
      setError('Message cannot be empty');
      return;
    }

    setSending(true);
    try {
      await sendAgentMessage(agentId, {
        from: 'dashboard',
        body: message.trim(),
        priority,
        type,
      });

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
      setMessage('');
      setPriority('normal');
      setType('info');
      setIsOpen(false);
      onMessageSent?.();
    } catch (err) {
      console.error('Failed to send message:', err);
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleCancel = () => {
    setMessage('');
    setPriority('normal');
    setType('info');
    setError(null);
    setIsOpen(false);
    onCancel?.();
  };

  return (
    <div className="border rounded-lg overflow-hidden bg-muted/30">
      {/* Collapsible trigger */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 bg-muted/20 hover:bg-muted/30 transition-colors text-left"
      >
        <span className="flex items-center gap-2 font-medium">
          <Send className="h-4 w-4" />
          Compose Message
        </span>
        <ChevronDown
          className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      
      {/* Collapsible content */}
      {isOpen && (
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Success message */}
          {success && (
            <div className="p-3 rounded-md bg-green-500/10 text-green-600 text-sm">
              Message sent to agent
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="p-3 rounded-md bg-red-500/10 text-red-600 text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-4 flex-col sm:flex-row">
            {/* Priority Selector */}
            <div className="flex-1">
              <label htmlFor="priority" className="text-sm font-medium block mb-2">
                Priority
              </label>
              <select
                id="priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as MessagePriority)}
                className="w-full h-10 px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                disabled={sending}
              >
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">🚨 Urgent</option>
              </select>
            </div>

            {/* Type Selector */}
            <div className="flex-1">
              <label htmlFor="type" className="text-sm font-medium block mb-2">
                Type
              </label>
              <select
                id="type"
                value={type}
                onChange={(e) => setType(e.target.value as MessageType)}
                className="w-full h-10 px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                disabled={sending}
              >
                <option value="info">ℹ️ Info</option>
                <option value="help_request">🆘 Help Request</option>
                <option value="review_request">👀 Review Request</option>
              </select>
            </div>
          </div>

          {/* Message Textarea */}
          <div>
            <label htmlFor="message" className="text-sm font-medium block mb-2">
              Message
            </label>
            <textarea
              id="message"
              placeholder="Type your message to the agent..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none disabled:opacity-50"
              disabled={sending}
            />
            <p className="text-xs text-muted-foreground mt-1">
              This message will appear in the agent's inbox on their next wake cycle.
            </p>
          </div>

          {/* Submit Button */}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={handleCancel}
              disabled={sending}
            >
              <X className="h-4 w-4 mr-1" />
              Cancel
            </Button>
            <Button type="submit" disabled={sending || !message.trim()}>
              {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send Message
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

export default ComposeMessage;
