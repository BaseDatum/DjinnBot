/**
 * API Key management — create, list, and revoke API keys.
 */

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth';
import { API_BASE } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { Plus, Trash2, Copy, Key } from 'lucide-react';

interface APIKeyEntry {
  id: string;
  name: string;
  keyPrefix: string;
  isServiceKey: boolean;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}

export function APIKeySettings() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<APIKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyExpiry, setNewKeyExpiry] = useState('');
  const [creating, setCreating] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);

  const fetchKeys = async () => {
    try {
      // Admins see all keys, regular users see their own
      const endpoint = user?.isAdmin ? '/auth/api-keys/all' : '/auth/api-keys';
      const res = await authFetch(`${API_BASE}${endpoint}`);
      if (res.ok) setKeys(await res.json());
    } catch {
      console.error('Failed to fetch API keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchKeys(); }, []);

  const handleCreate = async (isService = false) => {
    setCreating(true);
    try {
      const endpoint = isService ? '/auth/api-keys/service' : '/auth/api-keys';
      const res = await authFetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newKeyName,
          expiresInDays: newKeyExpiry ? parseInt(newKeyExpiry) : undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).detail);
      const data = await res.json();
      setNewKeyValue(data.key);
      toast.success('API key created — copy it now, it won\'t be shown again');
      fetchKeys();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create key');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    try {
      await authFetch(`${API_BASE}/auth/api-keys/${id}`, { method: 'DELETE' });
      toast.success('Key revoked');
      fetchKeys();
    } catch {
      toast.error('Failed to revoke key');
    }
  };

  const copyKey = () => {
    if (newKeyValue) {
      navigator.clipboard.writeText(newKeyValue);
      toast.success('Key copied to clipboard');
    }
  };

  const formatDate = (ms: number | null) => {
    if (!ms) return 'Never';
    return new Date(ms).toLocaleDateString();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">API Keys</h3>
          <p className="text-sm text-muted-foreground">Programmatic access to the DjinnBot API</p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setNewKeyValue(null); setNewKeyName(''); setNewKeyExpiry(''); }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" /> New Key
        </button>
      </div>

      {/* New key display */}
      {newKeyValue && (
        <div className="p-4 rounded-md border border-yellow-500/30 bg-yellow-500/5 space-y-2">
          <p className="text-sm font-medium text-yellow-500">Save this key now — it won't be shown again</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 text-sm bg-background rounded border border-input font-mono break-all">
              {newKeyValue}
            </code>
            <button onClick={copyKey} className="p-2 rounded hover:bg-accent" title="Copy">
              <Copy className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={() => setNewKeyValue(null)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            I've saved it, dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      {showCreate && !newKeyValue && (
        <div className="p-4 rounded-md border border-border bg-card space-y-3">
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Name</label>
              <input value={newKeyName} onChange={e => setNewKeyName(e.target.value)}
                placeholder="My CI pipeline"
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
            </div>
            <div className="w-32">
              <label className="block text-sm font-medium mb-1">Expires (days)</label>
              <input type="number" value={newKeyExpiry} onChange={e => setNewKeyExpiry(e.target.value)}
                placeholder="Never"
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => handleCreate(false)} disabled={creating || !newKeyName.trim()}
              className="px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors">
              {creating ? 'Creating...' : 'Create Key'}
            </button>
            {user?.isAdmin && (
              <button onClick={() => handleCreate(true)} disabled={creating || !newKeyName.trim()}
                className="px-4 py-1.5 text-sm rounded-md border border-input hover:bg-accent disabled:opacity-50 transition-colors">
                Create Service Key
              </button>
            )}
            <button onClick={() => setShowCreate(false)}
              className="px-4 py-1.5 text-sm rounded-md border border-input hover:bg-accent transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Key list */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : keys.length === 0 ? (
        <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-4 text-center">
          No API keys created yet.
        </div>
      ) : (
        <div className="space-y-1">
          {keys.map(k => (
            <div key={k.id} className="flex items-center justify-between p-3 rounded-md border border-border bg-card">
              <div className="flex items-center gap-3">
                <Key className="w-4 h-4 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {k.name}
                    {k.isServiceKey && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500">Service</span>}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {k.keyPrefix}... &middot; Created {formatDate(k.createdAt)} &middot; Last used {formatDate(k.lastUsedAt)}
                    {k.expiresAt && <> &middot; Expires {formatDate(k.expiresAt)}</>}
                  </div>
                </div>
              </div>
              <button onClick={() => handleRevoke(k.id)} className="p-1.5 rounded hover:bg-destructive/10" title="Revoke">
                <Trash2 className="w-4 h-4 text-destructive" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
