import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect, useRef } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Puzzle, Plus, Trash2, Edit2, X, ToggleLeft, ToggleRight,
  Loader2, ChevronDown, ChevronUp, Users, ShieldCheck, RefreshCw,
  Terminal, AlertTriangle, CheckCircle2, CircleDashed, StopCircle,
  Sparkles, Code2, Save, ExternalLink,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import {
  fetchMcpServers,
  fetchAgents,
  fetchAgentMcpTools,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  setMcpServerEnabled,
  grantMcpServerToAgent,
  revokeMcpServerFromAgent,
  grantMcpToolToAgent,
  revokeMcpToolFromAgent,
  restartMcpo,
  type McpServerItem,
  type McpToolGrant,
  type AgentListItem,
  API_BASE,
} from '@/lib/api';

export const Route = createFileRoute('/mcp')({
  component: McpPage,
});

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: McpServerItem['status'] }) {
  const map = {
    running: { icon: CheckCircle2, label: 'Running', cls: 'text-green-500 border-green-500/30' },
    configuring: { icon: CircleDashed, label: 'Configuring', cls: 'text-yellow-500 border-yellow-500/30' },
    error: { icon: AlertTriangle, label: 'Error', cls: 'text-destructive border-destructive/30' },
    stopped: { icon: StopCircle, label: 'Stopped', cls: 'text-muted-foreground border-muted-foreground/30' },
  };
  const { icon: Icon, label, cls } = map[status] ?? map.stopped;
  return (
    <Badge variant="outline" className={`text-xs flex items-center gap-1 ${cls}`}>
      <Icon className="h-3 w-3" />{label}
    </Badge>
  );
}

// ── Tool access panel ─────────────────────────────────────────────────────────

function ToolAccessPanel({
  server,
  agents,
  onClose,
}: {
  server: McpServerItem;
  agents: AgentListItem[];
  onClose: () => void;
}) {
  const [grants, setGrants] = useState<McpToolGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(
      agents.map(a =>
        fetchAgentMcpTools(a.id)
          .then(tools => tools.filter(t => t.server_id === server.id))
          .catch(() => [] as McpToolGrant[]),
      ),
    ).then(results => {
      if (cancelled) return;
      setGrants(results.flat());
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [server.id, agents]);

  // We embed agent ID into grants for cross-referencing
  useEffect(() => {
    // re-fetch attaching agent IDs
    let cancelled = false;
    setLoading(true);
    Promise.all(
      agents.map(a =>
        fetchAgentMcpTools(a.id)
          .then(tools => tools.filter(t => t.server_id === server.id).map(t => ({ ...t, _agentId: a.id })))
          .catch(() => [] as (McpToolGrant & { _agentId: string })[]),
      ),
    ).then(results => {
      if (!cancelled) setGrants(results.flat() as any);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [server.id, agents]);

  const handleGrantServer = async (agentId: string) => {
    setBusy(agentId);
    try {
      await grantMcpServerToAgent(agentId, server.id);
      // Optimistically add wildcard grant
      setGrants(prev => [
        ...prev.filter((g: any) => !(g._agentId === agentId && g.tool_name === '*')),
        { server_id: server.id, tool_name: '*', granted_by: 'ui', granted_at: Date.now(), server_name: server.name, server_status: server.status, _agentId: agentId } as any,
      ]);
      toast.success(`Granted all tools on "${server.name}" to ${agentId}`);
    } catch { toast.error('Failed to grant'); }
    finally { setBusy(null); }
  };

  const handleRevokeServer = async (agentId: string) => {
    setBusy(agentId);
    try {
      await revokeMcpServerFromAgent(agentId, server.id);
      setGrants(prev => prev.filter((g: any) => g._agentId !== agentId));
      toast.success(`Revoked "${server.name}" from ${agentId}`);
    } catch { toast.error('Failed to revoke'); }
    finally { setBusy(null); }
  };

  const handleGrantTool = async (agentId: string, toolName: string) => {
    setBusy(`${agentId}:${toolName}`);
    try {
      await grantMcpToolToAgent(agentId, server.id, toolName);
      setGrants(prev => [
        ...prev.filter((g: any) => !(g._agentId === agentId && g.tool_name === toolName)),
        { server_id: server.id, tool_name: toolName, granted_by: 'ui', granted_at: Date.now(), server_name: server.name, server_status: server.status, _agentId: agentId } as any,
      ]);
      toast.success(`Granted ${toolName} to ${agentId}`);
    } catch { toast.error('Failed to grant tool'); }
    finally { setBusy(null); }
  };

  const handleRevokeTool = async (agentId: string, toolName: string) => {
    setBusy(`${agentId}:${toolName}`);
    try {
      await revokeMcpToolFromAgent(agentId, server.id, toolName);
      setGrants(prev => prev.filter((g: any) => !(g._agentId === agentId && g.tool_name === toolName)));
      toast.success(`Revoked ${toolName} from ${agentId}`);
    } catch { toast.error('Failed to revoke tool'); }
    finally { setBusy(null); }
  };

  const hasToolGrant = (agentId: string, toolName: string) =>
    grants.some((g: any) => g._agentId === agentId && g.tool_name === toolName);

  const tools = server.discovered_tools;

  return (
    <div className="border rounded-lg bg-card p-4 mt-2 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="h-4 w-4" />
          Agent Access — <code className="font-mono text-xs bg-muted px-1 rounded">{server.id}</code>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted">
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading...
        </div>
      ) : (
        <div className="space-y-2">
          {agents.map(agent => {
            const agentHasWildcard = grants.some((g: any) => g._agentId === agent.id && g.tool_name === '*');
            const agentBusy = busy === agent.id;
            const expanded = expandedAgents.has(agent.id);

            return (
              <div key={agent.id} className="rounded-md border overflow-hidden">
                {/* Agent row */}
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2 text-sm">
                    {agent.emoji && <span>{agent.emoji}</span>}
                    <span className="font-medium">{agent.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">{agent.id}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {agentHasWildcard && (
                      <Badge variant="secondary" className="text-xs flex items-center gap-1">
                        <ShieldCheck className="h-2.5 w-2.5" /> All tools
                      </Badge>
                    )}
                    {/* Per-tool toggle — only show if server has discovered tools */}
                    {tools.length > 0 && (
                      <button
                        onClick={() => setExpandedAgents(prev => {
                          const next = new Set(prev);
                          if (next.has(agent.id)) next.delete(agent.id); else next.add(agent.id);
                          return next;
                        })}
                        className="p-1 rounded hover:bg-muted text-muted-foreground text-xs flex items-center gap-0.5"
                        title="Per-tool access"
                      >
                        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      </button>
                    )}
                    <Button
                      size="sm"
                      variant={agentHasWildcard ? 'outline' : 'default'}
                      className="h-6 px-2 text-xs"
                      disabled={agentBusy}
                      onClick={() => agentHasWildcard ? handleRevokeServer(agent.id) : handleGrantServer(agent.id)}
                    >
                      {agentBusy
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : agentHasWildcard ? 'Revoke all' : 'Grant all'}
                    </Button>
                  </div>
                </div>

                {/* Per-tool rows */}
                {expanded && tools.length > 0 && (
                  <div className="border-t bg-muted/20 px-3 py-2 space-y-1">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">Per-tool access</p>
                    {tools.map(tool => {
                      const toolGranted = agentHasWildcard || hasToolGrant(agent.id, tool);
                      const toolBusy = busy === `${agent.id}:${tool}`;
                      return (
                        <div key={tool} className="flex items-center justify-between">
                          <code className="text-xs font-mono">{tool}</code>
                          <Button
                            size="sm"
                            variant={toolGranted ? 'outline' : 'ghost'}
                            className="h-5 px-1.5 text-[10px]"
                            disabled={toolBusy || agentHasWildcard}
                            onClick={() => toolGranted
                              ? handleRevokeTool(agent.id, tool)
                              : handleGrantTool(agent.id, tool)}
                          >
                            {toolBusy
                              ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                              : toolGranted ? 'Revoke' : 'Grant'}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Log viewer panel ──────────────────────────────────────────────────────────

function LogPanel({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<Array<{ line: string; level: string; ts: string }>>([]);
  const [connected, setConnected] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/mcp/logs/stream`);
    esRef.current = es;

    es.addEventListener('connected', () => setConnected(true));
    es.addEventListener('log', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setLogs(prev => [...prev.slice(-500), data]);
        setTimeout(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        }, 0);
      } catch {}
    });
    es.onerror = () => setConnected(false);

    return () => { es.close(); };
  }, []);

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await restartMcpo();
      toast.success('mcpo reload requested');
      setLogs(prev => [...prev, { line: '--- Reload requested ---', level: 'info', ts: new Date().toISOString() }]);
    } catch { toast.error('Failed to request reload'); }
    finally { setRestarting(false); }
  };

  const levelColor = (level: string) =>
    level === 'error' ? 'text-red-400' : level === 'warn' ? 'text-yellow-400' : 'text-muted-foreground';

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-muted/30">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Terminal className="h-4 w-4" />
          mcpo Logs
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-muted-foreground'}`} />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleRestart} disabled={restarting}>
            {restarting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
            Reload
          </Button>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="h-64 overflow-y-auto font-mono text-xs p-3 space-y-0.5 bg-black/5 dark:bg-black/40"
      >
        {logs.length === 0 ? (
          <p className="text-muted-foreground italic">Waiting for logs…</p>
        ) : (
          logs.map((l, i) => (
            <div key={i} className="flex gap-2 leading-relaxed">
              <span className="text-muted-foreground/50 shrink-0 text-[10px]">
                {l.ts ? new Date(l.ts).toLocaleTimeString() : ''}
              </span>
              <span className={levelColor(l.level)}>{l.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Server edit form ──────────────────────────────────────────────────────────

function ServerEditForm({
  server,
  onUpdated,
  onCancel,
}: {
  server: McpServerItem;
  onUpdated: (s: McpServerItem) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description);
  const [configText, setConfigText] = useState(JSON.stringify(server.config, null, 2));
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [configError, setConfigError] = useState('');

  const handleSave = async () => {
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(configText);
      setConfigError('');
    } catch {
      setConfigError('Invalid JSON — please fix before saving');
      return;
    }
    setSaveState('saving');
    try {
      const updated = await updateMcpServer(server.id, {
        name,
        description,
        config: parsedConfig,
      });
      onUpdated(updated);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  };

  return (
    <CardContent className="pt-4 space-y-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-mono text-muted-foreground">{server.id}</span>
        {saveState === 'saving' && <span className="text-xs text-muted-foreground animate-pulse">Saving…</span>}
        {saveState === 'saved' && <span className="text-xs text-green-500">✓ Saved</span>}
        {saveState === 'error' && <span className="text-xs text-destructive">Failed</span>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Name</Label>
          <Input value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Description</Label>
          <Input value={description} onChange={e => setDescription(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label>mcpo Config Entry (JSON)</Label>
        <textarea
          value={configText}
          onChange={e => { setConfigText(e.target.value); setConfigError(''); }}
          className="w-full h-40 rounded-md border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
        {configError && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />{configError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          This is the value for this server's entry in the mcpo <code>mcpServers</code> config object.
          E.g. <code>{`{"command":"uvx","args":["mcp-server-time"]}`}</code>
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={saveState === 'saving'}>
          {saveState === 'saving' ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          <X className="h-3 w-3 mr-1" /> Done
        </Button>
      </div>
    </CardContent>
  );
}

// ── Manual add form ───────────────────────────────────────────────────────────

function AddServerManualForm({ onCreated }: { onCreated: (s: McpServerItem) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [configText, setConfigText] = useState('{\n  "command": "uvx",\n  "args": ["mcp-server-time"]\n}');
  const [creating, setCreating] = useState(false);
  const [configError, setConfigError] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(configText);
      setConfigError('');
    } catch {
      setConfigError('Invalid JSON');
      return;
    }
    setCreating(true);
    try {
      const server = await createMcpServer({
        name: name.trim(),
        description: description.trim(),
        config: parsedConfig,
      });
      onCreated(server);
      toast.success(`MCP server "${server.name}" added`);
      setName(''); setDescription(''); setConfigText('{}');
    } catch (err: any) {
      toast.error(err.message || 'Failed to create MCP server');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Name <span className="text-destructive">*</span></Label>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="github-mcp"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">Lowercase slug, e.g. github-mcp</p>
        </div>
        <div className="space-y-1">
          <Label>Description</Label>
          <Input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="GitHub MCP server"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label>mcpo Config Entry (JSON) <span className="text-destructive">*</span></Label>
        <textarea
          value={configText}
          onChange={e => { setConfigText(e.target.value); setConfigError(''); }}
          className="w-full h-36 rounded-md border bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
        {configError && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />{configError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          The mcpServers config entry for this server.{' '}
          <a
            href="https://github.com/open-webui/mcpo"
            target="_blank"
            rel="noopener noreferrer"
            className="underline inline-flex items-center gap-0.5"
          >
            mcpo docs <ExternalLink className="h-3 w-3" />
          </a>
        </p>
      </div>
      <Button onClick={handleCreate} disabled={creating || !name.trim()}>
        {creating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
        Add Server
      </Button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function McpPage() {
  const [servers, setServers] = useState<McpServerItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addTab, setAddTab] = useState<'ai' | 'manual'>('ai');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [accessPanelId, setAccessPanelId] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    Promise.all([fetchMcpServers(), fetchAgents()])
      .then(([s, a]) => { setServers(s); setAgents(a); })
      .catch(() => toast.error('Failed to load MCP data'))
      .finally(() => setLoading(false));
  }, []);

  const handleToggleEnabled = async (server: McpServerItem) => {
    try {
      const updated = await setMcpServerEnabled(server.id, !server.enabled);
      setServers(prev => prev.map(s => s.id === updated.id ? updated : s));
      toast.success(`"${server.name}" ${updated.enabled ? 'enabled' : 'disabled'}`);
    } catch { toast.error('Failed to toggle server'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete MCP server "${id}"? All agent access will be revoked.`)) return;
    try {
      await deleteMcpServer(id);
      setServers(prev => prev.filter(s => s.id !== id));
      toast.success(`Server "${id}" deleted`);
    } catch { toast.error('Failed to delete server'); }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await restartMcpo();
      toast.success('mcpo reload requested — check logs for status');
    } catch { toast.error('Failed to request reload'); }
    finally { setRestarting(false); }
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Puzzle className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">MCP Servers</h1>
            <p className="text-muted-foreground text-sm">Manage MCP tool integrations via mcpo.</p>
          </div>
        </div>
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 space-y-2">
                  <Skeleton width={160} height={16} />
                  <Skeleton width={240} height={14} />
                </div>
                <div className="flex gap-1.5">
                  <Skeleton width={28} height={28} />
                  <Skeleton width={28} height={28} />
                  <Skeleton width={28} height={28} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Puzzle className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">MCP Servers</h1>
            <p className="text-muted-foreground text-sm">
              Connect MCP tools via the mcpo proxy. Grant agents access via the{' '}
              <Users className="inline h-3.5 w-3.5 mx-0.5" /> button on each server.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowLogs(v => !v)}
          >
            <Terminal className="h-4 w-4 mr-2" />
            {showLogs ? 'Hide' : 'Logs'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRestart}
            disabled={restarting}
          >
            {restarting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Reload mcpo
          </Button>
          <Button
            size="sm"
            onClick={() => { setShowAdd(v => !v); }}
            variant={showAdd ? 'outline' : 'default'}
          >
            {showAdd ? <X className="h-4 w-4 mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
            {showAdd ? 'Cancel' : 'Add Server'}
          </Button>
        </div>
      </div>

      {/* Log panel */}
      {showLogs && <LogPanel onClose={() => setShowLogs(false)} />}

      {/* Add server form */}
      {showAdd && (
        <Card className="border-primary/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Add MCP Server</CardTitle>
            <CardDescription>
              Use AI-guided setup for the easiest experience, or configure manually.
            </CardDescription>
            <div className="flex items-center gap-1 rounded-lg border p-1 bg-muted/40 mt-2 w-fit">
              {([
                { id: 'ai', icon: Sparkles, label: 'AI Setup' },
                { id: 'manual', icon: Code2, label: 'Manual' },
              ] as const).map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  onClick={() => setAddTab(id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    addTab === id ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />{label}
                </button>
              ))}
            </div>
          </CardHeader>

          <CardContent>
            {addTab === 'ai' ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  An AI agent will research the MCP server, figure out the correct mcpo configuration,
                  ask you for any required secrets, and set everything up automatically.
                </p>
                <a href="/mcp/configure">
                  <Button>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Start AI Setup
                  </Button>
                </a>
              </div>
            ) : (
              <AddServerManualForm
                onCreated={server => {
                  setServers(prev => [...prev, server]);
                  setShowAdd(false);
                }}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Server list */}
      {servers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Puzzle className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No MCP servers configured yet.</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add your first server using AI Setup or manual configuration.
            </p>
            <Button className="mt-4" onClick={() => { setShowAdd(true); setAddTab('ai'); }}>
              <Sparkles className="h-4 w-4 mr-2" /> Add with AI
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {servers.map(server => (
            <div key={server.id}>
              <Card className={server.enabled ? '' : 'opacity-60'}>
                {editingId === server.id ? (
                  <ServerEditForm
                    server={server}
                    onUpdated={updated => setServers(prev => prev.map(s => s.id === updated.id ? updated : s))}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Puzzle className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="font-semibold text-sm">{server.name}</span>
                          <code className="font-mono text-xs text-muted-foreground">{server.id}</code>
                          <StatusBadge status={server.status} />
                          {!server.enabled && (
                            <Badge variant="outline" className="text-xs text-yellow-500 border-yellow-500/30">
                              Disabled
                            </Badge>
                          )}
                        </div>
                        {server.description && (
                          <p className="text-sm text-muted-foreground mt-1">{server.description}</p>
                        )}
                        {server.discovered_tools.length > 0 && (
                          <div className="flex gap-1 mt-2 flex-wrap">
                            {server.discovered_tools.slice(0, 8).map(tool => (
                              <Badge key={tool} variant="secondary" className="text-xs font-mono">
                                {tool}
                              </Badge>
                            ))}
                            {server.discovered_tools.length > 8 && (
                              <Badge variant="secondary" className="text-xs">
                                +{server.discovered_tools.length - 8} more
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Access management */}
                        <button
                          onClick={() => setAccessPanelId(accessPanelId === server.id ? null : server.id)}
                          title="Manage agent access"
                          className={`p-1.5 rounded hover:bg-muted transition-colors ${accessPanelId === server.id ? 'bg-primary/10 text-primary' : ''}`}
                        >
                          <Users className="h-4 w-4" />
                        </button>
                        {/* Enable/disable */}
                        <button
                          onClick={() => handleToggleEnabled(server)}
                          title={server.enabled ? 'Disable' : 'Enable'}
                          className="p-1.5 rounded hover:bg-muted transition-colors"
                        >
                          {server.enabled
                            ? <ToggleRight className="h-5 w-5 text-primary" />
                            : <ToggleLeft className="h-5 w-5 text-muted-foreground" />}
                        </button>
                        <button
                          onClick={() => { setEditingId(server.id); setAccessPanelId(null); }}
                          title="Edit"
                          className="p-1.5 rounded hover:bg-muted transition-colors"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(server.id)}
                          title="Delete"
                          className="p-1.5 rounded hover:bg-destructive/10 text-destructive transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </CardContent>
                )}
              </Card>

              {/* Access panel */}
              {accessPanelId === server.id && (
                <ToolAccessPanel
                  server={server}
                  agents={agents}
                  onClose={() => setAccessPanelId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
