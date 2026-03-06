import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  Trash2,
  Plus,
  Bot,
  Shield,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE as ROOT_API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';

// ── API helpers ──────────────────────────────────────────────────────────────

const API_BASE = `${ROOT_API_BASE}/telegram`;

interface TelegramConfig {
  agentId: string;
  enabled: boolean;
  botToken: string | null;
  botUsername: string | null;
  allowAll: boolean;
  updatedAt: number;
}

interface AllowlistEntry {
  id: number;
  agentId: string;
  identifier: string;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

async function fetchTelegramConfig(agentId: string): Promise<TelegramConfig> {
  const res = await authFetch(`${API_BASE}/${agentId}/config`);
  if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`);
  return res.json();
}

async function updateTelegramConfig(
  agentId: string,
  data: { enabled?: boolean; botToken?: string; allowAll?: boolean },
): Promise<TelegramConfig> {
  const res = await authFetch(`${API_BASE}/${agentId}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to update config: ${res.status}`);
  return res.json();
}

async function fetchAllowlist(agentId: string): Promise<AllowlistEntry[]> {
  const res = await authFetch(`${API_BASE}/${agentId}/allowlist`);
  if (!res.ok) throw new Error(`Failed to fetch allowlist: ${res.status}`);
  const data = await res.json();
  return data.entries;
}

async function createAllowlistEntry(
  agentId: string,
  identifier: string,
  label?: string,
): Promise<AllowlistEntry> {
  const res = await authFetch(`${API_BASE}/${agentId}/allowlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, label: label || null }),
  });
  if (!res.ok) throw new Error(`Failed to create entry: ${res.status}`);
  return res.json();
}

async function deleteAllowlistEntry(agentId: string, entryId: number): Promise<void> {
  const res = await authFetch(`${API_BASE}/${agentId}/allowlist/${entryId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to delete entry: ${res.status}`);
}

async function fetchBotStatus(agentId: string): Promise<{ active: boolean }> {
  const res = await authFetch(`${API_BASE}/${agentId}/status`);
  if (!res.ok) return { active: false };
  return res.json();
}

// ── Setup Instructions ──────────────────────────────────────────────────────

function SetupInstructions() {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2.5 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">How to create your Telegram bot</p>
      <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
        <li>
          Open Telegram and search for{' '}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-0.5"
          >
            @BotFather
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </li>
        <li>
          Send <code className="text-[11px] bg-muted px-1 py-0.5 rounded font-mono">/newbot</code>{' '}
          and follow the prompts
        </li>
        <li>Give your bot a name that matches this agent</li>
        <li>Copy the bot token BotFather gives you and paste it below</li>
      </ol>
      <p className="text-[10px] text-muted-foreground/70 mt-1">
        Each Telegram account can create up to 20 bots via BotFather.
      </p>
    </div>
  );
}

// ── Allowlist Panel ─────────────────────────────────────────────────────────

function AllowlistPanel({
  agentId,
  allowAll,
  onToggleAllowAll,
}: {
  agentId: string;
  allowAll: boolean;
  onToggleAllowAll: (value: boolean) => void;
}) {
  const [entries, setEntries] = useState<AllowlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [newIdentifier, setNewIdentifier] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetchAllowlist(agentId)
      .then(setEntries)
      .catch(() => toast.error('Failed to load allowlist'))
      .finally(() => setLoading(false));
  }, [agentId]);

  const handleAdd = async () => {
    if (!newIdentifier.trim()) return;
    setAdding(true);
    try {
      const entry = await createAllowlistEntry(agentId, newIdentifier.trim(), newLabel.trim() || undefined);
      setEntries((prev) => [entry, ...prev]);
      setNewIdentifier('');
      setNewLabel('');
      toast.success('Entry added');
    } catch {
      toast.error('Failed to add entry');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (entryId: number) => {
    try {
      await deleteAllowlistEntry(agentId, entryId);
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
      toast.success('Entry removed');
    } catch {
      toast.error('Failed to remove entry');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-medium">Access Control</Label>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Respond to everyone</Label>
          <Switch checked={allowAll} onCheckedChange={onToggleAllowAll} />
        </div>
      </div>

      {!allowAll && (
        <>
          <p className="text-xs text-muted-foreground">
            Only users matching entries below can interact with this bot. Others are silently ignored.
          </p>

          {/* Add entry form */}
          <div className="flex gap-2">
            <Input
              value={newIdentifier}
              onChange={(e) => setNewIdentifier(e.target.value)}
              placeholder="User ID, @username, @prefix*, or *"
              className="text-sm font-mono flex-1"
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Label (optional)"
              className="text-sm w-32"
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <Button onClick={handleAdd} disabled={adding || !newIdentifier.trim()} size="sm">
              {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            </Button>
          </div>

          {/* Entry list */}
          {loading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">
              No entries yet. Add a user ID or username to get started.
            </p>
          ) : (
            <div className="space-y-1">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between px-2 py-1.5 rounded-md bg-muted/30 group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <code className="text-xs font-mono text-foreground">{entry.identifier}</code>
                    {entry.label && (
                      <span className="text-xs text-muted-foreground truncate">{entry.label}</span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(entry.id)}
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-muted-foreground/70">
            Formats: <code className="bg-muted px-0.5 rounded">12345678</code> (user ID),{' '}
            <code className="bg-muted px-0.5 rounded">@username</code> (exact),{' '}
            <code className="bg-muted px-0.5 rounded">@prefix*</code> (wildcard),{' '}
            <code className="bg-muted px-0.5 rounded">*</code> (allow all)
          </p>
        </>
      )}
    </div>
  );
}

// ── Main Panel ──────────────────────────────────────────────────────────────

interface TelegramSetupPanelProps {
  agentId: string;
}

export function TelegramSetupPanel({ agentId }: TelegramSetupPanelProps) {
  const [config, setConfig] = useState<TelegramConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [botStatus, setBotStatus] = useState<boolean | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);

  const isConfigured = config && config.botToken;

  useEffect(() => {
    fetchTelegramConfig(agentId)
      .then(setConfig)
      .catch(() => toast.error('Failed to load Telegram config'))
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => {
    if (isConfigured && config?.enabled) {
      fetchBotStatus(agentId).then((s) => setBotStatus(s.active));
    }
  }, [agentId, isConfigured, config?.enabled]);

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return;
    setSaving(true);
    try {
      const updated = await updateTelegramConfig(agentId, {
        botToken: tokenInput.trim(),
        enabled: true,
      });
      setConfig(updated);
      setTokenInput('');
      toast.success('Bot token saved and enabled');
      // Check status after a short delay for the engine to pick it up
      setTimeout(() => {
        fetchBotStatus(agentId).then((s) => setBotStatus(s.active));
      }, 3000);
    } catch {
      toast.error('Failed to save token');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const updated = await updateTelegramConfig(agentId, { enabled: !config.enabled });
      setConfig(updated);
      if (updated.enabled) {
        setTimeout(() => {
          fetchBotStatus(agentId).then((s) => setBotStatus(s.active));
        }, 3000);
      } else {
        setBotStatus(false);
      }
    } catch {
      toast.error('Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleAllowAll = async (value: boolean) => {
    setSaving(true);
    try {
      const updated = await updateTelegramConfig(agentId, { allowAll: value });
      setConfig(updated);
    } catch {
      toast.error('Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleCheckStatus = useCallback(async () => {
    setCheckingStatus(true);
    try {
      const s = await fetchBotStatus(agentId);
      setBotStatus(s.active);
    } finally {
      setCheckingStatus(false);
    }
  }, [agentId]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-blue-500" />
              <CardTitle className="text-base">Telegram</CardTitle>
              {isConfigured ? (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 border-green-500/50 text-green-500"
                >
                  <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                  <XCircle className="h-2.5 w-2.5 mr-1" />
                  Not connected
                </Badge>
              )}
              {isConfigured && !config?.enabled && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  Disabled
                </Badge>
              )}
            </div>
            <CardDescription className="text-xs">
              Each agent gets its own Telegram bot. Messages go directly to this agent.
            </CardDescription>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isConfigured && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleToggleEnabled}
                disabled={saving}
                className="h-7 text-xs"
              >
                {config?.enabled ? 'Disable' : 'Enable'}
              </Button>
            )}
          </div>
        </div>

        {/* Bot info when connected */}
        {isConfigured && config?.botUsername && (
          <div className="flex items-center gap-2 mt-2">
            <code className="text-xs text-muted-foreground font-mono">@{config.botUsername}</code>
            {config.enabled && botStatus !== null && (
              <div className="flex items-center gap-1">
                <div
                  className={`h-1.5 w-1.5 rounded-full ${botStatus ? 'bg-green-500' : 'bg-red-500'}`}
                />
                <span className="text-[10px] text-muted-foreground">
                  {botStatus ? 'Online' : 'Offline'}
                </span>
                <button
                  onClick={handleCheckStatus}
                  className="text-muted-foreground hover:text-foreground"
                  disabled={checkingStatus}
                >
                  <RefreshCw className={`h-2.5 w-2.5 ${checkingStatus ? 'animate-spin' : ''}`} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Masked token */}
        {isConfigured && config?.botToken && (
          <code className="text-[10px] text-muted-foreground/70 font-mono mt-1 block">
            Token: {config.botToken}
          </code>
        )}
      </CardHeader>

      <CardContent className="pt-0 space-y-4">
        {/* Setup instructions */}
        <SetupInstructions />

        {/* Token input */}
        <div className="space-y-2">
          <Label className="text-sm">
            {isConfigured ? 'Update Bot Token' : 'Bot Token'}
          </Label>
          <div className="relative">
            <Input
              type={showToken ? 'text' : 'password'}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={isConfigured ? '(leave blank to keep existing)' : 'Paste your bot token here'}
              className="font-mono text-sm pr-10"
              onKeyDown={(e) => e.key === 'Enter' && handleSaveToken()}
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <Button
            onClick={handleSaveToken}
            disabled={saving || !tokenInput.trim()}
            className="w-full"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isConfigured ? (
              'Update Token'
            ) : (
              'Save & Enable'
            )}
          </Button>
        </div>

        {/* Allowlist section — only show when configured */}
        {isConfigured && (
          <div className="border-t pt-4">
            <AllowlistPanel
              agentId={agentId}
              allowAll={config?.allowAll ?? false}
              onToggleAllowAll={handleToggleAllowAll}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
