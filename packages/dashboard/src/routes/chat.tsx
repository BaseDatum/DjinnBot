import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';

const chatSearchSchema = z.object({
  agentId: z.string().optional(),
});

export const Route = createFileRoute('/chat')({
  validateSearch: chatSearchSchema,
  component: ChatPage,
});

function ChatPage() {
  const { agentId } = Route.useSearch();
  return <ChatWorkspace initialAgentId={agentId} />;
}
