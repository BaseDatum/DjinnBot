/**
 * SignalSettings — dashboard UI for Signal channel integration.
 *
 * Sections:
 *   1. Connection Status + QR linking
 *   2. General settings (enable, default agent, sticky TTL)
 *   3. Allowlist management (CRUD table)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { fetchAgents, type AgentListItem } from '@/lib/api';

// ── Types ────────────────────────────────────────────────────────────────────

interface SignalConfig {
  enabled: boolean;
  phoneNumber: string | null;
  linked: boolean;
  defaultAgentId: string | null;
  stickyTtlMinutes: number;
  allowAll: boolean;
}

interface AllowlistEntry {
  id: number;
  phoneNumber: string;
  label: string | null;
  defaultAgentId: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function handleResponse<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: fallback }));
    throw new Error(body.detail || `${fallback} (${res.status})`);
  }
  return res.json();
}

async function fetchSignalConfig(): Promise<SignalConfig> {
  const res = await authFetch(`${API_BASE}/signal/config`);
  return handleResponse(res, 'Failed to fetch Signal config');
}

async function updateSignalConfig(data: Partial<SignalConfig>): Promise<SignalConfig> {
  const res = await authFetch(`${API_BASE}/signal/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to update Signal config');
}

async function startSignalLink(): Promise<{ uri: string }> {
  const res = await authFetch(`${API_BASE}/signal/link`, { method: 'POST' });
  return handleResponse(res, 'Failed to start linking');
}

async function checkLinkStatus(): Promise<{ linked: boolean; phoneNumber?: string }> {
  const res = await authFetch(`${API_BASE}/signal/link/status`);
  return handleResponse(res, 'Failed to check link status');
}

async function fetchAllowlist(): Promise<{ entries: AllowlistEntry[]; total: number }> {
  const res = await authFetch(`${API_BASE}/signal/allowlist`);
  return handleResponse(res, 'Failed to fetch allowlist');
}

async function createAllowlistEntry(data: {
  phoneNumber: string;
  label?: string;
  defaultAgentId?: string;
}): Promise<AllowlistEntry> {
  const res = await authFetch(`${API_BASE}/signal/allowlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to create allowlist entry');
}

async function deleteAllowlistEntry(id: number): Promise<void> {
  await authFetch(`${API_BASE}/signal/allowlist/${id}`, { method: 'DELETE' });
}

// ── Component ────────────────────────────────────────────────────────────────

export function SignalSettings() {
  const [config, setConfig] = useState<SignalConfig | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkUri, setLinkUri] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const linkPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // New entry form
  const [newPhone, setNewPhone] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newAgent, setNewAgent] = useState('');

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      const [cfg, agentList, al] = await Promise.all([
        fetchSignalConfig(),
        fetchAgents(),
        fetchAllowlist(),
      ]);
      setConfig(cfg);
      setAgents(agentList);
      setAllowlist(al.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    return () => {
      if (linkPollRef.current) clearInterval(linkPollRef.current);
    };
  }, [loadAll]);

  // ── Linking ──────────────────────────────────────────────────────────

  const handleStartLink = async () => {
    try {
      setLinking(true);
      setError(null);
      const result = await startSignalLink();
      setLinkUri(result.uri);

      // Poll for link completion every 2s
      linkPollRef.current = setInterval(async () => {
        try {
          const status = await checkLinkStatus();
          if (status.linked) {
            if (linkPollRef.current) clearInterval(linkPollRef.current);
            setLinkUri(null);
            setLinking(false);
            await loadAll();
          }
        } catch {
          // Keep polling
        }
      }, 2000);
    } catch (err) {
      setLinking(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Config updates ───────────────────────────────────────────────────

  const handleToggle = async (field: keyof SignalConfig, value: boolean) => {
    try {
      const updated = await updateSignalConfig({ [field]: value });
      setConfig(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDefaultAgent = async (agentId: string) => {
    try {
      const updated = await updateSignalConfig({ defaultAgentId: agentId || undefined } as any);
      setConfig(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTtlChange = async (minutes: number) => {
    try {
      const updated = await updateSignalConfig({ stickyTtlMinutes: minutes } as any);
      setConfig(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Allowlist ────────────────────────────────────────────────────────

  const handleAddEntry = async () => {
    if (!newPhone.trim()) return;
    try {
      const entry = await createAllowlistEntry({
        phoneNumber: newPhone.trim(),
        label: newLabel.trim() || undefined,
        defaultAgentId: newAgent || undefined,
      });
      setAllowlist((prev) => [entry, ...prev]);
      setNewPhone('');
      setNewLabel('');
      setNewAgent('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteEntry = async (id: number) => {
    try {
      await deleteAllowlistEntry(id);
      setAllowlist((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Render ───────────────────────────────────────────────────────────

  if (loading) {
    return <div className="p-4 text-muted-foreground">Loading Signal settings...</div>;
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* ── Section 1: Connection Status ── */}
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Connection</h3>
        <div className="flex items-center gap-3">
          <div
            className={`w-3 h-3 rounded-full ${config?.linked ? 'bg-green-500' : 'bg-red-500'}`}
          />
          <span className="text-sm">
            {config?.linked
              ? `Connected as ${config.phoneNumber}`
              : 'Not connected'}
          </span>
        </div>

        {!config?.linked && !linkUri && (
          <button
            onClick={handleStartLink}
            disabled={linking}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {linking ? 'Starting...' : 'Link Signal Account'}
          </button>
        )}

        {linkUri && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Scan this QR code with Signal on your phone to link:
            </p>
            <div className="bg-white p-4 rounded-lg inline-block">
              {/* QR code rendered via a simple img tag using a QR code API */}
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(linkUri)}`}
                alt="Signal QR Code"
                className="w-64 h-64"
              />
            </div>
            <p className="text-xs text-muted-foreground font-mono break-all max-w-md">
              {linkUri}
            </p>
          </div>
        )}

        {/* Manual setup instructions */}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Manual setup instructions
          </summary>
          <div className="mt-2 space-y-2 pl-4 border-l-2 border-muted text-muted-foreground">
            <p>
              <strong>Register a new number:</strong>
            </p>
            <code className="block bg-muted p-2 rounded text-xs">
              signal-cli -a +NUMBER register{'\n'}
              signal-cli -a +NUMBER verify CODE
            </code>
            <p>
              <strong>Link an existing Signal account:</strong>
            </p>
            <code className="block bg-muted p-2 rounded text-xs">
              signal-cli link -n "DjinnBot"
            </code>
            <p>
              Signal data is stored at <code>/data/signal/data</code> on JuiceFS.
            </p>
          </div>
        </details>
      </section>

      {/* ── Section 2: General Settings ── */}
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Settings</h3>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={config?.enabled ?? false}
            onChange={(e) => handleToggle('enabled', e.target.checked)}
            className="rounded"
          />
          <span className="text-sm">Enable Signal integration</span>
        </label>

        <div className="space-y-2">
          <label className="text-sm font-medium">Default Agent</label>
          <select
            value={config?.defaultAgentId ?? ''}
            onChange={(e) => handleDefaultAgent(e.target.value)}
            className="block w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Select an agent...</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name} ({a.id})
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Messages that don't match any routing rule go to this agent.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">
            Sticky Conversation TTL: {config?.stickyTtlMinutes ?? 30} minutes
          </label>
          <input
            type="range"
            min={5}
            max={120}
            step={5}
            value={config?.stickyTtlMinutes ?? 30}
            onChange={(e) => handleTtlChange(parseInt(e.target.value))}
            className="w-full max-w-xs"
          />
          <p className="text-xs text-muted-foreground">
            How long a conversation stays routed to the same agent after the last message.
          </p>
        </div>
      </section>

      {/* ── Section 3: Allowlist ── */}
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Allowlist</h3>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={config?.allowAll ?? false}
            onChange={(e) => handleToggle('allowAll', e.target.checked)}
            className="rounded"
          />
          <span className="text-sm">Allow all incoming messages (no filtering)</span>
        </label>

        {/* Add entry form */}
        <div className="flex gap-2 items-end flex-wrap">
          <div>
            <label className="text-xs text-muted-foreground">Phone Number</label>
            <input
              type="text"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="+15551234567"
              className="block rounded-md border border-input bg-background px-3 py-1.5 text-sm w-40"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Label</label>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Name"
              className="block rounded-md border border-input bg-background px-3 py-1.5 text-sm w-32"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Default Agent</label>
            <select
              value={newAgent}
              onChange={(e) => setNewAgent(e.target.value)}
              className="block rounded-md border border-input bg-background px-3 py-1.5 text-sm w-36"
            >
              <option value="">None</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.emoji} {a.name}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={handleAddEntry}
            disabled={!newPhone.trim()}
            className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            Add
          </button>
        </div>

        {/* Allowlist table */}
        {allowlist.length > 0 ? (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Phone Number</th>
                  <th className="text-left px-3 py-2 font-medium">Label</th>
                  <th className="text-left px-3 py-2 font-medium">Default Agent</th>
                  <th className="text-right px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {allowlist.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-3 py-2 font-mono">{entry.phoneNumber}</td>
                    <td className="px-3 py-2 text-muted-foreground">{entry.label || '-'}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {entry.defaultAgentId
                        ? agents.find((a) => a.id === entry.defaultAgentId)
                          ? `${agents.find((a) => a.id === entry.defaultAgentId)!.emoji} ${agents.find((a) => a.id === entry.defaultAgentId)!.name}`
                          : entry.defaultAgentId
                        : '-'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => handleDeleteEntry(entry.id)}
                        className="text-destructive hover:text-destructive/80 text-xs"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No allowlist entries. Add phone numbers above, or enable "Allow all" to accept any sender.
          </p>
        )}
      </section>
    </div>
  );
}
