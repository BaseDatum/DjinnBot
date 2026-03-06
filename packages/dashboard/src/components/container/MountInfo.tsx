import { Folder, Database, Home, Share2, Code } from 'lucide-react';

interface MountInfoProps {
  agentId: string;
  runId: string;
}

interface MountPoint {
  path: string;
  description: string;
  icon: React.ReactNode;
  access: 'read-write' | 'read-only';
  source: string;
}

/**
 * Displays the volume mounts available to an agent container.
 * This helps users understand what directories the agent has access to.
 */
export function MountInfo({ agentId, runId }: MountInfoProps) {
  const mounts: MountPoint[] = [
    {
      path: '/workspace',
      description: 'Run workspace (git worktree)',
      icon: <Code className="h-3.5 w-3.5 text-blue-400" />,
      access: 'read-write',
      source: `/data/runs/${runId}`,
    },
    {
      path: '/vault',
      description: "Agent's memory vault (ClawVault)",
      icon: <Database className="h-3.5 w-3.5 text-purple-400" />,
      access: 'read-write',
      source: `/data/vaults/${agentId}`,
    },
    {
      path: '/shared',
      description: 'Shared vault for cross-agent data',
      icon: <Share2 className="h-3.5 w-3.5 text-green-400" />,
      access: 'read-write',
      source: '/data/vaults/shared',
    },
    {
      path: '/home/agent',
      description: 'Home directory (installed tools, configs)',
      icon: <Home className="h-3.5 w-3.5 text-orange-400" />,
      access: 'read-write',
      source: `/data/sandboxes/${agentId}`,
    },
  ];

  return (
    <div className="bg-zinc-900/50 rounded-lg border border-zinc-800 p-3">
      <div className="flex items-center gap-2 mb-3">
        <Folder className="h-4 w-4 text-zinc-500" />
        <span className="text-xs font-medium text-zinc-400">Agent Volume Mounts</span>
      </div>
      
      <div className="space-y-2">
        {mounts.map((mount) => (
          <div
            key={mount.path}
            className="flex items-start gap-2 text-xs"
          >
            <div className="mt-0.5 flex-shrink-0">{mount.icon}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <code className="text-zinc-300 font-mono">{mount.path}</code>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                  mount.access === 'read-write' 
                    ? 'bg-green-500/10 text-green-400'
                    : 'bg-yellow-500/10 text-yellow-400'
                }`}>
                  {mount.access === 'read-write' ? 'RW' : 'RO'}
                </span>
              </div>
              <div className="text-zinc-500 mt-0.5">{mount.description}</div>
              <div className="text-zinc-600 font-mono text-[10px] mt-0.5">
                ← {mount.source}
              </div>
            </div>
          </div>
        ))}
      </div>
      
      <div className="mt-3 pt-2 border-t border-zinc-800">
        <div className="text-[10px] text-zinc-600">
          <span className="text-zinc-500">Security:</span> Agent has access only to its own vault and sandbox.
          Other agents' data is isolated.
        </div>
      </div>
    </div>
  );
}
