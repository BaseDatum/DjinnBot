/**
 * OIDC Provider management — add, edit, delete, and test OIDC providers.
 */

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth';
import { API_BASE } from '@/lib/api';
import { Plus, Trash2, TestTube, Pencil } from 'lucide-react';

interface OIDCProvider {
  id: string;
  slug: string;
  name: string;
  issuerUrl: string;
  clientId: string;
  maskedClientSecret: string | null;
  scopes: string;
  buttonText: string | null;
  buttonColor: string | null;
  iconUrl: string | null;
  autoDiscovery: boolean;
  enabled: boolean;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
}

interface ProviderForm {
  name: string;
  slug: string;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  buttonText: string;
  buttonColor: string;
  iconUrl: string;
  autoDiscovery: boolean;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  jwksUri: string;
}

const emptyForm: ProviderForm = {
  name: '',
  slug: '',
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid email profile',
  buttonText: '',
  buttonColor: '',
  iconUrl: '',
  autoDiscovery: true,
  authorizationEndpoint: '',
  tokenEndpoint: '',
  userinfoEndpoint: '',
  jwksUri: '',
};

export function OIDCProviderSettings() {
  const [providers, setProviders] = useState<OIDCProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const fetchProviders = async () => {
    try {
      const res = await authFetch(`${API_BASE}/auth/providers`);
      if (res.ok) {
        setProviders(await res.json());
      }
    } catch (err) {
      console.error('Failed to fetch OIDC providers', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProviders(); }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editingId) {
        const res = await authFetch(`${API_BASE}/auth/providers/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name || undefined,
            issuerUrl: form.issuerUrl || undefined,
            clientId: form.clientId || undefined,
            clientSecret: form.clientSecret || undefined,
            scopes: form.scopes || undefined,
            buttonText: form.buttonText || undefined,
            buttonColor: form.buttonColor || undefined,
            iconUrl: form.iconUrl || undefined,
            autoDiscovery: form.autoDiscovery,
            authorizationEndpoint: form.authorizationEndpoint || undefined,
            tokenEndpoint: form.tokenEndpoint || undefined,
            userinfoEndpoint: form.userinfoEndpoint || undefined,
            jwksUri: form.jwksUri || undefined,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).detail);
        toast.success('Provider updated');
      } else {
        const res = await authFetch(`${API_BASE}/auth/providers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        if (!res.ok) throw new Error((await res.json()).detail);
        toast.success('Provider added');
      }
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
      fetchProviders();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save provider');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this OIDC provider?')) return;
    try {
      await authFetch(`${API_BASE}/auth/providers/${id}`, { method: 'DELETE' });
      toast.success('Provider removed');
      fetchProviders();
    } catch {
      toast.error('Failed to remove provider');
    }
  };

  const handleTest = async (id: string) => {
    try {
      const res = await authFetch(`${API_BASE}/auth/providers/${id}/test`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).detail);
      const data = await res.json();
      toast.success(`Discovery OK — issuer: ${data.issuer}`);
    } catch (err: any) {
      toast.error(err.message || 'Discovery failed');
    }
  };

  const startEdit = (p: OIDCProvider) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      slug: p.slug,
      issuerUrl: p.issuerUrl,
      clientId: p.clientId,
      clientSecret: '',
      scopes: p.scopes,
      buttonText: p.buttonText || '',
      buttonColor: p.buttonColor || '',
      iconUrl: p.iconUrl || '',
      autoDiscovery: p.autoDiscovery,
      authorizationEndpoint: p.authorizationEndpoint || '',
      tokenEndpoint: p.tokenEndpoint || '',
      userinfoEndpoint: p.userinfoEndpoint || '',
      jwksUri: p.jwksUri || '',
    });
    setShowForm(true);
  };

  const updateField = (field: keyof ProviderForm, value: string | boolean) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">OIDC Providers</h3>
          <p className="text-sm text-muted-foreground">Configure single sign-on with OpenID Connect providers</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm(emptyForm); }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" /> Add Provider
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : providers.length === 0 && !showForm ? (
        <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-4 text-center">
          No OIDC providers configured. Add one to enable single sign-on.
        </div>
      ) : (
        <div className="space-y-2">
          {providers.map(p => (
            <div key={p.id} className="flex items-center justify-between p-3 rounded-md border border-border bg-card">
              <div className="flex items-center gap-3">
                {p.iconUrl && <img src={p.iconUrl} alt="" className="w-6 h-6 rounded" />}
                <div>
                  <div className="font-medium text-foreground">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.issuerUrl}</div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${p.enabled ? 'bg-green-500/10 text-green-500' : 'bg-muted text-muted-foreground'}`}>
                  {p.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => handleTest(p.id)} className="p-1.5 rounded hover:bg-accent" title="Test Discovery">
                  <TestTube className="w-4 h-4 text-muted-foreground" />
                </button>
                <button onClick={() => startEdit(p)} className="p-1.5 rounded hover:bg-accent" title="Edit">
                  <Pencil className="w-4 h-4 text-muted-foreground" />
                </button>
                <button onClick={() => handleDelete(p.id)} className="p-1.5 rounded hover:bg-destructive/10" title="Delete">
                  <Trash2 className="w-4 h-4 text-destructive" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit form */}
      {showForm && (
        <div className="border border-border rounded-md p-4 space-y-4 bg-card">
          <h4 className="font-medium text-foreground">{editingId ? 'Edit Provider' : 'Add OIDC Provider'}</h4>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input value={form.name} onChange={e => updateField('name', e.target.value)}
                placeholder="Google" className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
            </div>
            {!editingId && (
              <div>
                <label className="block text-sm font-medium mb-1">Slug</label>
                <input value={form.slug} onChange={e => updateField('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="google" className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
              </div>
            )}
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1">Issuer URL</label>
              <input value={form.issuerUrl} onChange={e => updateField('issuerUrl', e.target.value)}
                placeholder="https://accounts.google.com" className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Client ID</label>
              <input value={form.clientId} onChange={e => updateField('clientId', e.target.value)}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Client Secret</label>
              <input type="password" value={form.clientSecret} onChange={e => updateField('clientSecret', e.target.value)}
                placeholder={editingId ? '(unchanged)' : ''}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Scopes</label>
              <input value={form.scopes} onChange={e => updateField('scopes', e.target.value)}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input type="checkbox" id="autoDiscovery" checked={form.autoDiscovery}
                onChange={e => updateField('autoDiscovery', e.target.checked)}
                className="rounded border-input" />
              <label htmlFor="autoDiscovery" className="text-sm">Auto-discover endpoints</label>
            </div>
          </div>

          {/* Manual endpoints (when auto-discovery is off) */}
          {!form.autoDiscovery && (
            <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border">
              <div>
                <label className="block text-sm font-medium mb-1">Authorization Endpoint</label>
                <input value={form.authorizationEndpoint} onChange={e => updateField('authorizationEndpoint', e.target.value)}
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Token Endpoint</label>
                <input value={form.tokenEndpoint} onChange={e => updateField('tokenEndpoint', e.target.value)}
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">UserInfo Endpoint</label>
                <input value={form.userinfoEndpoint} onChange={e => updateField('userinfoEndpoint', e.target.value)}
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">JWKS URI</label>
                <input value={form.jwksUri} onChange={e => updateField('jwksUri', e.target.value)}
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
              </div>
            </div>
          )}

          {/* Button customisation */}
          <div className="grid grid-cols-3 gap-4 pt-2 border-t border-border">
            <div>
              <label className="block text-sm font-medium mb-1">Button Text</label>
              <input value={form.buttonText} onChange={e => updateField('buttonText', e.target.value)}
                placeholder={`Sign in with ${form.name || '...'}`}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Button Color</label>
              <div className="flex items-center gap-2">
                <input type="color" value={form.buttonColor || '#000000'} onChange={e => updateField('buttonColor', e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer border border-input" />
                <input value={form.buttonColor} onChange={e => updateField('buttonColor', e.target.value)}
                  placeholder="#4285f4" className="flex-1 px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Icon URL</label>
              <input value={form.iconUrl} onChange={e => updateField('iconUrl', e.target.value)}
                placeholder="https://..." className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background" />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={handleSave}
              disabled={saving || !form.name || !form.issuerUrl || !form.clientId || (!editingId && !form.slug)}
              className="px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : editingId ? 'Update' : 'Add Provider'}
            </button>
            <button
              onClick={() => { setShowForm(false); setEditingId(null); setForm(emptyForm); }}
              className="px-4 py-1.5 text-sm rounded-md border border-input hover:bg-accent transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
