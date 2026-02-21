import { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal, FileEdit, Search, Globe, CheckCircle, XCircle, Loader2, type LucideIcon } from 'lucide-react';

interface ToolCallCardProps {
  toolName: string;
  args?: string;
  result?: string;
  isError?: boolean;
  durationMs?: number;
  status: 'running' | 'complete' | 'error';
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: Terminal,
  write: FileEdit,
  edit: FileEdit,
  read: FileEdit,
  web_search: Globe,
  search: Search,
};

function formatToolArgs(toolName: string, args?: string): { summary: string } {
  if (!args) return { summary: '' };
  try {
    const parsed = JSON.parse(args);
    switch (toolName) {
      case 'bash': return { summary: parsed.command ?? '' };
      case 'write': return { summary: parsed.path ?? parsed.file_path ?? '' };
      case 'read': return { summary: parsed.path ?? parsed.file_path ?? '' };
      case 'edit': return { summary: parsed.path ?? parsed.file_path ?? '' };
      default: return { summary: Object.values(parsed).join(' ').slice(0, 80) };
    }
  } catch {
    return { summary: args.slice(0, 80) };
  }
}

function formatJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}

export function ToolCallCard({ toolName, args, result, isError, durationMs, status }: ToolCallCardProps) {
  const [expandedArgs, setExpandedArgs] = useState(false);
  const [expandedResult, setExpandedResult] = useState(false);
  
  const Icon = TOOL_ICONS[toolName] ?? Terminal;
  const StatusIcon = status === 'running' ? Loader2 
    : status === 'error' ? XCircle 
    : CheckCircle;
  
  const borderColor = status === 'running' ? 'border-amber-500/40'
    : status === 'error' ? 'border-red-500/40'
    : 'border-emerald-500/30';
  
  const bgColor = status === 'running' ? 'bg-amber-500/5'
    : status === 'error' ? 'bg-red-500/5'
    : 'bg-emerald-500/5';

  const formattedArgs = formatToolArgs(toolName, args);
  
  return (
    <div className={`my-2 rounded-md border ${borderColor} ${bgColor}`}>
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <Icon className="h-3.5 w-3.5 text-zinc-400" />
        <span className="font-medium text-zinc-300">{toolName}</span>
        {formattedArgs.summary && (
          <span className="text-zinc-500 truncate max-w-[300px] font-mono">{formattedArgs.summary}</span>
        )}
        <div className="flex-1" />
        {durationMs != null && (
          <span className="text-zinc-500">{(durationMs / 1000).toFixed(1)}s</span>
        )}
        <StatusIcon className={`h-3.5 w-3.5 ${
          status === 'running' ? 'text-amber-400 animate-spin' :
          status === 'error' ? 'text-red-400' : 'text-emerald-400'
        }`} />
      </div>
      
      {args && args !== '{}' && (
        <button
          onClick={() => setExpandedArgs(!expandedArgs)}
          className="flex w-full items-center gap-1 px-3 py-1 text-xs text-zinc-500 hover:text-zinc-400 border-t border-zinc-800/50"
        >
          {expandedArgs ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Arguments
        </button>
      )}
      {expandedArgs && args && (
        <pre className="px-3 py-2 text-xs text-zinc-400 font-mono whitespace-pre-wrap break-words border-t border-zinc-800/50 max-h-48 overflow-y-auto">
          {formatJson(args)}
        </pre>
      )}
      
      {result && (
        <button
          onClick={() => setExpandedResult(!expandedResult)}
          className="flex w-full items-center gap-1 px-3 py-1 text-xs text-zinc-500 hover:text-zinc-400 border-t border-zinc-800/50"
        >
          {expandedResult ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Result {isError && <span className="text-red-400">(error)</span>}
        </button>
      )}
      {expandedResult && result && (
        <pre className={`px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words border-t border-zinc-800/50 max-h-64 overflow-y-auto ${
          isError ? 'text-red-300' : 'text-zinc-400'
        }`}>
          {formatJson(result)}
        </pre>
      )}
    </div>
  );
}
