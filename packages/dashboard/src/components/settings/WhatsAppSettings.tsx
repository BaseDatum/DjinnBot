/**
 * WhatsAppSettings — dashboard UI for WhatsApp channel integration.
 *
 * Sections:
 *   1. Connection Status + QR linking / pairing code
 *   2. General settings (enable, default agent, sticky TTL, ack emoji)
 *   3. Allowlist management (CRUD table)
 *
 * Mirrors SignalSettings but adds pairing-code linking as an alternative to QR.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { fetchAgents, type AgentListItem } from '@/lib/api';
import { Switch } from '@/components/ui/switch';

// ── Types ────────────────────────────────────────────────────────────────────

interface WhatsAppConfig {
  enabled: boolean;
  phoneNumber: string | null;
  linked: boolean;
  defaultAgentId: string | null;
  stickyTtlMinutes: number;
  allowAll: boolean;
  ackEmoji: string | null;
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

async function fetchWhatsAppConfig(): Promise<WhatsAppConfig> {
  const res = await authFetch(`${API_BASE}/whatsapp/config`);
  return handleResponse(res, 'Failed to fetch WhatsApp config');
}

async function updateWhatsAppConfig(data: Partial<WhatsAppConfig>): Promise<WhatsAppConfig> {
  const res = await authFetch(`${API_BASE}/whatsapp/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to update WhatsApp config');
}

async function startWhatsAppLink(): Promise<{ qr: string }> {
  const res = await authFetch(`${API_BASE}/whatsapp/link`, { method: 'POST' });
  return handleResponse(res, 'Failed to start linking');
}

async function requestPairingCode(phoneNumber: string): Promise<{ code: string }> {
  const res = await authFetch(`${API_BASE}/whatsapp/link/pairing-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber }),
  });
  return handleResponse(res, 'Failed to get pairing code');
}

async function checkLinkStatus(): Promise<{ linked: boolean; phoneNumber?: string }> {
  const res = await authFetch(`${API_BASE}/whatsapp/link/status`);
  return handleResponse(res, 'Failed to check link status');
}

async function unlinkWhatsApp(): Promise<void> {
  const res = await authFetch(`${API_BASE}/whatsapp/unlink`, { method: 'POST' });
  await handleResponse(res, 'Failed to unlink WhatsApp');
}

async function fetchAllowlist(): Promise<{ entries: AllowlistEntry[]; total: number }> {
  const res = await authFetch(`${API_BASE}/whatsapp/allowlist`);
  return handleResponse(res, 'Failed to fetch allowlist');
}

async function createAllowlistEntry(data: {
  phoneNumber: string;
  label?: string;
  defaultAgentId?: string;
}): Promise<AllowlistEntry> {
  const res = await authFetch(`${API_BASE}/whatsapp/allowlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(res, 'Failed to create allowlist entry');
}

async function deleteAllowlistEntry(id: number): Promise<void> {
  await authFetch(`${API_BASE}/whatsapp/allowlist/${id}`, { method: 'DELETE' });
}

// ── Component ────────────────────────────────────────────────────────────────

export function WhatsAppSettings() {
  const [config, setConfig] = useState<WhatsAppConfig | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qrData, setQrData] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingPhone, setPairingPhone] = useState('');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [linkMode, setLinkMode] = useState<'qr' | 'pairing'>('qr');
  const linkPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // New entry form
  const [newPhone, setNewPhone] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newAgent, setNewAgent] = useState('');

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      const [cfg, agentList, al] = await Promise.all([
        fetchWhatsAppConfig(),
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

  const startPoll = () => {
    linkPollRef.current = setInterval(async () => {
      try {
        const status = await checkLinkStatus();
        if (status.linked) {
          if (linkPollRef.current) clearInterval(linkPollRef.current);
          setQrData(null);
          setPairingCode(null);
          setLinking(false);
          await loadAll();
        }
      } catch {
        // Keep polling
      }
    }, 2000);
  };

  const handleStartQrLink = async () => {
    try {
      setLinking(true);
      setError(null);
      setPairingCode(null);
      const result = await startWhatsAppLink();
      setQrData(result.qr);
      startPoll();
    } catch (err) {
      setLinking(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePairingCode = async () => {
    if (!pairingPhone.trim()) return;
    try {
      setLinking(true);
      setError(null);
      setQrData(null);
      const result = await requestPairingCode(pairingPhone.trim());
      setPairingCode(result.code);
      startPoll();
    } catch (err) {
      setLinking(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUnlink = async () => {
    try {
      setUnlinking(true);
      setError(null);
      await unlinkWhatsApp();
      setShowUnlinkConfirm(false);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlinking(false);
    }
  };

  // ── Config updates ───────────────────────────────────────────────────

  const handleToggle = async (field: keyof WhatsAppConfig, value: boolean) => {
    setConfig((prev) => prev ? { ...prev, [field]: value } : prev);
    try {
      const updated = await updateWhatsAppConfig({ [field]: value });
      setConfig(updated);
    } catch (err) {
      setConfig((prev) => prev ? { ...prev, [field]: !value } : prev);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDefaultAgent = async (agentId: string) => {
    try {
      const updated = await updateWhatsAppConfig({ defaultAgentId: agentId || undefined } as any);
      setConfig(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTtlChange = async (minutes: number) => {
    try {
      const updated = await updateWhatsAppConfig({ stickyTtlMinutes: minutes } as any);
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
    return <div className="p-4 text-muted-foreground">Loading WhatsApp settings...</div>;
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

        {!config?.linked && !qrData && !pairingCode && (
          <div className="space-y-3">
            <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-yellow-700 dark:text-yellow-400 text-sm">
              <strong>Important:</strong> Use a separate phone number dedicated to DjinnBot.
              Do not link your personal WhatsApp number &mdash; DjinnBot will send and receive
              messages as this number.
            </div>

            {/* Link mode selector */}
            <div className="flex gap-2">
              <button
                onClick={() => setLinkMode('qr')}
                className={`px-3 py-1.5 rounded-md text-sm ${
                  linkMode === 'qr'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                QR Code
              </button>
              <button
                onClick={() => setLinkMode('pairing')}
                className={`px-3 py-1.5 rounded-md text-sm ${
                  linkMode === 'pairing'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                Pairing Code
              </button>
            </div>

            {linkMode === 'qr' && (
              <button
                onClick={handleStartQrLink}
                disabled={linking}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90 disabled:opacity-50"
              >
                {linking ? 'Starting...' : 'Link via QR Code'}
              </button>
            )}

            {linkMode === 'pairing' && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Enter the phone number you want to link (with country code):
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={pairingPhone}
                    onChange={(e) => setPairingPhone(e.target.value)}
                    placeholder="+15551234567"
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm w-48 font-mono"
                  />
                  <button
                    onClick={handlePairingCode}
                    disabled={linking || !pairingPhone.trim()}
                    className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90 disabled:opacity-50"
                  >
                    {linking ? 'Getting code...' : 'Get Pairing Code'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {qrData && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Open WhatsApp on your phone &rarr; Linked Devices &rarr; Link a Device, then scan:
            </p>
            <div className="bg-white p-4 rounded-lg inline-block">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qrData)}`}
                alt="WhatsApp QR Code"
                className="w-64 h-64"
              />
            </div>
          </div>
        )}

        {pairingCode && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Open WhatsApp on your phone &rarr; Linked Devices &rarr; Link a Device &rarr;
              "Link with phone number instead", then enter this code:
            </p>
            <div className="bg-muted p-4 rounded-lg inline-block">
              <span className="text-3xl font-mono font-bold tracking-widest">{pairingCode}</span>
            </div>
          </div>
        )}

        {config?.linked && (
          <div className="space-y-3">
            {!showUnlinkConfirm ? (
              <button
                onClick={() => setShowUnlinkConfirm(true)}
                className="px-4 py-2 bg-destructive text-destructive-foreground rounded-md text-sm hover:bg-destructive/90"
              >
                Unlink Account
              </button>
            ) : (
              <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4 space-y-3">
                <p className="text-sm text-destructive font-medium">
                  Are you sure you want to unlink {config.phoneNumber}?
                </p>
                <p className="text-xs text-muted-foreground">
                  This will disconnect DjinnBot from WhatsApp. You will need to re-link to use WhatsApp messaging again.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={handleUnlink}
                    disabled={unlinking}
                    className="px-4 py-2 bg-destructive text-destructive-foreground rounded-md text-sm hover:bg-destructive/90 disabled:opacity-50"
                  >
                    {unlinking ? 'Unlinking...' : 'Yes, Unlink'}
                  </button>
                  <button
                    onClick={() => setShowUnlinkConfirm(false)}
                    disabled={unlinking}
                    className="px-4 py-2 bg-muted text-muted-foreground rounded-md text-sm hover:bg-muted/80"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Section 2: General Settings ── */}
      <section className="space-y-4">
        <h3 className="text-lg font-semibold">Settings</h3>

        <div className="flex items-center gap-3">
          <Switch
            checked={config?.enabled ?? false}
            onCheckedChange={(checked) => handleToggle('enabled', checked)}
          />
          <span className="text-sm">Enable WhatsApp integration</span>
        </div>

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

        <div className="flex items-center gap-3">
          <Switch
            checked={config?.allowAll ?? false}
            onCheckedChange={(checked) => handleToggle('allowAll', checked)}
          />
          <span className="text-sm">Allow all incoming messages (no filtering)</span>
        </div>

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
