import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Brain, Network } from 'lucide-react';
import { MemoryExplorer } from '@/components/memory/MemoryExplorer';
import { MemoryGraph } from '@/components/MemoryGraph';
import { NestedSidebar } from '@/components/layout/NestedSidebar';
import type { NestedSidebarItem } from '@/components/layout/NestedSidebar';

type TabKey = 'vault' | 'graph';

const VALID_TABS: TabKey[] = ['vault', 'graph'];

export const Route = createFileRoute('/memory')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: VALID_TABS.includes(search.tab as TabKey)
      ? (search.tab as TabKey)
      : 'graph',
  }),
  component: SharedMemoryPage,
});

const SHARED_VAULT_ID = 'shared';

const navItems: NestedSidebarItem[] = [
  { key: 'vault', label: 'Memory Vault', icon: Brain },
  { key: 'graph', label: 'Graph', icon: Network },
];

function SharedMemoryPage() {
  const { tab: activeTab } = Route.useSearch();
  const navigate = useNavigate();

  const setActiveTab = (tab: TabKey) => {
    navigate({ to: '.', search: (prev) => ({ ...prev, tab }) });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="p-4 md:px-8 md:pt-8 md:pb-4 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 md:h-16 md:w-16 items-center justify-center rounded-xl bg-muted text-2xl md:text-3xl shrink-0">
            <Brain className="h-7 w-7 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              Shared Memory
            </h1>
            <p className="text-muted-foreground">
              Explore the shared memory vault accessible to all agents
            </p>
          </div>
        </div>
      </div>

      {/* Nested sidebar + content */}
      <NestedSidebar
        items={navItems}
        activeKey={activeTab}
        onSelect={(key) => setActiveTab(key as TabKey)}
      >
        {/* Memory Vault Tab */}
        {activeTab === 'vault' && (
          <div className="max-w-5xl mx-auto">
            <MemoryExplorer agentId={SHARED_VAULT_ID} vaultId={SHARED_VAULT_ID} />
          </div>
        )}

        {/* Graph Tab — full-width, no max-w constraint */}
        {activeTab === 'graph' && <MemoryGraph agentId={SHARED_VAULT_ID} hideViewMode />}
      </NestedSidebar>
    </div>
  );
}
