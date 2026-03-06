import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { SwarmView } from '@/components/swarm/SwarmView';

export const Route = createFileRoute('/runs/swarm/$swarmId')({
  component: SwarmPage,
});

function SwarmPage() {
  const { swarmId } = Route.useParams();

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800 bg-zinc-900 shrink-0">
        <Link to="/runs" className="text-zinc-400 hover:text-zinc-200 transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <h1 className="text-sm font-medium text-zinc-200">Swarm Execution</h1>
        <span className="text-xs text-zinc-500 font-mono">{swarmId}</span>
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0">
        <SwarmView swarmId={swarmId} />
      </div>
    </div>
  );
}
