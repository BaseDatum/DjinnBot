import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { Sidebar } from '@/components/layout/Sidebar';
import { ChatSessionProvider } from '@/components/chat/ChatSessionContext';
import { FloatingChatWidget } from '@/components/chat/FloatingChatWidget';
import { ChatMobilePill } from '@/components/chat/ChatSidebarFlyout';
import { SkeletonTheme } from '@/components/ui/skeleton';

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  const { location } = useRouterState();
  const isChatPage = location.pathname === '/chat';

  return (
    <ChatSessionProvider>
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
    </ChatSessionProvider>
  );
}
