import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Settings, Key, Lock, Github, Zap, Puzzle, Workflow, LayoutTemplate, Cookie, Radio } from 'lucide-react';
import { UserProviderSettings } from '@/components/settings/UserProviderSettings';
import { SecretsSettings } from '@/components/settings/SecretsSettings';
import { GitHubAppInstallations } from '@/components/github/GitHubAppInstallations';
import { TemplateManager } from '@/components/settings/TemplateManager';
import { SignalSettings } from '@/components/settings/SignalSettings';
import { WhatsAppSettings } from '@/components/settings/WhatsAppSettings';
import { NestedSidebar } from '@/components/layout/NestedSidebar';
import type { NestedSidebarItem } from '@/components/layout/NestedSidebar';
import { SkillsPage } from '@/routes/skills';
import { McpPage } from '@/routes/mcp';
import { PipelinesPage } from '@/routes/pipelines/';
import { BrowserCookiesPage } from '@/routes/browser-cookies';

type SettingsTab = 'providers' | 'secrets' | 'github' | 'skills' | 'mcp' | 'pipelines' | 'templates' | 'cookies' | 'channels';
const VALID_TABS: SettingsTab[] = ['providers', 'secrets', 'github', 'skills', 'mcp', 'pipelines', 'templates', 'cookies', 'channels'];

export const Route = createFileRoute('/settings')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: VALID_TABS.includes(search.tab as SettingsTab) ? (search.tab as SettingsTab) : 'providers',
  }),
  component: SettingsPage,
});

// All users see the same nav — no admin-only items here.
// Admin/instance-level settings live exclusively in /admin.
const NAV_ITEMS: NestedSidebarItem[] = [
  { key: 'providers',  label: 'My API Keys',     icon: Key },
  { key: 'secrets',    label: 'My Secrets',       icon: Lock },
  { key: 'github',     label: 'GitHub App',       icon: Github },
  { key: 'skills',     label: 'Skills',           icon: Zap },
  { key: 'mcp',        label: 'MCP Servers',      icon: Puzzle },
  { key: 'pipelines',  label: 'Pipelines',        icon: Workflow },
  { key: 'templates',  label: 'Templates',        icon: LayoutTemplate },
  { key: 'cookies',    label: 'Browser Cookies',  icon: Cookie },
  { key: 'channels',   label: 'Channels',         icon: Radio },
];

function SettingsPage() {
  const { tab: activeTab } = Route.useSearch();
  const navigate = useNavigate();

  const setActiveTab = (tab: SettingsTab) => {
    navigate({ to: '.', search: (prev) => ({ ...prev, tab }) });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="p-4 md:px-8 md:pt-8 md:pb-4 shrink-0">
        <div className="flex items-center gap-3">
          <Settings className="h-8 w-8" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings</h1>
            <p className="text-muted-foreground">Your personal configuration and credentials</p>
          </div>
        </div>
      </div>

      {/* Nested sidebar + content */}
      <NestedSidebar
        items={NAV_ITEMS}
        activeKey={activeTab}
        onSelect={(key) => setActiveTab(key as SettingsTab)}
      >
        {/* ── My API Keys ── */}
        {activeTab === 'providers' && (
          <div className="max-w-5xl mx-auto space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Key className="h-5 w-5" />
                My API Keys
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Manage your personal API keys for AI model providers.
                Your keys are used when your sessions run and take priority
                over admin-shared instance keys.
              </p>
            </div>
            <UserProviderSettings />
          </div>
        )}

        {/* ── My Secrets ── */}
        {activeTab === 'secrets' && (
          <div className="max-w-5xl mx-auto space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Lock className="h-5 w-5" />
                My Secrets
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Manage your personal secrets (PATs, SSH keys, tokens) and view
                instance secrets shared with you by an admin.
              </p>
            </div>
            <SecretsSettings />
          </div>
        )}

        {/* ── GitHub App ── */}
        {activeTab === 'github' && (
          <div className="max-w-5xl mx-auto">
            <GitHubAppInstallations />
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

        {activeTab === 'templates' && (
          <div className="max-w-5xl mx-auto">
            <TemplateManager />
          </div>
        )}

        {/* ── Browser Cookies ── */}
        {activeTab === 'cookies' && (
          <div className="-m-4 md:-m-8">
            <BrowserCookiesPage />
          </div>
        )}

        {/* ── Channels (shared phone-number integrations) ── */}
        {activeTab === 'channels' && (
          <ChannelsPane />
        )}
      </NestedSidebar>
    </div>
  );
}

// ── Channels sub-pane with Signal / WhatsApp tabs ────────────────────────────

type ChannelSubTab = 'signal' | 'whatsapp';

function ChannelsPane() {
  const [subTab, setSubTab] = useState<ChannelSubTab>('signal');

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Radio className="h-5 w-5" />
          Channels
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Configure shared messaging channels. These use one phone number for
          the entire platform with multi-agent routing.
        </p>
      </div>

      {/* Sub-tab selector */}
      <div className="flex gap-1 border-b border-border">
        <button
          onClick={() => setSubTab('signal')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            subTab === 'signal'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Signal
        </button>
        <button
          onClick={() => setSubTab('whatsapp')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            subTab === 'whatsapp'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          WhatsApp
        </button>
      </div>

      {subTab === 'signal' && <SignalSettings />}
      {subTab === 'whatsapp' && <WhatsAppSettings />}
    </div>
  );
}
