import { Link, useRouterState } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Play,
  Bot,
  Brain,
  Moon,
  Sun,
  Menu,
  X,
  FolderKanban,
  Settings,
  MessagesSquare,
} from 'lucide-react';
import { fetchAgents } from '@/lib/api';
import { DashboardQuickActionsDesktop } from '@/components/DashboardQuickActions';
import {
  ProjectSidebarFlyoutDesktop,
  ProjectSidebarFlyoutMobile,
} from '@/components/ProjectSidebarFlyout';
import {
  ChatSidebarFlyoutDesktop,
  ChatSidebarFlyoutMobile,
} from '@/components/chat/ChatSidebarFlyout';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/chat', label: 'Chat', icon: MessagesSquare },
  { to: '/memory', label: 'Memory', icon: Brain },
  { to: '/runs', label: 'Runs', icon: Play },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const { location } = useRouterState();
  const isDashboard = location.pathname === '/';
  const isProjectPage = /^\/projects\/[^/]+/.test(location.pathname);
  const isChatPage = location.pathname === '/chat';

  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('djinnbot-theme');
      if (saved) return saved === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  // Fetch agents only when on the dashboard — used for quick actions
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: fetchAgents,
    enabled: isDashboard,
    staleTime: 30_000,
  });

  useEffect(() => {
    const root = window.document.documentElement;
    if (isDark) {
      root.classList.add('dark');
      localStorage.setItem('djinnbot-theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('djinnbot-theme', 'light');
    }
  }, [isDark]);

  // Close mobile menu on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const sidebarContent = (
    <>
      <nav className="flex-1 p-4">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              location.pathname === item.to ||
              (item.to !== '/' && location.pathname.startsWith(item.to));

            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t p-4">
        <button
          onClick={() => setIsDark(!isDark)}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {isDark ? (
            <>
              <Sun className="h-4 w-4" />
              Light mode
            </>
          ) : (
            <>
              <Moon className="h-4 w-4" />
              Dark mode
            </>
          )}
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* ── Mobile header bar ── */}
      <div className="sticky top-0 z-40 flex h-14 items-center border-b bg-card px-4 md:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="rounded-md p-2 text-muted-foreground hover:bg-accent"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 ml-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
            <Bot className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="text-base font-semibold">DjinnBot</span>
        </div>
      </div>

      {/* ── Mobile overlay + drawer ── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="relative flex h-full w-72 flex-col bg-card shadow-xl">
            <div className="flex h-14 items-center justify-between border-b px-4">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
                  <Bot className="h-4 w-4 text-primary-foreground" />
                </div>
                <span className="text-base font-semibold">DjinnBot</span>
              </div>
              <button
                onClick={() => setMobileOpen(false)}
                className="rounded-md p-2 text-muted-foreground hover:bg-accent"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Nav items */}
            {sidebarContent}

            {/* Agent quick actions on dashboard are now a standalone floating
                button rendered directly by the dashboard page */}

            {/* Project view switcher — only on a project detail page */}
            {isProjectPage && (
              <ProjectSidebarFlyoutMobile onClose={() => setMobileOpen(false)} />
            )}

            {/* Chat session manager — only on /chat page */}
            {isChatPage && (
              <ChatSidebarFlyoutMobile onClose={() => setMobileOpen(false)} />
            )}
          </aside>
        </div>
      )}

      {/* ── Desktop sidebar ── */}
      {/*
        The aside is now a flex-row container. The left nav column keeps its
        fixed w-64 shape. Page-specific toolbars sit to the right of the nav
        separated by a border-l divider — they expand rightward within the
        sidebar so they never overlap page content when collapsed.
      */}
      <aside className="hidden md:flex h-screen flex-row border-r bg-card shrink-0">
        {/* Nav column */}
        <div className="flex w-64 flex-col shrink-0">
          <div className="flex h-16 items-center border-b px-6">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
                <Bot className="h-5 w-5 text-primary-foreground" />
              </div>
              <span className="text-lg font-semibold">DjinnBot</span>
            </div>
          </div>

          {sidebarContent}
        </div>

        {/* Page-specific toolbar panel — sits to the right of the nav column,
            separated by an implicit border-l. Expands inline; no overlap. */}
        {isDashboard && agents.length > 0 && (
          <DashboardQuickActionsDesktop agents={agents} />
        )}
        {isProjectPage && <ProjectSidebarFlyoutDesktop />}
        {isChatPage && <ChatSidebarFlyoutDesktop />}
      </aside>
    </>
  );
}
