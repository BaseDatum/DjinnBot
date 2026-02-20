import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Settings, Cpu, Brain, MessageSquare, Layers, Database, Github, Lock, Zap, Puzzle, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { ModelProvidersSettings } from '@/components/settings/ModelProvidersSettings';
import { MemorySearchSettings } from '@/components/settings/MemorySearchSettings';
import { SecretsSettings } from '@/components/settings/SecretsSettings';
import { ProviderModelSelector } from '@/components/ui/ProviderModelSelector';
import { GitHubAppInstallations } from '@/components/github/GitHubAppInstallations';
import { API_BASE } from '@/lib/api';
import { NestedSidebar } from '@/components/layout/NestedSidebar';
import type { NestedSidebarItem } from '@/components/layout/NestedSidebar';
import { useAutoSave } from '@/hooks/useAutoSave';
import { Skeleton } from '@/components/ui/skeleton';
import { SkillsPage } from '@/routes/skills';
import { McpPage } from '@/routes/mcp';
import { PipelinesPage } from '@/routes/pipelines/';

interface GlobalSettings {
  defaultWorkingModel: string;
  defaultThinkingModel: string;
  defaultSlackDecisionModel: string;
  defaultWorkingModelThinkingLevel: string;
  defaultThinkingModelThinkingLevel: string;
  defaultSlackDecisionModelThinkingLevel: string;
  pulseIntervalMinutes: number;
  pulseEnabled: boolean;
}

type SettingsTab = 'providers' | 'memory' | 'models' | 'github' | 'secrets' | 'skills' | 'mcp' | 'pipelines';
const VALID_TABS: SettingsTab[] = ['providers', 'memory', 'models', 'github', 'secrets', 'skills', 'mcp', 'pipelines'];

export const Route = createFileRoute('/settings')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: VALID_TABS.includes(search.tab as SettingsTab) ? (search.tab as SettingsTab) : 'providers',
  }),
  component: SettingsPage,
});

const NAV_ITEMS: NestedSidebarItem[] = [
  { key: 'providers',  label: 'Model Providers', icon: Layers },
  { key: 'memory',     label: 'Memory Search',   icon: Database },
  { key: 'models',     label: 'Default Models',  icon: Cpu },
  { key: 'github',     label: 'GitHub App',      icon: Github },
  { key: 'secrets',    label: 'Secrets',         icon: Lock },
  { key: 'skills',     label: 'Skills',          icon: Zap },
  { key: 'mcp',        label: 'MCP Servers',     icon: Puzzle },
  { key: 'pipelines',  label: 'Pipelines',       icon: Workflow },
];

function SettingsPage() {
  const { tab: activeTab } = Route.useSearch();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsUserEdited, setSettingsUserEdited] = useState(false);

  const setActiveTab = (tab: SettingsTab) => {
    navigate({ to: '.', search: (prev) => ({ ...prev, tab }) });
  };

  useEffect(() => {
    fetch(`${API_BASE}/settings/`)
      .then(res => res.json())
      .then(data => {
        setSettings(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load settings:', err);
        toast.error('Failed to load settings');
        setLoading(false);
      });
  }, []);

  // Auto-save settings when user makes changes
  const { saveState: settingsSaveState } = useAutoSave({
    value: settingsUserEdited ? settings : null,
    onSave: async (value) => {
      if (!value) return;
      const res = await fetch(`${API_BASE}/settings/`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!res.ok) throw new Error('Failed to save');
    },
    delay: 600,
  });

  const handleSettingsChange = (updated: GlobalSettings) => {
    setSettings(updated);
    setSettingsUserEdited(true);
  };

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 md:px-8 md:pt-8 md:pb-4 shrink-0">
          <div className="flex items-center gap-3">
            <Settings className="h-8 w-8" />
            <div>
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings</h1>
              <p className="text-muted-foreground">Global configuration for DjinnBot</p>
            </div>
          </div>
        </div>
        <div className="flex flex-1 min-h-0">
          {/* Sidebar skeleton */}
          <div className="w-48 shrink-0 border-r p-3 space-y-1">
            {[...Array(5)].map((_, i) => <Skeleton key={i} height={36} />)}
          </div>
          {/* Content skeleton */}
          <div className="flex-1 p-6 space-y-4 max-w-3xl">
            <Skeleton width="40%" height={22} />
            <Skeleton width="70%" height={14} />
            <div className="space-y-6 mt-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton width="30%" height={16} />
                  <Skeleton height={40} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="p-4 md:p-8">
        <p className="text-destructive">Failed to load settings</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="p-4 md:px-8 md:pt-8 md:pb-4 shrink-0">
        <div className="flex items-center gap-3">
          <Settings className="h-8 w-8" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings</h1>
            <p className="text-muted-foreground">Global configuration for DjinnBot</p>
          </div>
        </div>
      </div>

      {/* Nested sidebar + content */}
      <NestedSidebar
        items={NAV_ITEMS}
        activeKey={activeTab}
        onSelect={(key) => setActiveTab(key as SettingsTab)}
      >
        {/* ── Model Providers ── */}
        {activeTab === 'providers' && (
          <div className="max-w-5xl mx-auto space-y-2">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Layers className="h-5 w-5" />
                Model Providers
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Configure API keys for AI model providers.
              </p>
            </div>
            <ModelProvidersSettings />
          </div>
        )}

        {/* ── Memory Search ── */}
        {activeTab === 'memory' && (
          <div className="max-w-5xl mx-auto space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Database className="h-5 w-5" />
                Memory Search
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Configure the embedding and reranking provider for agent memory (ClawVault semantic recall).
                Requires an OpenAI-compatible embeddings API —{' '}
                <strong>OpenRouter</strong> is recommended and reuses the key you already configured above.
              </p>
            </div>
            <MemorySearchSettings />
          </div>
        )}

        {/* ── GitHub App ── */}
        {activeTab === 'github' && (
          <div className="max-w-5xl mx-auto">
            <GitHubAppInstallations />
          </div>
        )}

        {/* ── Secrets ── */}
        {activeTab === 'secrets' && (
          <div className="max-w-5xl mx-auto space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Lock className="h-5 w-5" />
                Secrets
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Manage encrypted credentials — PATs, SSH keys, and other secrets —
                and control which agents can use them.
              </p>
            </div>
            <SecretsSettings />
          </div>
        )}

        {/* ── Skills ── */}
        {activeTab === 'skills' && (
          <div className="-m-4 md:-m-8">
            <SkillsPage />
          </div>
        )}

        {/* ── MCP Servers ── */}
        {activeTab === 'mcp' && (
          <div className="-m-4 md:-m-8">
            <McpPage />
          </div>
        )}

        {/* ── Pipelines ── */}
        {activeTab === 'pipelines' && (
          <div className="-m-4 md:-m-8">
            <PipelinesPage />
          </div>
        )}

        {/* ── Default Models ── */}
        {activeTab === 'models' && (
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Cpu className="h-5 w-5" />
                  Default Models
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Fallback models used when agents don't have explicit configuration.
                  Choose a configured provider, then pick a model.
                </p>
              </div>
              {settingsSaveState === 'saving' && (
                <span className="text-xs text-muted-foreground animate-pulse shrink-0 mt-1">Saving…</span>
              )}
              {settingsSaveState === 'saved' && (
                <span className="text-xs text-green-500 shrink-0 mt-1">&#x2713; Saved</span>
              )}
              {settingsSaveState === 'error' && (
                <span className="text-xs text-destructive shrink-0 mt-1">Failed to save</span>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="workingModel" className="flex items-center gap-2">
                <Brain className="h-4 w-4" />
                Default Working Model
              </Label>
              <p className="text-xs text-muted-foreground mb-2">
                Used for pipeline execution, code generation, and complex tasks
              </p>
              <ProviderModelSelector
                value={settings.defaultWorkingModel}
                onChange={(v) => handleSettingsChange({ ...settings, defaultWorkingModel: v })}
                thinkingLevel={settings.defaultWorkingModelThinkingLevel as any}
                onThinkingLevelChange={(l) => handleSettingsChange({ ...settings, defaultWorkingModelThinkingLevel: l })}
                className="w-full sm:w-full"
                placeholder="Select working model..."
              />
              <p className="text-xs text-muted-foreground font-mono mt-1">{settings.defaultWorkingModel}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="thinkingModel" className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Default Thinking Model
              </Label>
              <p className="text-xs text-muted-foreground mb-2">
                Used for quick decisions, classification, and triage tasks
              </p>
              <ProviderModelSelector
                value={settings.defaultThinkingModel}
                onChange={(v) => handleSettingsChange({ ...settings, defaultThinkingModel: v })}
                thinkingLevel={settings.defaultThinkingModelThinkingLevel as any}
                onThinkingLevelChange={(l) => handleSettingsChange({ ...settings, defaultThinkingModelThinkingLevel: l })}
                className="w-full sm:w-full"
                placeholder="Select thinking model..."
              />
              <p className="text-xs text-muted-foreground font-mono mt-1">{settings.defaultThinkingModel}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="slackModel" className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                Default Slack Decision Model
              </Label>
              <p className="text-xs text-muted-foreground mb-2">
                Used when agents need to decide how to respond to Slack messages
              </p>
              <ProviderModelSelector
                value={settings.defaultSlackDecisionModel}
                onChange={(v) => handleSettingsChange({ ...settings, defaultSlackDecisionModel: v })}
                thinkingLevel={settings.defaultSlackDecisionModelThinkingLevel as any}
                onThinkingLevelChange={(l) => handleSettingsChange({ ...settings, defaultSlackDecisionModelThinkingLevel: l })}
                className="w-full sm:w-full"
                placeholder="Select Slack decision model..."
              />
              <p className="text-xs text-muted-foreground font-mono mt-1">{settings.defaultSlackDecisionModel}</p>
            </div>
          </div>
        )}
      </NestedSidebar>
    </div>
  );
}
