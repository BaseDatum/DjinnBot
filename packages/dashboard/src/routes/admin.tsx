import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  ShieldCheck,
  Users,
  Share2,
  CheckCircle,
  Container,
  Lock,
  Plus,
  Trash2,
  Loader2,
} from 'lucide-react';
import { SecretsSettings } from '@/components/settings/SecretsSettings';
import { NestedSidebar } from '@/components/layout/NestedSidebar';
import type { NestedSidebarItem } from '@/components/layout/NestedSidebar';
import { SearchableCombobox } from '@/components/ui/SearchableCombobox';
import type { ComboboxOption } from '@/components/ui/SearchableCombobox';
import { fetchModelProviders, type ModelProvider } from '@/lib/api';

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});

type AdminTab = 'users' | 'sharing' | 'approvals' | 'runtime' | 'secrets';

const NAV_ITEMS: NestedSidebarItem[] = [
  { key: 'users', label: 'Users', icon: Users },
  { key: 'sharing', label: 'Key Sharing', icon: Share2 },
  { key: 'approvals', label: 'Approvals', icon: CheckCircle },
  { key: 'runtime', label: 'Agent Runtime', icon: Container },
  { key: 'secrets', label: 'Instance Secrets', icon: Lock },
];

interface UserItem {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  isActive: boolean;
  slackId: string | null;
  createdAt: number;
}

interface PendingItem {
  id: string;
  type: 'skill' | 'mcp';
  name: string;
  description: string;
  submittedByUserId: string | null;
  createdAt: number;
}

function AdminPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [users, setUsers] = useState<UserItem[]>([]);
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sharedProviders, setSharedProviders] = useState<Array<{id: string; adminUserId: string; providerId: string; targetUserId: string | null; createdAt: number}>>([]);
  const [runtimeImage, setRuntimeImage] = useState('');
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [newShareProvider, setNewShareProvider] = useState('');
  const [newShareUser, setNewShareUser] = useState('');
  const [sharingLoading, setShareLoading] = useState(false);
  const [providerOptions, setProviderOptions] = useState<ComboboxOption[]>([]);
  const [userOptions, setUserOptions] = useState<ComboboxOption[]>([]);

  // Redirect non-admins
  useEffect(() => {
    if (user && !user.isAdmin) {
      navigate({ to: '/' as any });
    }
  }, [user, navigate]);

  // Load users
  useEffect(() => {
    if (activeTab === 'users') {
      authFetch(`${API_BASE}/admin/users`)
        .then((res) => res.json())
        .then(setUsers)
        .catch(() => toast.error('Failed to load users'))
        .finally(() => setLoading(false));
    }
  }, [activeTab]);

  // Load shared providers + provider options + user options
  useEffect(() => {
    if (activeTab === 'sharing') {
      setShareLoading(true);
      Promise.all([
        authFetch(`${API_BASE}/admin/shared-providers`).then((r) => r.json()),
        fetchModelProviders(),
        authFetch(`${API_BASE}/admin/users`).then((r) => r.json()),
      ])
        .then(([shares, providers, allUsers]) => {
          setSharedProviders(shares);
          setProviderOptions(
            (providers as ModelProvider[])
              .filter((p: ModelProvider) => p.configured)
              .map((p: ModelProvider) => ({
                value: p.providerId,
                label: p.name,
                sublabel: p.configured ? 'Configured' : 'Not configured',
              })),
          );
          setUserOptions([
            { value: '', label: 'All users (broadcast)', sublabel: 'Share with everyone' },
            ...(allUsers as UserItem[]).map((u: UserItem) => ({
              value: u.id,
              label: u.displayName || u.email,
              sublabel: u.email,
            })),
          ]);
        })
        .catch(() => toast.error('Failed to load sharing data'))
        .finally(() => setShareLoading(false));
    }
  }, [activeTab]);

  // Load runtime settings
  useEffect(() => {
    if (activeTab === 'runtime') {
      authFetch(`${API_BASE}/settings/`)
        .then((res) => res.json())
        .then((data: any) => setRuntimeImage(data.agentRuntimeImage || ''))
        .catch(() => {});
    }
  }, [activeTab]);

  // Load pending approvals
  useEffect(() => {
    if (activeTab === 'approvals') {
      setLoading(true);
      authFetch(`${API_BASE}/admin/pending-approvals`)
        .then((res) => res.json())
        .then(setPendingItems)
        .catch(() => toast.error('Failed to load pending approvals'))
        .finally(() => setLoading(false));
    }
  }, [activeTab]);

  const handleApprove = async (type: string, id: string) => {
    try {
      const res = await authFetch(`${API_BASE}/admin/${type === 'skill' ? 'skills' : 'mcp'}/${id}/approve`, {
        method: 'PATCH',
      });
      if (res.ok) {
        setPendingItems((items) => items.filter((i) => i.id !== id));
        toast.success(`${type === 'skill' ? 'Skill' : 'MCP server'} approved`);
      }
    } catch {
      toast.error('Failed to approve');
    }
  };

  const handleReject = async (type: string, id: string) => {
    try {
      const res = await authFetch(`${API_BASE}/admin/${type === 'skill' ? 'skills' : 'mcp'}/${id}/reject`, {
        method: 'PATCH',
      });
      if (res.ok) {
        setPendingItems((items) => items.filter((i) => i.id !== id));
        toast.success(`${type === 'skill' ? 'Skill' : 'MCP server'} rejected`);
      }
    } catch {
      toast.error('Failed to reject');
    }
  };

  const handleToggleActive = async (userId: string, isActive: boolean) => {
    try {
      const res = await authFetch(`${API_BASE}/admin/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, isActive } : u)));
        toast.success(`User ${isActive ? 'activated' : 'deactivated'}`);
      }
    } catch {
      toast.error('Failed to update user');
    }
  };

  const handleToggleAdmin = async (userId: string, isAdmin: boolean) => {
    try {
      const res = await authFetch(`${API_BASE}/admin/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAdmin }),
      });
      if (res.ok) {
        setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, isAdmin } : u)));
        toast.success(`User role updated`);
      }
    } catch {
      toast.error('Failed to update user');
    }
  };

  if (!user?.isAdmin) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 md:px-8 md:pt-8 md:pb-4 shrink-0">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-8 w-8" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Admin Panel</h1>
            <p className="text-muted-foreground">Manage users, key sharing, and system settings</p>
          </div>
        </div>
      </div>

      <NestedSidebar
        items={NAV_ITEMS}
        activeKey={activeTab}
        onSelect={(key) => setActiveTab(key as AdminTab)}
      >
        {/* ── Users ── */}
        {activeTab === 'users' && (
          <div className="max-w-5xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  Users
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Manage user accounts, roles, and access.
                </p>
              </div>
            </div>

            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">User</th>
                    <th className="text-left px-4 py-3 font-medium">Role</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Slack ID</th>
                    <th className="text-right px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="font-medium">{u.displayName || u.email}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleToggleAdmin(u.id, !u.isAdmin)}
                          disabled={u.id === user?.id}
                          className="text-xs px-2 py-0.5 rounded-full border hover:bg-accent disabled:opacity-50"
                        >
                          {u.isAdmin ? 'Admin' : 'User'}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${u.isActive ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-600'}`}>
                          {u.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {u.slackId || '-'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {u.id !== user?.id && (
                          <button
                            onClick={() => handleToggleActive(u.id, !u.isActive)}
                            className="text-xs px-2 py-1 rounded border hover:bg-accent"
                          >
                            {u.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Key Sharing ── */}
        {activeTab === 'sharing' && (
          <div className="max-w-5xl mx-auto space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Share2 className="h-5 w-5" />
                Key Sharing
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Share your instance-level provider API keys with users.
                Users can then use these keys for their sessions.
              </p>
            </div>
            {/* Add new share */}
            <div className="border rounded-lg p-4 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                New Share
              </p>
              <div className="flex gap-2 items-end">
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">Provider</Label>
                  <SearchableCombobox
                    options={providerOptions}
                    value={newShareProvider}
                    onChange={setNewShareProvider}
                    placeholder="Select a provider..."
                    searchPlaceholder="Search providers..."
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">Target User</Label>
                  <SearchableCombobox
                    options={userOptions}
                    value={newShareUser}
                    onChange={setNewShareUser}
                    placeholder="All users (broadcast)"
                    searchPlaceholder="Search by name or email..."
                  />
                </div>
                <Button
                  size="sm"
                  disabled={!newShareProvider.trim()}
                  onClick={async () => {
                    try {
                      const res = await authFetch(`${API_BASE}/admin/shared-providers`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          providerId: newShareProvider.trim(),
                          targetUserId: newShareUser.trim() || null,
                        }),
                      });
                      if (!res.ok) {
                        const err = await res.json();
                        throw new Error(err.detail || 'Failed');
                      }
                      const data = await res.json();
                      setSharedProviders((prev) => [data, ...prev]);
                      setNewShareProvider('');
                      setNewShareUser('');
                      toast.success('Provider shared');
                    } catch (err: any) {
                      toast.error(err?.message || 'Failed to share');
                    }
                  }}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Share
                </Button>
              </div>
            </div>

            {/* Active shares */}
            {sharingLoading ? (
              <div className="text-sm text-muted-foreground py-4 text-center">Loading...</div>
            ) : sharedProviders.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No provider keys shared yet.
              </p>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Provider</th>
                      <th className="text-left px-4 py-2 font-medium">Target</th>
                      <th className="text-right px-4 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {sharedProviders.map((sp) => {
                      const providerLabel = providerOptions.find((p) => p.value === sp.providerId)?.label ?? sp.providerId;
                      const targetLabel = sp.targetUserId
                        ? userOptions.find((u) => u.value === sp.targetUserId)?.label ?? sp.targetUserId
                        : null;
                      return (
                      <tr key={sp.id} className="hover:bg-muted/30">
                        <td className="px-4 py-2 text-xs">
                          <span className="font-medium">{providerLabel}</span>
                          <span className="text-muted-foreground ml-1 font-mono">({sp.providerId})</span>
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {targetLabel || <span className="text-blue-500">All users</span>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={async () => {
                              try {
                                await authFetch(`${API_BASE}/admin/shared-providers/${sp.id}`, { method: 'DELETE' });
                                setSharedProviders((prev) => prev.filter((s) => s.id !== sp.id));
                                toast.success('Share revoked');
                              } catch {
                                toast.error('Failed to revoke');
                              }
                            }}
                            className="text-destructive hover:underline text-xs inline-flex items-center gap-1"
                          >
                            <Trash2 className="h-3 w-3" />
                            Revoke
                          </button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Approvals ── */}
        {activeTab === 'approvals' && (
          <div className="max-w-5xl mx-auto space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <CheckCircle className="h-5 w-5" />
                Pending Approvals
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Skills and MCP servers submitted by users awaiting your review.
              </p>
            </div>

            {pendingItems.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No pending approvals.
              </p>
            ) : (
              <div className="space-y-3">
                {pendingItems.map((item) => (
                  <div key={`${item.type}-${item.id}`} className="border rounded-lg p-4 flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted font-medium uppercase">
                          {item.type}
                        </span>
                        <span className="font-medium">{item.name}</span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">{item.description}</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => handleApprove(item.type, item.id)}
                        className="text-xs px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => handleReject(item.type, item.id)}
                        className="text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Agent Runtime ── */}
        {activeTab === 'runtime' && (
          <div className="max-w-5xl mx-auto space-y-6">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Container className="h-5 w-5" />
                Agent Runtime
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Configure the Docker image used to spawn agent sandbox containers.
                This is a system-wide setting.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="adminRuntimeImage" className="flex items-center gap-2">
                Agent Runtime Image
              </Label>
              <p className="text-xs text-muted-foreground mb-2">
                Docker image reference for agent containers (e.g.{' '}
                <code className="bg-muted px-1 py-0.5 rounded text-xs">ghcr.io/basedatum/djinnbot/agent-runtime:latest</code>).
                When empty, the engine uses the default GHCR image.
                Changes take effect on the next agent execution.
              </p>
              <div className="flex gap-2 max-w-lg">
                <Input
                  id="adminRuntimeImage"
                  value={runtimeImage}
                  onChange={(e) => setRuntimeImage(e.target.value)}
                  placeholder="ghcr.io/basedatum/djinnbot/agent-runtime:latest"
                  className="font-mono"
                />
                <Button
                  disabled={runtimeSaving}
                  onClick={async () => {
                    setRuntimeSaving(true);
                    try {
                      const res = await authFetch(`${API_BASE}/settings/`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ agentRuntimeImage: runtimeImage }),
                      });
                      if (!res.ok) throw new Error('Failed');
                      toast.success('Runtime image updated');
                    } catch {
                      toast.error('Failed to save');
                    } finally {
                      setRuntimeSaving(false);
                    }
                  }}
                >
                  {runtimeSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Instance Secrets ── */}
        {activeTab === 'secrets' && (
          <div className="max-w-5xl mx-auto space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Lock className="h-5 w-5" />
                Instance Secrets
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Create and manage instance-level secrets, then grant them to users.
                Users can then grant these secrets to agents.
              </p>
            </div>
            <SecretsSettings />
          </div>
        )}
      </NestedSidebar>
    </div>
  );
}
