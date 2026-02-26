import { createRootRoute, Outlet, useRouterState, useNavigate } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { Sidebar } from '@/components/layout/Sidebar';
import { ChatSessionProvider } from '@/components/chat/ChatSessionContext';
import { LlmCallsProvider } from '@/hooks/useLlmCalls';
import { FloatingChatWidget } from '@/components/chat/FloatingChatWidget';
import { ChatMobilePill } from '@/components/chat/ChatSidebarFlyout';
import { SkeletonTheme } from '@/components/ui/skeleton';
import { AuthProvider, useAuth } from '@/hooks/useAuth';

export const Route = createRootRoute({
  component: RootComponent,
});

/** Public routes that don't require authentication */
const PUBLIC_PATHS = ['/login', '/setup', '/auth/callback'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'));
}

function RootComponent() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

/** Gate that redirects unauthenticated users to login */
function AuthGate() {
  const { location } = useRouterState();
  const { isLoading, isAuthenticated, authStatus } = useAuth();
  const navigate = useNavigate();
  const pathname = location.pathname;

  // Don't block public paths
  if (isPublicPath(pathname)) {
    return <PublicLayout />;
  }

  // Show loading spinner while auth state is being resolved
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  // Auth is disabled — pass through
  if (authStatus && !authStatus.authEnabled) {
    return <AuthenticatedLayout />;
  }

  // Not set up yet — redirect to setup
  if (authStatus && !authStatus.setupComplete) {
    navigate({ to: '/setup' as any });
    return null;
  }

  // Not authenticated — redirect to login
  if (!isAuthenticated) {
    navigate({ to: '/login' as any });
    return null;
  }

  return <AuthenticatedLayout />;
}

/** Layout for public pages (login, setup, callback) — no sidebar */
function PublicLayout() {
  return (
    <SkeletonTheme
      baseColor="hsl(var(--muted))"
      highlightColor="hsl(var(--muted-foreground) / 0.15)"
      borderRadius="0.375rem"
    >
      <Outlet />
      <Toaster richColors position="bottom-right" />
    </SkeletonTheme>
  );
}

/** Layout for authenticated pages — full app with sidebar */
function AuthenticatedLayout() {
  const { location } = useRouterState();
  const isChatPage = location.pathname === '/chat';

  return (
    <ChatSessionProvider>
      <LlmCallsProvider>
      <SkeletonTheme
        baseColor="hsl(var(--muted))"
        highlightColor="hsl(var(--muted-foreground) / 0.15)"
        borderRadius="0.375rem"
      >
      <div className="flex flex-col md:flex-row h-screen">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
        <Toaster richColors position="bottom-right" />
      </div>
      {/* Floating chat widget — accessible from every page */}
      <FloatingChatWidget />
      {/* Mobile chat session pill — only on /chat, bottom-left, mirrors NestedSidebar pattern */}
      {isChatPage && <ChatMobilePill />}
      </SkeletonTheme>
      </LlmCallsProvider>
    </ChatSessionProvider>
  );
}
