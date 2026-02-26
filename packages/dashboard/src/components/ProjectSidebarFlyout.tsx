import { useRef, useState, useCallback } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import {
  Layers,
  Activity,
  Calendar,
  Users,
  Settings,
  Brain,
  FolderKanban,
  ChevronDown,
  MessageSquarePlus,
  Loader2,
} from 'lucide-react';
import { startChatSession, fetchProject, fetchAgents } from '@/lib/api';
import { useChatSessions } from '@/components/chat/ChatSessionContext';

type ViewType = 'board' | 'graph' | 'timeline' | 'team' | 'code' | 'settings';

/** Build a system prompt supplement from the project's onboarding context. */
function buildProjectSupplement(project: any): string {
  let s = `## Project Context: ${project.name}\n\nYou are chatting about the project **${project.name}**.`;
  if (project.description) s += `\n\n**Description:** ${project.description}`;
  if (project.onboarding_context) {
    try {
      const ctx = JSON.parse(project.onboarding_context);
      const lines: string[] = [];
      if (ctx.goal)             lines.push(`**Goal:** ${ctx.goal}`);
      if (ctx.tech_preferences) lines.push(`**Tech stack:** ${ctx.tech_preferences}`);
      if (ctx.repo)             lines.push(`**Repository:** ${ctx.repo}`);
      if (ctx.v1_scope)         lines.push(`**V1 scope:** ${ctx.v1_scope}`);
      if (ctx.target_customer)  lines.push(`**Target customer:** ${ctx.target_customer}`);
      if (ctx.planning_context) lines.push(`\n${ctx.planning_context}`);
      if (lines.length) s += '\n\n' + lines.join('\n');
    } catch {}
  }
  s += '\n\nYou can recall project memories, create new ones, add tasks, and explore the codebase. The full knowledge graph is available via `recall`.';
  return s;
}

/** Shared hook: start a project-context chat and open the floating widget. */
function useProjectChat(projectId: string | undefined) {
  const [loading, setLoading] = useState(false);
  const { openChat, setWidgetOpen } = useChatSessions();

  const start = useCallback(async () => {
    if (!projectId || loading) return;
    setLoading(true);
    try {
      const [project, agents] = await Promise.all([
        fetchProject(projectId),
        fetchAgents().catch(() => [] as any[]),
      ]);
      const agentId = (agents as any[])[0]?.id ?? 'stas';
      const model: string | undefined = (agents as any[])[0]?.model ?? undefined;
      const supplement = buildProjectSupplement(project);
      const result = await startChatSession(agentId, model, supplement);
      openChat(agentId, model ?? '', result.sessionId);
      setWidgetOpen(true);
    } catch (err) {
      console.error('Failed to start project chat:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId, loading, openChat, setWidgetOpen]);

  return { start, loading };
}

const VIEWS: { id: ViewType; label: string; icon: React.ElementType }[] = [
  { id: 'board',    label: 'Board',    icon: Layers },
  { id: 'graph',    label: 'Deps',     icon: Activity },
  { id: 'timeline', label: 'Timeline', icon: Calendar },
  { id: 'team',     label: 'Team',     icon: Users },
  { id: 'code',     label: 'Code',     icon: Brain },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const ROW_H = 32;

// ─────────────────────────────────────────────────────────────────────────────
// Desktop variant
// ─────────────────────────────────────────────────────────────────────────────
export function ProjectSidebarFlyoutDesktop() {
  const { location } = useRouterState();
  const navigate = useNavigate();
  const clearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const match = location.pathname.match(/^\/projects\/([^/]+)/);
  const projectId = match?.[1];
  if (!projectId) return null;

  const { start: startProjectChat, loading: chatLoading } = useProjectChat(projectId);

  const searchParams = new URLSearchParams(location.search);
  const currentView = (searchParams.get('view') as ViewType) || 'board';

  const schedule = (fn: () => void, ms = 150) => {
    if (clearRef.current) clearTimeout(clearRef.current);
    clearRef.current = setTimeout(fn, ms);
  };
  const cancel = () => {
    if (clearRef.current) clearTimeout(clearRef.current);
  };

  const setView = (v: ViewType) => {
    navigate({
      to: '/projects/$projectId',
      params: { projectId },
      search: { view: v, plan: undefined },
    });
  };

  const triggerPlan = () => {
    navigate({
      to: '/projects/$projectId',
      params: { projectId },
      search: { view: currentView, plan: '1' },
    });
  };

  return (
    <div
      className="group flex flex-col h-full border-l overflow-hidden transition-[max-width] duration-200 ease-in-out max-w-[1.5rem] hover:max-w-xs"
      onMouseLeave={() => schedule(() => {})}
      onMouseEnter={() => cancel()}
    >
      {/* Spacer — matches the h-16 logo header in the nav column */}
      <div className="h-16 shrink-0 border-b" />

      {/* Toolbar header */}
      <div className="flex items-center border-b px-1.5 shrink-0" style={{ minHeight: ROW_H }}>
        <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:hidden" />
        <span className="hidden group-hover:block text-[10px] font-semibold text-muted-foreground whitespace-nowrap">
          Project Views
        </span>
      </div>

      {/* View rows + Plan */}
      <ul className="flex flex-col py-0">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          const isActive = currentView === v.id;
          return (
            <li key={v.id} style={{ minHeight: ROW_H }}>
              <button
                onClick={() => setView(v.id)}
                className={cn(
                  'flex w-full items-center gap-1.5 px-1.5 py-2 transition-colors h-full',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent/50 text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="whitespace-nowrap text-[11px] font-medium">{v.label}</span>
              </button>
            </li>
          );
        })}
        <li style={{ minHeight: ROW_H }}>
          <button
            onClick={triggerPlan}
            className="flex w-full items-center gap-1.5 px-1.5 py-2 transition-colors hover:bg-accent/50 text-foreground h-full"
          >
            <Brain className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="whitespace-nowrap text-[11px] font-medium">Plan</span>
          </button>
        </li>
        <li style={{ minHeight: ROW_H }}>
          <button
            onClick={startProjectChat}
            disabled={chatLoading}
            className="flex w-full items-center gap-1.5 px-1.5 py-2 transition-colors hover:bg-accent/50 text-foreground h-full disabled:opacity-50"
          >
            {chatLoading
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
              : <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-primary" />
            }
            <span className="whitespace-nowrap text-[11px] font-medium">Chat</span>
          </button>
        </li>
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile variant
// ─────────────────────────────────────────────────────────────────────────────
export function ProjectSidebarFlyoutMobile({ onClose }: { onClose?: () => void }) {
  const { location } = useRouterState();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const match = location.pathname.match(/^\/projects\/([^/]+)/);
  const projectId = match?.[1];
  if (!projectId) return null;

  const { start: startProjectChat, loading: chatLoading } = useProjectChat(projectId);

  const searchParams = new URLSearchParams(location.search);
  const currentView = (searchParams.get('view') as ViewType) || 'board';

  const setView = (v: ViewType) => {
    navigate({
      to: '/projects/$projectId',
      params: { projectId },
      search: { view: v, plan: undefined },
    });
    onClose?.();
  };

  const triggerPlan = () => {
    navigate({
      to: '/projects/$projectId',
      params: { projectId },
      search: { view: currentView, plan: '1' },
    });
    onClose?.();
  };

  return (
    <div className="border-t">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <FolderKanban className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">Project Views</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="pb-2">
          {VIEWS.map((v) => {
            const Icon = v.icon;
            const isActive = currentView === v.id;
            return (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-6 py-2 text-xs font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {v.label}
              </button>
            );
          })}
          <div className="mx-4 my-1 border-t" />
          <button
            onClick={triggerPlan}
            className="flex w-full items-center gap-3 px-6 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Brain className="h-3.5 w-3.5 shrink-0 text-primary" />
            Plan Project
          </button>
          <button
            onClick={() => { startProjectChat(); onClose?.(); }}
            disabled={chatLoading}
            className="flex w-full items-center gap-3 px-6 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50"
          >
            {chatLoading
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
              : <MessageSquarePlus className="h-3.5 w-3.5 shrink-0 text-primary" />
            }
            Chat about project
          </button>
        </div>
      )}
    </div>
  );
}
