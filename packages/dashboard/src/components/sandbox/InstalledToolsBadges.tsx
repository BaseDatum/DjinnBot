import type { InstalledTool } from '@/types/sandbox';

const TYPE_ICONS: Record<string, string> = {
  python: '🐍',
  npm: '📦',
  go: '🔧',
  binary: '⚙️',
};

export function InstalledToolsBadges({ tools }: { tools: InstalledTool[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {tools.map((tool, i) => (
        <div
          key={i}
          className="inline-flex items-center gap-1.5 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs"
        >
          <span>{TYPE_ICONS[tool.type] || '📦'}</span>
          <span className="text-zinc-300">{tool.name}</span>
          {tool.version && <span className="text-zinc-600">{tool.version}</span>}
        </div>
      ))}
    </div>
  );
}
