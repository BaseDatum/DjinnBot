import { createFileRoute } from '@tanstack/react-router';
import { AgentsOverview } from '@/components/agents/AgentsOverview';

export const Route = createFileRoute('/agents/' as any)({
  component: AgentsPage,
});

function AgentsPage() {
  return <AgentsOverview />;
}
