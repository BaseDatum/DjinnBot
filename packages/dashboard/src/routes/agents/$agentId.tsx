import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft,
  Brain,
  MessageSquare,
  FileText,
  Settings,
  Network,
  Inbox,
  Activity,
  Box,
  List,
  MessagesSquare,
  Zap,
  Radio,
  Plug,
  ChevronRight,
  Wrench,
  GitMerge,
} from 'lucide-react';
import { ProviderModelSelector } from '@/components/ui/ProviderModelSelector';
import { useState, useEffect, useCallback } from 'react';
import { fetchAgent, fetchAgentMemory, fetchAgentConfig, updateAgentConfig, updateAgentFile, fetchAgentInbox } from '@/lib/api';
import { useAutoSave } from '@/hooks/useAutoSave';
import { Skeleton } from '@/components/ui/skeleton';
import { useChatSessions } from '@/components/chat/ChatSessionContext';

import { MemoryGraphContainer } from '@/components/MemoryGraphContainer';
import { MemoryExplorer } from '@/components/memory/MemoryExplorer';
import { AgentInbox } from '@/components/inbox/AgentInbox';
import { AgentActivity } from '@/components/activity/AgentActivity';
import { SandboxExplorer } from '@/components/sandbox/SandboxExplorer';
import { SessionsTab } from '@/components/sessions';
import { DangerZone } from '@/components/settings/DangerZone';
import { AgentProjectsTab } from '@/components/agents/AgentProjectsTab';
import { AgentPulseTab } from '@/components/agents/AgentPulseTab';
import { AgentSkillsTab } from '@/components/skills/AgentSkillsTab';
import { AgentChannelsTab } from '@/components/channels/AgentChannelsTab';
import { BuiltInToolsTab } from '@/components/agents/BuiltInToolsTab';
import { AgentCoordinationTab } from '@/components/agents/AgentCoordinationTab';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { NestedSidebar } from '@/components/layout/NestedSidebar';
import type { NestedSidebarItem } from '@/components/layout/NestedSidebar';
import type { AgentConfig } from '@/types/config';

interface AgentDetail {
  id: string;
  name: string;
  emoji: string | null;
  role: string | null;
  description: string | null;
  persona_files: string[];
  slack_connected: boolean;
  memory_count: number;
  files: Record<string, string>;
  soul_preview: string | null;
}

interface MemoryFile {
  filename: string;
  category: string | null;
  title: string | null;
  created_at: number | null;
  size_bytes: number;
  preview: string | null;
}

type TabKey = 'persona' | 'projects' | 'memory' | 'graph' | 'inbox' | 'activity' | 'sessions' | 'sandbox' | 'pulse' | 'coordination' | 'channels' | 'settings' | 'skills' | 'tools';

const VALID_TABS: TabKey[] = ['persona', 'projects', 'memory', 'graph', 'inbox', 'activity', 'sessions', 'sandbox', 'pulse', 'coordination', 'channels', 'settings', 'skills', 'tools'];

export const Route = createFileRoute('/agents/$agentId')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: VALID_TABS.includes(search.tab as TabKey) ? (search.tab as TabKey) : 'persona',
  }),
  component: AgentDetailPage,
});

function AgentDetailPage() {
  const { agentId } = Route.useParams() as { agentId: string };
  const { tab: activeTab } = Route.useSearch();
  const navigate = useNavigate();
  const { openChat, setWidgetOpen } = useChatSessions();
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [memories, setMemories] = useState<MemoryFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  const setActiveTab = (tab: TabKey) => {
    navigate({ to: '.', search: (prev) => ({ ...prev, tab }) });
  };

  // Persona editing state
  const [editedFiles, setEditedFiles] = useState<Record<string, string>>({});
  const [originalFiles, setOriginalFiles] = useState<Record<string, string>>({});
  const [saveStatus, setSaveStatus] = useState<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({});
  const [openPersonaFiles, setOpenPersonaFiles] = useState<Record<string, boolean>>({});

  // Settings state
  const [config, setConfig] = useState<AgentConfig>({ model: '', thinkingModel: '' });
  const [configUserEdited, setConfigUserEdited] = useState(false);

  useEffect(() => {
    Promise.all([
      fetchAgent(agentId),
      fetchAgentMemory(agentId).catch(() => []),
      fetchAgentConfig(agentId).catch(() => ({ model: '', thinkingModel: '' })),
      fetchAgentInbox(agentId).catch(() => ({ messages: [], unreadCount: 0, totalCount: 0, hasMore: false })),
    ])
      .then(([agentData, memData, configData, inboxData]) => {
        setAgent(agentData);
        setMemories(memData);
        setEditedFiles(agentData.files || {});
        setOriginalFiles(agentData.files || {});
        setConfig(configData as AgentConfig);
        setUnreadCount(inboxData.unreadCount || 0);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  const handleSaveFile = async (filename: string) => {
    setSaveStatus(prev => ({ ...prev, [filename]: 'saving' }));
    try {
      await updateAgentFile(agentId, filename, editedFiles[filename]);
      setOriginalFiles(prev => ({ ...prev, [filename]: editedFiles[filename] }));
      setSaveStatus(prev => ({ ...prev, [filename]: 'saved' }));
      setTimeout(() => setSaveStatus(prev => ({ ...prev, [filename]: 'idle' })), 2000);
    } catch {
      setSaveStatus(prev => ({ ...prev, [filename]: 'error' }));
    }
  };

  const handleChat = useCallback(async () => {
    // Always use the agent's configured model
    const chatModel = config.model || '';
    openChat(agentId, chatModel);
    setWidgetOpen(true);
  }, [agentId, config.model, openChat, setWidgetOpen]);

  // Auto-save config when user makes changes (not on initial load)
  const { saveState: configSaveState } = useAutoSave({
    value: configUserEdited ? config : null,
    onSave: async () => {
      await updateAgentConfig(agentId, config);
    },
    delay: 600,
  });

  const handleConfigChange = (updated: AgentConfig) => {
    setConfig(updated);
    setConfigUserEdited(true);
  };

  // Build nav items — badge counts are reactive so we include them here
  const navItems: NestedSidebarItem[] = [
    { key: 'chat-link', label: 'Chat', icon: MessagesSquare, onClick: handleChat },
    { key: 'projects', label: 'Projects', icon: Network },
    { key: 'persona', label: 'Persona', icon: FileText },
    { key: 'inbox', label: 'Inbox', icon: Inbox, badge: unreadCount },
    { key: 'activity', label: 'Activity', icon: Activity },
    { key: 'sessions', label: 'Sessions', icon: List },
    { key: 'memory', label: 'Memory Vault', icon: Brain, badge: memories.length || undefined },
    { key: 'graph', label: 'Graph', icon: Network },
    { key: 'sandbox', label: 'Sandbox', icon: Box },
    { key: 'skills', label: 'Skills', icon: Zap },
    { key: 'tools', label: 'Tools', icon: Wrench },
    { key: 'pulse', label: 'Pulse', icon: Radio },
    { key: 'coordination', label: 'Coordination', icon: GitMerge },
    { key: 'channels', label: 'Channels', icon: Plug },
    { key: 'settings', label: 'Settings', icon: Settings },
  ];

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 md:px-8 md:pt-8 md:pb-4 shrink-0">
          <Link to="/agents" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to agents
          </Link>
          <div className="flex items-center gap-4 mt-1">
            <Skeleton circle width={64} height={64} />
            <div className="space-y-2 flex-1">
              <Skeleton width="40%" height={28} />
              <Skeleton width="25%" height={16} />
              <div className="flex gap-2 mt-1">
                <Skeleton width={100} height={22} />
                <Skeleton width={80} height={22} />
              </div>
            </div>
          </div>
        </div>
        <div className="flex-1 p-4 md:px-8 space-y-4">
          <div className="flex gap-3 mb-4">
            {[...Array(5)].map((_, i) => <Skeleton key={i} width={80} height={32} />)}
          </div>
          <div className="space-y-3 max-w-5xl">
            <Skeleton height={120} />
            <Skeleton height={80} />
            <Skeleton height={80} />
          </div>
        </div>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="p-4 md:p-8">
        <Link to="/agents" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to agents
        </Link>
        <p className="text-destructive">Error: {error || 'Agent not found'}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header — outside the nested sidebar so it spans full width */}
      <div className="p-4 md:px-8 md:pt-8 md:pb-4 shrink-0">
        <Link to="/agents" className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to agents
        </Link>

        <div className="flex items-center gap-4 mt-1">
          <div className="flex h-12 w-12 md:h-16 md:w-16 items-center justify-center rounded-xl bg-muted text-2xl md:text-3xl shrink-0">
            {agent.emoji || '🤖'}
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{agent.name}</h1>
            {agent.role && <p className="text-muted-foreground">{agent.role}</p>}
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={agent.slack_connected ? 'default' : 'outline'} className="text-xs">
                <MessageSquare className="h-3 w-3 mr-1" />
                {agent.slack_connected ? 'Slack Connected' : 'No Slack'}
              </Badge>
              {agent.memory_count > 0 && (
                <Badge variant="secondary" className="text-xs">
                  <Brain className="h-3 w-3 mr-1" />
                  {agent.memory_count} memories
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Nested sidebar + content */}
      <NestedSidebar
        items={navItems}
        activeKey={activeTab}
        onSelect={(key) => setActiveTab(key as TabKey)}
      >
        {/* Projects Tab */}
        {activeTab === 'projects' && (
          <div className="max-w-5xl mx-auto">
            <AgentProjectsTab agentId={agentId} />
          </div>
        )}

        {/* Persona Tab */}
        {activeTab === 'persona' && (
          <div className="max-w-5xl mx-auto space-y-4">
            {agent.persona_files.map((pf) => {
              const hasChanges = editedFiles[pf] !== originalFiles[pf];
              const status = saveStatus[pf] || 'idle';
              const isOpen = openPersonaFiles[pf] ?? false;

              return (
                <Collapsible
                  key={pf}
                  open={isOpen}
                  onOpenChange={(open) => setOpenPersonaFiles(prev => ({ ...prev, [pf]: open }))}
                >
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CollapsibleTrigger asChild>
                          <button className="flex items-center gap-2 group cursor-pointer text-left">
                            <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`} />
                            <CardTitle className="text-sm font-mono group-hover:underline">{pf}</CardTitle>
                            {hasChanges && status !== 'saving' && (
                              <Badge variant="outline" className="text-xs text-yellow-500 border-yellow-500/30">
                                Unsaved changes
                              </Badge>
                            )}
                          </button>
                        </CollapsibleTrigger>
                        <div className="flex items-center gap-2">
                          {status === 'saving' && (
                            <span className="text-sm text-muted-foreground animate-pulse">Saving...</span>
                          )}
                          {status === 'saved' && (
                            <span className="text-sm text-green-500">Saved</span>
                          )}
                          {status === 'error' && (
                            <span className="text-sm text-destructive">Error saving</span>
                          )}
                          <Button
                            size="sm"
                            onClick={() => handleSaveFile(pf)}
                            disabled={!hasChanges || status === 'saving'}
                            variant={hasChanges ? 'default' : 'outline'}
                          >
                            Save
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CollapsibleContent>
                      <CardContent>
                        <textarea
                          value={editedFiles[pf] || ''}
                          onChange={(e) => setEditedFiles(prev => ({ ...prev, [pf]: e.target.value }))}
                          className="w-full h-64 rounded-md border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                          spellCheck={false}
                        />
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              );
            })}
            {agent.persona_files.length === 0 && (
              <p className="text-muted-foreground text-center py-12">No persona files found.</p>
            )}
          </div>
        )}

        {/* Inbox Tab */}
        {activeTab === 'inbox' && (
          <div className="max-w-5xl mx-auto">
            <AgentInbox agentId={agentId} />
          </div>
        )}

        {/* Activity Tab */}
        {activeTab === 'activity' && (
          <div className="max-w-5xl mx-auto">
            <AgentActivity agentId={agentId} />
          </div>
        )}

        {/* Sessions Tab */}
        {activeTab === 'sessions' && (
          <div className="max-w-5xl mx-auto">
            <SessionsTab agentId={agentId} />
          </div>
        )}

        {/* Sandbox Tab */}
        {activeTab === 'sandbox' && (
          <div className="max-w-5xl mx-auto">
            <SandboxExplorer agentId={agentId} />
          </div>
        )}

        {/* Skills Tab */}
        {activeTab === 'skills' && (
          <div className="max-w-5xl mx-auto">
            <AgentSkillsTab agentId={agentId} />
          </div>
        )}

        {/* Tools Tab */}
        {activeTab === 'tools' && (
          <div className="max-w-5xl mx-auto">
            <BuiltInToolsTab agentId={agentId} />
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <div className="max-w-5xl mx-auto space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Model Configuration</CardTitle>
                  {configSaveState === 'saving' && (
                    <span className="text-xs text-muted-foreground animate-pulse">Saving…</span>
                  )}
                  {configSaveState === 'saved' && (
                    <span className="text-xs text-green-500">&#x2713; Saved</span>
                  )}
                  {configSaveState === 'error' && (
                    <span className="text-xs text-destructive">Failed to save</span>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <label className="block text-sm font-medium mb-1">Working Model</label>
                  <p className="text-xs text-muted-foreground mb-2">
                    The default LLM for this agent — used for pipeline steps, chat, and as fallback for all other model roles.
                  </p>
                  <ProviderModelSelector
                    value={config.model || ''}
                    onChange={(v) => handleConfigChange({ ...config, model: v })}
                    thinkingLevel={config.thinkingLevel as any}
                    onThinkingLevelChange={(l) => handleConfigChange({ ...config, thinkingLevel: l as any })}
                    className="w-full sm:w-full"
                    placeholder="Select working model (or inherit global default)..."
                  />
                  {config.model && (
                    <p className="text-xs text-muted-foreground font-mono mt-1">{config.model}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Planning Model</label>
                  <p className="text-xs text-muted-foreground mb-2">
                    The LLM used during pulse routines for strategic work — claiming tasks, reading context, writing
                    execution prompts, and reviewing results. This should be your smartest model.
                  </p>
                  <ProviderModelSelector
                    value={config.planningModel || ''}
                    onChange={(v) => handleConfigChange({ ...config, planningModel: v })}
                    className="w-full sm:w-full"
                    placeholder="Defaults to working model if not set..."
                  />
                  {config.planningModel && (
                    <p className="text-xs text-muted-foreground font-mono mt-1">{config.planningModel}</p>
                  )}
                  {!config.planningModel && config.model && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Using working model: <span className="font-mono">{config.model}</span>
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Executor Model</label>
                  <p className="text-xs text-muted-foreground mb-2">
                    The LLM used when this agent spawns a fresh executor via <code className="text-xs bg-muted px-1 rounded">spawn_executor()</code>.
                    The planning model writes a thorough prompt, then the executor model implements it in a clean context window.
                    Use a fast/cheap model here to optimize cost.
                  </p>
                  <ProviderModelSelector
                    value={config.executorModel || ''}
                    onChange={(v) => handleConfigChange({ ...config, executorModel: v })}
                    className="w-full sm:w-full"
                    placeholder="Defaults to working model if not set..."
                  />
                  {config.executorModel && (
                    <p className="text-xs text-muted-foreground font-mono mt-1">{config.executorModel}</p>
                  )}
                  {!config.executorModel && config.model && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Using working model: <span className="font-mono">{config.model}</span>
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Decision Model</label>
                  <p className="text-xs text-muted-foreground mb-2">
                    The LLM used for Slack triage — deciding whether to respond, acknowledge, or ignore messages.
                  </p>
                  <ProviderModelSelector
                    value={config.thinkingModel || ''}
                    onChange={(v) => handleConfigChange({ ...config, thinkingModel: v })}
                    thinkingLevel={config.thinkingModelThinkingLevel as any}
                    onThinkingLevelChange={(l) => handleConfigChange({ ...config, thinkingModelThinkingLevel: l as any })}
                    className="w-full sm:w-full"
                    placeholder="Select decision model (or inherit global default)..."
                  />
                  {config.thinkingModel && (
                    <p className="text-xs text-muted-foreground font-mono mt-1">{config.thinkingModel}</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Thread Behavior</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Thread Response Mode</label>
                  <p className="text-xs text-muted-foreground mb-3">
                    Controls when this agent evaluates and potentially responds to thread messages in shared channels.
                  </p>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="threadMode"
                        value="passive"
                        checked={config.threadMode !== 'active'}
                        onChange={() => handleConfigChange({ ...config, threadMode: 'passive' })}
                        className="h-4 w-4"
                      />
                      <div>
                        <span className="font-medium">Passive</span>
                        <p className="text-xs text-muted-foreground">Only respond if @mentioned or already participated in thread</p>
                      </div>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="threadMode"
                        value="active"
                        checked={config.threadMode === 'active'}
                        onChange={() => handleConfigChange({ ...config, threadMode: 'active' })}
                        className="h-4 w-4"
                      />
                      <div>
                        <span className="font-medium">Active</span>
                        <p className="text-xs text-muted-foreground">Evaluate all threads in channels where agent is present</p>
                      </div>
                    </label>
                  </div>
                </div>
              </CardContent>
            </Card>

            <DangerZone agentId={agentId} agentName={agent.name} />
          </div>
        )}

        {/* Pulse Tab */}
        {activeTab === 'pulse' && (
          <div className="max-w-5xl mx-auto">
            <AgentPulseTab
              agentId={agentId}
              config={config}
              onConfigChange={setConfig}
            />
          </div>
        )}

        {/* Coordination Tab */}
        {activeTab === 'coordination' && (
          <div className="max-w-5xl mx-auto">
            <AgentCoordinationTab
              agentId={agentId}
              config={config}
              onConfigChange={handleConfigChange}
            />
          </div>
        )}

        {/* Graph Tab — intentionally full-width, no max-w constraint */}
        {activeTab === 'graph' && (
          <MemoryGraphContainer agentId={agentId} />
        )}

        {/* Memory Tab */}
        {activeTab === 'memory' && (
          <div className="max-w-5xl mx-auto">
            <MemoryExplorer agentId={agentId} />
          </div>
        )}

        {/* Channels Tab */}
        {activeTab === 'channels' && (
          <div className="max-w-5xl mx-auto">
            <AgentChannelsTab agentId={agentId} />
          </div>
        )}
      </NestedSidebar>
    </div>
  );
}
