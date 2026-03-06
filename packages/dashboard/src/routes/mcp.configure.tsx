import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ModelSelector } from '@/components/ui/ModelSelector';
import {
  ArrowLeft, Puzzle, Loader2, Send, Square, Bot, User,
  CheckCircle2, Save, Edit3,
  ChevronDown, ChevronUp, Key, Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useSSE } from '@/hooks/useSSE';
import {
  fetchAgents,
  startMcpConfigSession,
  sendChatMessage,
  stopChatResponse,
  endChatSession,
  extractMcpConfig,
  createMcpServer,
  createSecret,
  restartMcpo,
  type McpServerItem,
  type McpExtractResult,
  API_BASE,
} from '@/lib/api';
import { DEFAULT_CHAT_MODEL } from '@/lib/constants';

export const Route = createFileRoute('/mcp/configure')({
  component: McpConfigurePage,
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  emoji?: string | null;
}

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant' | 'thinking' | 'tool';
  content: string;
  toolName?: string;
}

interface SecretRequest {
  env_key: string;
  type: string;
  description: string;
  value?: string;
}

type SetupPhase =
  | 'input'      // user filling in the server name / URL
  | 'chatting'   // agent session in progress
  | 'secrets'    // waiting for user to provide secrets
  | 'reviewing'  // mcp-config-output block found, showing preview
  | 'saving'     // writing to DB + signalling engine
  | 'done';      // success

// ── Secret request detector ───────────────────────────────────────────────────

function parseSecretRequests(text: string): SecretRequest[] {
  // Pattern: [SECRET_REQUEST: ENV_KEY | type | description]
  const re = /\[SECRET_REQUEST:\s*([^|]+)\|([^|]+)\|([^\]]+)\]/g;
  const results: SecretRequest[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push({
      env_key: m[1].trim().toUpperCase(),
      type: m[2].trim(),
      description: m[3].trim(),
    });
  }
  return results;
}

// ── Inline chat message ───────────────────────────────────────────────────────

function ChatMessage({ msg }: { msg: ChatMsg }) {
  const [expanded, setExpanded] = useState(false);
  const isThinking = msg.role === 'thinking';
  const isTool = msg.role === 'tool';
  const isUser = msg.role === 'user';

  if (isThinking) {
    return (
      <div className="flex gap-2 items-start text-muted-foreground/70">
        <Sparkles className="h-3.5 w-3.5 mt-1 shrink-0 animate-pulse" />
        <div className="text-xs italic leading-relaxed max-w-full">
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 hover:text-muted-foreground"
          >
            Thinking {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {expanded && (
            <pre className="mt-1 whitespace-pre-wrap text-[11px] font-mono bg-muted/20 rounded p-2">
              {msg.content}
            </pre>
          )}
        </div>
      </div>
    );
  }

  if (isTool) {
    return (
      <div className="flex gap-2 items-center text-xs text-muted-foreground">
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
        <span className="font-mono">{msg.content}</span>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex gap-2 justify-end">
        <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-3.5 py-2 text-sm max-w-[80%]">
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        </div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted mt-0.5">
          <User className="h-3.5 w-3.5" />
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex gap-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 mt-0.5">
        <Bot className="h-3.5 w-3.5 text-primary" />
      </div>
      <div className="bg-muted/40 rounded-2xl rounded-tl-sm px-3.5 py-2 text-sm max-w-[85%]">
        <p className="whitespace-pre-wrap break-words">{msg.content}</p>
      </div>
    </div>
  );
}

// ── Secret collection form ────────────────────────────────────────────────────

function SecretCollector({
  secrets,
  onDone,
}: {
  secrets: SecretRequest[];
  onDone: (filled: SecretRequest[]) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(secrets.map(s => [s.env_key, s.value ?? '']))
  );

  const allFilled = secrets.every(s => (values[s.env_key] || '').trim().length > 0);

  return (
    <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium text-yellow-600 dark:text-yellow-400">
        <Key className="h-4 w-4" />
        Secrets Required
      </div>
      <p className="text-sm text-muted-foreground">
        The agent identified the following credentials. Enter them below — they'll be saved
        securely in your Djinnbot secrets store.
      </p>
      <div className="space-y-3">
        {secrets.map(s => (
          <div key={s.env_key} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label className="font-mono text-xs">{s.env_key}</Label>
              <Badge variant="outline" className="text-[10px] px-1">{s.type}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{s.description}</p>
            <Input
              type="password"
              placeholder={`Enter ${s.env_key}…`}
              value={values[s.env_key] || ''}
              onChange={e => setValues(prev => ({ ...prev, [s.env_key]: e.target.value }))}
              className="font-mono text-sm"
            />
          </div>
        ))}
      </div>
      <Button
        disabled={!allFilled}
        onClick={() => onDone(secrets.map(s => ({ ...s, value: values[s.env_key] || '' })))}
      >
        Continue
      </Button>
    </div>
  );
}

// ── Config review card ────────────────────────────────────────────────────────

function ConfigReview({
  config,
  onSave,
  onEdit,
  saving,
}: {
  config: NonNullable<McpExtractResult['config']>;
  onSave: () => void;
  onEdit: () => void;
  saving: boolean;
}) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-green-600 dark:text-green-400">
        <CheckCircle2 className="h-4 w-4" />
        Configuration Ready
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Server ID</p>
          <code className="font-mono font-medium">{config.id}</code>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Name</p>
          <p className="font-medium">{config.name}</p>
        </div>
        {config.description && (
          <div className="col-span-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Description</p>
            <p>{config.description}</p>
          </div>
        )}
      </div>

      <button
        onClick={() => setShowRaw(v => !v)}
        className="text-xs text-muted-foreground flex items-center gap-1 hover:text-foreground"
      >
        {showRaw ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {showRaw ? 'Hide' : 'Show'} raw config
      </button>
      {showRaw && (
        <pre className="text-xs font-mono bg-muted/30 rounded p-3 overflow-auto max-h-48">
          {JSON.stringify(config.config, null, 2)}
        </pre>
      )}

      <div className="flex gap-2 pt-1">
        <Button onClick={onSave} disabled={saving}>
          {saving
            ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            : <Save className="h-4 w-4 mr-2" />}
          {saving ? 'Saving…' : 'Save & Reload mcpo'}
        </Button>
        <Button variant="outline" onClick={onEdit}>
          <Edit3 className="h-4 w-4 mr-2" /> Edit
        </Button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function McpConfigurePage() {
  const navigate = useNavigate();

  // Agent + model selection
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [model, setModel] = useState(DEFAULT_CHAT_MODEL);

  // Input
  const [serverInput, setServerInput] = useState('');
  const [inputType, setInputType] = useState<'github' | 'npm' | 'pypi' | 'description' | 'url'>('description');

  // Session
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<'idle' | 'starting' | 'running' | 'stopping'>('idle');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isResponding, setIsResponding] = useState(false);

  // Phase management
  const [phase, setPhase] = useState<SetupPhase>('input');
  const [secretRequests, setSecretRequests] = useState<SecretRequest[]>([]);
  const [extractedConfig, setExtractedConfig] = useState<McpExtractResult['config'] | null>(null);
  const [savedServer, setSavedServer] = useState<McpServerItem | null>(null);
  const [saving, setSaving] = useState(false);

  const msgIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    if (agents.length > 0 && !selectedAgentId) setSelectedAgentId(agents[0].id);
  }, [agents]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const nextId = () => `m_${++msgIdRef.current}`;

  // ── SSE ─────────────────────────────────────────────────────────────────────

  const tryExtractConfig = useCallback(async (text: string) => {
    try {
      const result = await extractMcpConfig(text);
      if (result.found && result.config) {
        setExtractedConfig(result.config);
        setPhase('reviewing');
      }
    } catch {
      // silent
    }
  }, []);

  const handleSSEEvent = useCallback((event: any) => {
    if (!event || event.type === 'heartbeat' || event.type === 'connected') return;
    const data = event.data || {};

    if (event.type === 'output') {
      const chunk = data.content || data.stream || '';
      if (!chunk) return;

      setMessages(prev => {
        const last = prev[prev.length - 1];
        const newMsg = last?.role === 'assistant'
          ? [...prev.slice(0, -1), { ...last, content: last.content + chunk }]
          : [...prev, { id: nextId(), role: 'assistant' as const, content: chunk }];
        return newMsg;
      });
    } else if (event.type === 'thinking') {
      const chunk = data.thinking || '';
      if (!chunk) return;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        return last?.role === 'thinking'
          ? [...prev.slice(0, -1), { ...last, content: last.content + chunk }]
          : [...prev, { id: nextId(), role: 'thinking' as const, content: chunk }];
      });
    } else if (event.type === 'tool_start') {
      const name = data.toolName || data.tool_name || 'tool';
      setMessages(prev => [...prev, { id: nextId(), role: 'tool' as const, content: `Using ${name}…`, toolName: name }]);
    } else if (event.type === 'tool_end') {
      const name = data.toolName || data.tool_name || 'tool';
      const ok = data.success !== false;
      setMessages(prev => {
        const idx = [...prev].reverse().findIndex(m => m.role === 'tool' && m.toolName === name);
        if (idx === -1) return prev;
        const ri = prev.length - 1 - idx;
        return [...prev.slice(0, ri), { ...prev[ri], content: ok ? `${name} done` : `${name} failed` }, ...prev.slice(ri + 1)];
      });
    } else if (event.type === 'turn_end' || event.type === 'step_end') {
      setIsResponding(false);
      // Check for config output or secret requests in latest assistant message
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'assistant') {
        // Check for secret requests
        const reqs = parseSecretRequests(lastMsg.content);
        if (reqs.length > 0 && phase === 'chatting') {
          setSecretRequests(reqs);
          setPhase('secrets');
        }
        // Try extracting config
        tryExtractConfig(lastMsg.content);
      }
    } else if (event.type === 'session_complete' || event.type === 'container_exiting') {
      setSessionStatus('idle');
      setIsResponding(false);
    }
  }, [messages, phase, tryExtractConfig]);

  const sseUrl = sessionId ? `${API_BASE}/sessions/${sessionId}/events` : '';
  useSSE({
    url: sseUrl,
    onMessage: handleSSEEvent,
    enabled: !!sessionId && sessionStatus === 'running',
  });

  // ── Start session ────────────────────────────────────────────────────────────

  const handleStart = async () => {
    if (!selectedAgentId) { toast.error('Select an agent first'); return; }
    if (!serverInput.trim()) { toast.error('Enter an MCP server name or URL'); return; }

    setSessionStatus('starting');
    setMessages([]);
    setPhase('chatting');
    setExtractedConfig(null);
    setSecretRequests([]);

    try {
      const result = await startMcpConfigSession({
        agent_id: selectedAgentId,
        model,
        input: serverInput.trim(),
        input_type: inputType,
      });
      setSessionId(result.session_id);
      setSessionStatus('running');

      setTimeout(async () => {
        try {
          await sendChatMessage(selectedAgentId, result.session_id, result.initial_message);
          setIsResponding(true);
          setMessages([{ id: nextId(), role: 'user', content: result.initial_message }]);
        } catch (err: any) {
          toast.error(`Failed to send initial message: ${err.message}`);
        }
      }, 2000);
    } catch (err: any) {
      setSessionStatus('idle');
      setPhase('input');
      toast.error(err.message || 'Failed to start session');
    }
  };

  // ── Send / Stop ──────────────────────────────────────────────────────────────

  const handleSend = async () => {
    if (!inputValue.trim() || !sessionId || isResponding) return;
    const text = inputValue.trim();
    setInputValue('');
    setIsResponding(true);
    setMessages(prev => [...prev, { id: nextId(), role: 'user', content: text }]);
    try {
      await sendChatMessage(selectedAgentId, sessionId, text, undefined, model);
    } catch (err: any) {
      setIsResponding(false);
      toast.error(err.message || 'Failed to send message');
    }
  };

  const handleStop = async () => {
    if (!sessionId) return;
    try {
      await stopChatResponse(selectedAgentId, sessionId);
      setIsResponding(false);
    } catch {}
  };

  // ── Secrets collected ────────────────────────────────────────────────────────

  const handleSecretsDone = async (filled: SecretRequest[]) => {
    // filled secrets are saved below
    setPhase('chatting');

    // Save secrets to DB
    const saved: string[] = [];
    for (const s of filled) {
      if (!s.value) continue;
      try {
        await createSecret({
          name: s.env_key,
          description: s.description,
          secret_type: 'env_var',
          env_key: s.env_key,
          value: s.value,
        });
        saved.push(s.env_key);
      } catch {
        // May already exist — non-fatal
      }
    }

    // Tell the agent the secrets are ready
    const ackMessage = filled.length > 0
      ? `I've provided the required secrets: ${filled.map(s => s.env_key).join(', ')}. They are now saved. Please proceed with generating the final configuration.`
      : `No additional secrets needed. Please proceed with generating the final configuration.`;

    if (sessionId) {
      try {
        setIsResponding(true);
        setMessages(prev => [...prev, { id: nextId(), role: 'user', content: ackMessage }]);
        await sendChatMessage(selectedAgentId, sessionId, ackMessage, undefined, model);
      } catch (err: any) {
        toast.error(`Failed to send: ${err.message}`);
      }
    }
  };

  // ── Save config ───────────────────────────────────────────────────────────────

  const handleSaveConfig = async () => {
    if (!extractedConfig) return;
    setSaving(true);
    setPhase('saving');
    try {
      const server = await createMcpServer({
        name: extractedConfig.name,
        description: extractedConfig.description ?? '',
        config: extractedConfig.config,
        enabled: true,
      });
      setSavedServer(server);

      // Signal engine to reload mcpo
      await restartMcpo();

      // End the chat session
      if (sessionId) {
        endChatSession(selectedAgentId, sessionId).catch(() => {});
        setSessionId(null);
        setSessionStatus('idle');
      }

      setPhase('done');
      toast.success(`MCP server "${server.name}" saved. mcpo reloading…`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to save MCP server');
      setPhase('reviewing');
    } finally {
      setSaving(false);
    }
  };

  // ── Input detection ──────────────────────────────────────────────────────────

  const detectInputType = (val: string): typeof inputType => {
    if (/github\.com\//i.test(val)) return 'github';
    if (/^https?:\/\//i.test(val)) return 'url';
    if (/^npm:/i.test(val) || /^@/.test(val)) return 'npm';
    if (/^pypi:/i.test(val)) return 'pypi';
    return 'description';
  };

  const handleInputChange = (val: string) => {
    setServerInput(val);
    setInputType(detectInputType(val));
  };

  const inputTypeLabels: Record<typeof inputType, string> = {
    github: 'GitHub URL',
    url: 'URL',
    npm: 'npm package',
    pypi: 'PyPI package',
    description: 'Description',
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 md:px-6 py-3 border-b bg-card shrink-0">
        <button
                  onClick={() => navigate({ to: '/mcp' })}

          className="p-1.5 rounded hover:bg-muted text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <Puzzle className="h-5 w-5 text-primary" />
        <h1 className="text-base font-semibold">AI MCP Setup</h1>
        <span className="text-sm text-muted-foreground hidden md:block">
          — Configure an MCP server with AI guidance
        </span>
        {phase !== 'input' && phase !== 'done' && (
          <Badge variant="outline" className="ml-auto text-xs">
            {phase === 'chatting' ? 'In Session' : phase === 'secrets' ? 'Awaiting Secrets' : phase === 'reviewing' ? 'Review Config' : 'Saving…'}
          </Badge>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {/* ── Input phase ── */}
        {phase === 'input' && (
          <div className="max-w-2xl mx-auto p-6 space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Which MCP server do you want to add?</h2>
              <p className="text-sm text-muted-foreground">
                Paste a GitHub URL, npm package name, PyPI package, or just describe it in plain text.
                The AI agent will research and configure it for you.
              </p>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="relative">
                  <Input
                    value={serverInput}
                    onChange={e => handleInputChange(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) handleStart(); }}
                    placeholder="e.g. github.com/modelcontextprotocol/servers, @modelcontextprotocol/server-github, mcp-server-time…"
                    className="pr-24 text-sm"
                    autoFocus
                  />
                  {serverInput.trim() && (
                    <Badge
                      variant="secondary"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] pointer-events-none"
                    >
                      {inputTypeLabels[inputType]}
                    </Badge>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Agent</Label>
                  <select
                    value={selectedAgentId}
                    onChange={e => setSelectedAgentId(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {agents.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.emoji ? `${a.emoji} ` : ''}{a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Model</Label>
                  <ModelSelector value={model} onChange={setModel} className="w-full" />
                </div>
              </div>

              <Button
                onClick={handleStart}
                disabled={!serverInput.trim() || !selectedAgentId || sessionStatus === 'starting'}
                className="w-full"
              >
                {sessionStatus === 'starting'
                  ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  : <Sparkles className="h-4 w-4 mr-2" />}
                {sessionStatus === 'starting' ? 'Starting…' : 'Start AI Setup'}
              </Button>
            </div>

            {/* Examples */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Examples</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[
                  { label: 'GitHub MCP', value: 'github.com/modelcontextprotocol/servers' },
                  { label: 'Time server', value: 'mcp-server-time (PyPI)' },
                  { label: 'Memory server', value: '@modelcontextprotocol/server-memory' },
                  { label: 'Web search', value: 'Brave search MCP server' },
                ].map(ex => (
                  <button
                    key={ex.value}
                    onClick={() => handleInputChange(ex.value)}
                    className="text-left px-3 py-2 rounded-md border text-sm hover:bg-muted transition-colors"
                  >
                    <p className="font-medium">{ex.label}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">{ex.value}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Chat + review phase ── */}
        {phase !== 'input' && phase !== 'done' && (
          <div className="flex flex-col h-full max-w-3xl mx-auto w-full">
            {/* Session header */}
            <div className="px-4 py-2 border-b bg-muted/20 shrink-0 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Setting up:</span>
                <code className="font-mono font-medium">{serverInput}</code>
                <Badge variant="secondary" className="text-[10px]">{inputTypeLabels[inputType]}</Badge>
              </div>
              <div className="flex items-center gap-2">
                {isResponding && (
                  <span className="text-xs text-muted-foreground animate-pulse">Thinking…</span>
                )}
                {sessionId && (
                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={handleStop}>
                    <Square className="h-3 w-3 mr-1" /> Stop
                  </Button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
              {messages.map(msg => (
                <ChatMessage key={msg.id} msg={msg} />
              ))}
              {isResponding && messages[messages.length - 1]?.role !== 'thinking' && (
                <div className="flex gap-2">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <Bot className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="bg-muted/40 rounded-2xl rounded-tl-sm px-3.5 py-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                </div>
              )}
            </div>

            {/* Secret collection */}
            {phase === 'secrets' && secretRequests.length > 0 && (
              <div className="px-4 pb-4 shrink-0">
                <SecretCollector
                  secrets={secretRequests}
                  onDone={handleSecretsDone}
                />
              </div>
            )}

            {/* Config review */}
            {phase === 'reviewing' && extractedConfig && (
              <div className="px-4 pb-4 shrink-0">
                <ConfigReview
                  config={extractedConfig}
                  onSave={handleSaveConfig}
                  onEdit={() => setPhase('chatting')}
                  saving={saving}
                />
              </div>
            )}

            {/* Input area */}
            {(phase === 'chatting' || phase === 'saving') && (
              <div className="px-4 pb-4 shrink-0 border-t pt-3">
                <div className="flex gap-2 items-end">
                  <textarea
                    ref={inputRef}
                    value={inputValue}
                    onChange={e => setInputValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder="Reply to the agent… (Enter to send)"
                    rows={1}
                    className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none min-h-[2.5rem] max-h-40"
                    disabled={isResponding || !sessionId}
                  />
                  <Button
                    size="sm"
                    onClick={isResponding ? handleStop : handleSend}
                    disabled={!sessionId}
                    className="shrink-0"
                  >
                    {isResponding
                      ? <Square className="h-4 w-4" />
                      : <Send className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Done phase ── */}
        {phase === 'done' && savedServer && (
          <div className="max-w-2xl mx-auto p-6 space-y-6">
            <div className="flex flex-col items-center text-center gap-4 py-8">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
                <CheckCircle2 className="h-8 w-8 text-green-500" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">MCP Server Added!</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  <span className="font-medium">{savedServer.name}</span> has been saved and mcpo is reloading.
                  Once the status shows{' '}
                  <span className="text-green-500 font-medium">Running</span>, the tools will be available.
                </p>
              </div>
              <div className="space-y-2 w-full max-w-sm">
                <p className="text-sm text-muted-foreground">
                  Go to the MCP page to grant agents access to the tools.
                </p>
                <Button
                  className="w-full"
          onClick={() => navigate({ to: '/mcp' })}

                >
                  <Puzzle className="h-4 w-4 mr-2" />
                  Go to MCP Servers
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setPhase('input');
                    setServerInput('');
                    setMessages([]);
                    setSavedServer(null);
                    setExtractedConfig(null);
                  }}
                >
                  Add Another Server
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
