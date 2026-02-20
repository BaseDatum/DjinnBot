import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ModelSelector } from '@/components/ui/ModelSelector';
import {
  ArrowLeft,
  Zap,
  MessageSquare,
  Loader2,
  Check,
  AlertTriangle,
  Send,
  Square,
  Bot,
  User,
  RefreshCw,
  Save,
  Eye,
  Edit3,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { toast } from 'sonner';
import { useSSE } from '@/hooks/useSSE';
import {
  fetchAgents,
  startSkillGenSession,
  sendChatMessage,
  stopChatResponse,
  endChatSession,
  extractSkillFromOutput,
  createSkill,
  createAgentSkill,
  grantSkillToAgent,
  type ExtractSkillResult,
  type Skill,
  API_BASE,
} from '@/lib/api';
import { DEFAULT_CHAT_MODEL } from '@/lib/constants';

export const Route = createFileRoute('/skills/generate')({
  component: SkillGeneratePage,
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

interface SkillDraft {
  content: string;
  name: string;
  description: string;
  tags: string[];
  name_conflict: boolean;
  valid: boolean;
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSkillRaw(draft: SkillDraft): string {
  const tags = draft.tags.length ? `[${draft.tags.join(', ')}]` : `[${draft.name}]`;
  const fm = `---\nname: ${draft.name}\ndescription: ${draft.description}\ntags: ${tags}\nenabled: true\n---\n\n`;
  const body = draft.content.replace(/^---[\s\S]*?---\n*/, '').trim();
  return fm + body;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// ── Main page ─────────────────────────────────────────────────────────────────

function SkillGeneratePage() {
  const navigate = useNavigate();

  // Agent + model selection
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [model, setModel] = useState(DEFAULT_CHAT_MODEL);

  // Session state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<'idle' | 'starting' | 'running' | 'stopping'>('idle');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isResponding, setIsResponding] = useState(false);

  // Initial context (shown in start form)
  const [chatPrompt, setChatPrompt] = useState('');

  // Scope
  const [scope, setScope] = useState<'global' | 'agent'>('global');
  const [targetAgentId, setTargetAgentId] = useState('');

  // Extracted skill draft (inline, below chat)
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [reviewMode, setReviewMode] = useState<'preview' | 'edit'>('preview');
  const [saving, setSaving] = useState(false);
  const [extractPending, setExtractPending] = useState(false);

  // Start form collapsed when session is running
  const [startFormCollapsed, setStartFormCollapsed] = useState(false);

  const msgIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load agents
  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => {});
  }, []);

  // Auto-select first agent
  useEffect(() => {
    if (agents.length > 0 && !selectedAgentId) {
      setSelectedAgentId(agents[0].id);
    }
  }, [agents]);

  // Auto-scroll messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const nextId = () => `m_${++msgIdRef.current}`;

  // ── SSE ─────────────────────────────────────────────────────────────────────

  const handleSSEEvent = useCallback((event: any) => {
    if (!event || event.type === 'heartbeat' || event.type === 'connected') return;
    const data = event.data || {};

    if (event.type === 'output') {
      const chunk = data.content || data.stream || '';
      if (!chunk) return;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
        }
        return [...prev, { id: nextId(), role: 'assistant', content: chunk }];
      });
    } else if (event.type === 'thinking') {
      const chunk = data.thinking || '';
      if (!chunk) return;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'thinking') {
          return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
        }
        return [...prev, { id: nextId(), role: 'thinking', content: chunk }];
      });
    } else if (event.type === 'tool_start') {
      const name = data.toolName || data.tool_name || 'tool';
      setMessages(prev => [...prev, {
        id: nextId(), role: 'tool', content: `Using ${name}...`, toolName: name,
      }]);
    } else if (event.type === 'tool_end') {
      const name = data.toolName || data.tool_name || 'tool';
      const ok = data.success !== false;
      setMessages(prev => {
        const idx = [...prev].reverse().findIndex(m => m.role === 'tool' && m.toolName === name);
        if (idx === -1) return prev;
        const realIdx = prev.length - 1 - idx;
        const updated = { ...prev[realIdx], content: ok ? `${name} done` : `${name} failed` };
        return [...prev.slice(0, realIdx), updated, ...prev.slice(realIdx + 1)];
      });
    } else if (event.type === 'turn_end' || event.type === 'step_end') {
      setIsResponding(false);
      tryExtractSkill();
    } else if (event.type === 'session_complete' || event.type === 'container_exiting') {
      setSessionStatus('idle');
      setIsResponding(false);
    }
  }, []);

  const sseUrl = sessionId ? `${API_BASE}/sessions/${sessionId}/events` : '';
  useSSE({
    url: sseUrl,
    onMessage: handleSSEEvent,
    enabled: !!sessionId && sessionStatus === 'running',
  });

  // ── Extract skill ────────────────────────────────────────────────────────────

  const tryExtractSkill = useCallback(async () => {
    if (extractPending) return;
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant || !lastAssistant.content) return;

    setExtractPending(true);
    try {
      const result: ExtractSkillResult = await extractSkillFromOutput(lastAssistant.content);
      if (result.found) {
        setDraft({
          content: result.content,
          name: result.name,
          description: result.description,
          tags: result.tags,
          name_conflict: result.name_conflict,
          valid: result.valid,
          error: result.error,
        });
        setReviewMode('preview');
      }
    } catch {
      // Silent — agent might not have produced a skill yet
    } finally {
      setExtractPending(false);
    }
  }, [messages, extractPending]);

  const handleExtractNow = () => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) {
      toast.error('No agent response to extract from yet');
      return;
    }
    extractSkillFromOutput(lastAssistant.content).then(result => {
      if (result.found) {
        setDraft({
          content: result.content,
          name: result.name,
          description: result.description,
          tags: result.tags,
          name_conflict: result.name_conflict,
          valid: result.valid,
          error: result.error,
        });
        setReviewMode('preview');
        toast.success('Skill extracted from agent output');
      } else {
        toast.error(result.error || 'No skill-output block found yet — ask the agent to finalize the skill');
      }
    }).catch(() => toast.error('Extraction failed'));
  };

  // ── Session start ────────────────────────────────────────────────────────────

  const handleStartSession = async () => {
    if (!selectedAgentId) { toast.error('Select an agent first'); return; }

    setSessionStatus('starting');
    setMessages([]);
    setDraft(null);
    setStartFormCollapsed(true);

    try {
      const result = await startSkillGenSession({
        agent_id: selectedAgentId,
        model,
        prompt: chatPrompt || undefined,
        scope,
        target_agent_id: targetAgentId || undefined,
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
      setStartFormCollapsed(false);
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

  const handleEndSession = async () => {
    if (!sessionId) return;
    setSessionStatus('stopping');
    try {
      await endChatSession(selectedAgentId, sessionId);
    } catch {}
    setSessionId(null);
    setSessionStatus('idle');
  };

  // ── Saved skill state (for grant step) ──────────────────────────────────────

  const [savedSkill, setSavedSkill] = useState<Skill | null>(null);
  const [grantingAgents, setGrantingAgents] = useState<Set<string>>(new Set());

  const handleGrantAfterSave = async (agentId: string) => {
    if (!savedSkill) return;
    setGrantingAgents(prev => new Set(prev).add(agentId));
    try {
      await grantSkillToAgent(agentId, savedSkill.id);
      toast.success(`Granted "${savedSkill.id}" to ${agentId}`);
    } catch {
      toast.error(`Failed to grant skill to ${agentId}`);
    } finally {
      setGrantingAgents(prev => { const s = new Set(prev); s.delete(agentId); return s; });
    }
  };

  // ── Save ────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    const raw = buildSkillRaw(draft);
    try {
      let saved: Skill;
      if (scope === 'agent' && targetAgentId) {
        saved = await createAgentSkill(targetAgentId, {
          name: draft.name,
          description: draft.description,
          tags: draft.tags,
          content: raw.replace(/^---[\s\S]*?---\n*/, '').trim(),
        });
        toast.success(`Agent skill "${saved.id}" saved — ${targetAgentId} has access.`);
        // Agent-specific: auto-granted, navigate immediately
        if (sessionId) {
          endChatSession(selectedAgentId, sessionId).catch(() => {});
          setSessionId(null);
          setSessionStatus('idle');
        }
        navigate({ to: '/skills' });
      } else {
        saved = await createSkill({
          name: draft.name,
          description: draft.description,
          tags: draft.tags,
          content: raw.replace(/^---[\s\S]*?---\n*/, '').trim(),
        });
        // End session but don't navigate yet — show grant step
        if (sessionId) {
          endChatSession(selectedAgentId, sessionId).catch(() => {});
          setSessionId(null);
          setSessionStatus('idle');
        }
        setSavedSkill(saved);
        toast.success(`Skill "${saved.id}" saved. Grant agents access below.`);
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const agent = agents.find(a => a.id === selectedAgentId);
  const sessionActive = sessionStatus === 'running' || sessionStatus === 'starting';

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <div className="border-b shrink-0">
        <div className="max-w-5xl mx-auto px-4 md:px-6 py-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/skills' })}>
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            <span className="hidden sm:inline">Skills</span>
          </Button>
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            <h1 className="text-base md:text-lg font-semibold">Generate Skill</h1>
          </div>
        </div>
      </div>

      {/* Main content — constrained width */}
      <div className="max-w-5xl mx-auto w-full px-4 md:px-6 py-6 space-y-4 flex-1">

        {/* ── Start form (collapsible once session starts) ── */}
        <div className="rounded-lg border bg-card">
          {/* Form header — always visible, clickable to expand/collapse when session active */}
          <div
            className={`flex items-center gap-3 px-4 py-3 ${sessionActive ? 'cursor-pointer hover:bg-muted/30 transition-colors' : ''}`}
            onClick={() => sessionActive && setStartFormCollapsed(v => !v)}
          >
            <MessageSquare className="h-4 w-4 text-primary shrink-0" />
            <span className="font-medium text-sm flex-1">
              {sessionActive
                ? (agent?.emoji ? `${agent.emoji} ` : '') + (agent?.name ?? selectedAgentId)
                : 'Agent Session'}
            </span>
            {sessionStatus === 'running' && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <code>{model.split('/').pop()}</code>
              </div>
            )}
            {sessionStatus === 'starting' && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Starting...
              </div>
            )}
            {sessionActive && (
              <>{startFormCollapsed
                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
              </>
            )}
          </div>

          {/* Form body */}
          {!startFormCollapsed && (
            <div className="px-4 pb-4 border-t space-y-4 pt-4">
              {/* Agent + Model on same row */}
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1 space-y-1.5">
                  <Label className="text-xs">Agent</Label>
                  <Select value={selectedAgentId} onValueChange={setSelectedAgentId} disabled={sessionActive}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Pick an agent..." />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map(a => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.emoji ? `${a.emoji} ` : ''}{a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1 space-y-1.5">
                  <Label className="text-xs">Model</Label>
                  <ModelSelector value={model} onChange={setModel} />
                </div>
              </div>

              {!sessionActive && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Describe the skill to build</Label>
                    <Textarea
                      value={chatPrompt}
                      onChange={e => setChatPrompt(e.target.value)}
                      placeholder="Build a skill for interacting with the Stripe Refunds API. The agent should know how to create full and partial refunds..."
                      className="min-h-[80px] text-sm resize-none"
                    />
                  </div>
                  <ScopeSelector
                    scope={scope}
                    setScope={setScope}
                    targetAgentId={targetAgentId}
                    setTargetAgentId={setTargetAgentId}
                    agents={agents}
                  />
                  <Button
                    onClick={handleStartSession}
                    disabled={!selectedAgentId}
                    className="w-full"
                  >
                    <MessageSquare className="h-4 w-4 mr-2" />
                    Start Agent Session
                  </Button>
                </>
              )}

              {sessionActive && (
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleExtractNow} disabled={extractPending}>
                    {extractPending
                      ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      : <RefreshCw className="h-3 w-3 mr-1" />}
                    Extract Skill
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={handleEndSession}>
                    End Session
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Session action bar when collapsed */}
          {startFormCollapsed && sessionActive && (
            <div className="px-4 pb-3 flex gap-2 border-t pt-2">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleExtractNow} disabled={extractPending}>
                {extractPending
                  ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  : <RefreshCw className="h-3 w-3 mr-1" />}
                Extract Skill
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={handleEndSession}>
                End Session
              </Button>
            </div>
          )}
        </div>

        {/* ── Chat messages ── */}
        {(sessionStatus === 'running' || messages.length > 0) && (
          <div className="rounded-lg border bg-card">
            <div ref={scrollRef as any} className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
              {messages.map(msg => (
                <ChatBubble key={msg.id} msg={msg} />
              ))}
              {isResponding && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="flex items-center gap-2 text-muted-foreground text-sm pl-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking...
                </div>
              )}
            </div>

            {/* Input bar */}
            {sessionStatus === 'running' && (
              <div className="px-4 py-3 border-t">
                <div className="flex gap-2">
                  <Textarea
                    ref={inputRef}
                    value={inputValue}
                    onChange={e => setInputValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder="Give feedback, ask for changes, or say 'finalize the skill'..."
                    className="min-h-[60px] max-h-[160px] resize-none text-sm"
                    disabled={isResponding}
                  />
                  {isResponding ? (
                    <Button size="sm" variant="outline" onClick={handleStop} className="self-end h-9">
                      <Square className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <Button size="sm" onClick={handleSend} disabled={!inputValue.trim()} className="self-end h-9">
                      <Send className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Inline skill save panel (appears when skill is extracted) ── */}
        {draft && !savedSkill && (
          <SkillSavePanel
            draft={draft}
            setDraft={setDraft}
            reviewMode={reviewMode}
            setReviewMode={setReviewMode}
            saving={saving}
            onSave={handleSave}
            onDiscard={() => setDraft(null)}
          />
        )}

        {/* ── Grant access panel (appears after a global skill is saved) ── */}
        {savedSkill && (
          <div className="rounded-lg border bg-card">
            <div className="px-4 py-3 border-b flex items-center gap-2">
              <Check className="h-4 w-4 text-green-500" />
              <span className="font-medium text-sm">Skill saved — grant agent access</span>
              <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded ml-1">{savedSkill.id}</code>
              <div className="flex-1" />
              <Button size="sm" variant="outline" onClick={() => navigate({ to: '/skills' })}>
                Done
              </Button>
            </div>
            <div className="px-4 py-3 space-y-1.5">
              <p className="text-xs text-muted-foreground mb-3">
                The skill is in the library but not yet granted to any agent. Click Grant to add it to an agent's manifest.
              </p>
              {agents.map(a => (
                <div key={a.id} className="flex items-center justify-between py-1">
                  <div className="flex items-center gap-2 text-sm">
                    {a.emoji && <span>{a.emoji}</span>}
                    <span className="font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">{a.id}</span>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    disabled={grantingAgents.has(a.id)}
                    onClick={() => handleGrantAfterSave(a.id)}
                  >
                    {grantingAgents.has(a.id)
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : 'Grant'}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Chat bubble ───────────────────────────────────────────────────────────────

function ChatBubble({ msg }: { msg: ChatMsg }) {
  if (msg.role === 'thinking') {
    return (
      <div className="flex gap-2 opacity-60">
        <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="text-xs text-muted-foreground italic bg-muted/40 rounded-md px-3 py-2 max-w-[85%] whitespace-pre-wrap leading-relaxed">
          {msg.content}
        </div>
      </div>
    );
  }
  if (msg.role === 'tool') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground pl-8">
        <div className="w-1.5 h-1.5 rounded-full bg-primary/60" />
        {msg.content}
      </div>
    );
  }
  if (msg.role === 'user') {
    return (
      <div className="flex gap-2 justify-end">
        <div className="bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap leading-relaxed">
          {msg.content}
        </div>
        <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
          <User className="h-3.5 w-3.5 text-primary" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
        <Bot className="h-3.5 w-3.5 text-foreground" />
      </div>
      <div className="text-sm max-w-[85%] whitespace-pre-wrap leading-relaxed bg-muted/30 rounded-lg px-3 py-2">
        {msg.content}
      </div>
    </div>
  );
}

// ── Scope selector ────────────────────────────────────────────────────────────

function ScopeSelector({
  scope,
  setScope,
  targetAgentId,
  setTargetAgentId,
  agents,
}: {
  scope: 'global' | 'agent';
  setScope: (s: 'global' | 'agent') => void;
  targetAgentId: string;
  setTargetAgentId: (s: string) => void;
  agents: { id: string; name: string; emoji?: string | null }[];
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs">Save as</Label>
      <div className="flex gap-2">
        <button
          onClick={() => setScope('global')}
          className={`flex-1 rounded-md border px-3 py-2 text-sm text-left transition-colors ${
            scope === 'global' ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:border-muted-foreground'
          }`}
        >
          <div className="font-medium text-xs">Global skill</div>
          <div className="text-[10px] text-muted-foreground">Available to all agents</div>
        </button>
        <button
          onClick={() => setScope('agent')}
          className={`flex-1 rounded-md border px-3 py-2 text-sm text-left transition-colors ${
            scope === 'agent' ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:border-muted-foreground'
          }`}
        >
          <div className="font-medium text-xs">Agent-specific skill</div>
          <div className="text-[10px] text-muted-foreground">Only for one agent</div>
        </button>
      </div>
      {scope === 'agent' && (
        <Select value={targetAgentId} onValueChange={setTargetAgentId}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="Select target agent..." />
          </SelectTrigger>
          <SelectContent>
            {agents.map(a => (
              <SelectItem key={a.id} value={a.id}>
                {a.emoji ? `${a.emoji} ` : ''}{a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

// ── Inline skill save panel ────────────────────────────────────────────────────

function SkillSavePanel({
  draft,
  setDraft,
  reviewMode,
  setReviewMode,
  saving,
  onSave,
  onDiscard,
}: {
  draft: SkillDraft;
  setDraft: (d: SkillDraft) => void;
  reviewMode: 'preview' | 'edit';
  setReviewMode: (m: 'preview' | 'edit') => void;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const [editRaw, setEditRaw] = useState(buildSkillRaw(draft));

  useEffect(() => {
    setEditRaw(buildSkillRaw(draft));
  }, [draft.name, draft.description]);

  const handleApplyEdit = () => {
    const fmMatch = editRaw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!fmMatch) { toast.error('Invalid frontmatter — must start with ---'); return; }
    const fm: Record<string, any> = {};
    for (const line of fmMatch[1].split('\n')) {
      const ci = line.indexOf(':');
      if (ci === -1) continue;
      const k = line.slice(0, ci).trim();
      const v = line.slice(ci + 1).trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        fm[k] = v.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      } else {
        fm[k] = v.replace(/^['"]|['"]$/g, '');
      }
    }
    setDraft({
      ...draft,
      content: editRaw,
      name: typeof fm.name === 'string' ? slugify(fm.name) : draft.name,
      description: typeof fm.description === 'string' ? fm.description : draft.description,
      tags: Array.isArray(fm.tags) ? fm.tags : draft.tags,
    });
    setReviewMode('preview');
    toast.success('Changes applied');
  };

  const body = draft.content.replace(/^---[\s\S]*?---\n*/, '').trim();

  return (
    <div className="rounded-lg border bg-card">
      {/* Panel header */}
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <Zap className="h-4 w-4 text-primary" />
        <span className="font-medium text-sm">Skill Ready to Save</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1 rounded-md border p-0.5 bg-muted/40">
          <button
            onClick={() => setReviewMode('preview')}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${reviewMode === 'preview' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
          >
            <Eye className="h-3 w-3 inline mr-1" />Preview
          </button>
          <button
            onClick={() => setReviewMode('edit')}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${reviewMode === 'edit' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
          >
            <Edit3 className="h-3 w-3 inline mr-1" />Edit
          </button>
        </div>
      </div>

      {/* Validation banners */}
      {!draft.valid && draft.error && (
        <div className="flex items-start gap-2 mx-4 mt-3 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{draft.error}</span>
        </div>
      )}
      {draft.name_conflict && (
        <div className="flex items-start gap-2 mx-4 mt-3 p-3 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-600 dark:text-yellow-400">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>A skill named <code className="font-mono">{draft.name}</code> already exists. Saving will overwrite it.</span>
        </div>
      )}

      {/* Preview mode */}
      {reviewMode === 'preview' && (
        <div className="px-4 pt-4 pb-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: slugify(e.target.value) })}
                className="font-mono h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Tags</Label>
              <Input
                value={draft.tags.join(', ')}
                onChange={e => setDraft({
                  ...draft,
                  tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean),
                })}
                className="h-8 text-sm"
                placeholder="tag1, tag2, tag3"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Description</Label>
            <Input
              value={draft.description}
              onChange={e => setDraft({ ...draft, description: e.target.value })}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Content preview</Label>
            <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed bg-muted/30 rounded-md p-3 max-h-48 overflow-y-auto">
              {body}
            </pre>
          </div>
        </div>
      )}

      {/* Edit mode */}
      {reviewMode === 'edit' && (
        <div className="px-4 pt-4 pb-3 space-y-3">
          <Textarea
            value={editRaw}
            onChange={e => setEditRaw(e.target.value)}
            className="font-mono text-xs resize-none min-h-[200px]"
          />
          <Button size="sm" variant="secondary" onClick={handleApplyEdit} className="self-end">
            <Check className="h-3.5 w-3.5 mr-1.5" />
            Apply Changes
          </Button>
        </div>
      )}

      {/* Footer actions */}
      <div className="px-4 py-3 border-t flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onDiscard} className="text-muted-foreground">
          Discard
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          onClick={onSave}
          disabled={saving || !draft.valid}
        >
          {saving
            ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            : <Save className="h-3.5 w-3.5 mr-1.5" />}
          Save Skill
        </Button>
      </div>
    </div>
  );
}
