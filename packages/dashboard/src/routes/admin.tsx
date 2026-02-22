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
  UserPlus,
  Eye,
  EyeOff,
  Layers,
  ClipboardList,
  Mail,
  Send,
  Clock,
  Check,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { SecretsSettings } from '@/components/settings/SecretsSettings';
import { ModelProvidersSettings } from '@/components/settings/ModelProvidersSettings';
import { NestedSidebar } from '@/components/layout/NestedSidebar';
import type { NestedSidebarItem } from '@/components/layout/NestedSidebar';
import { SearchableCombobox } from '@/components/ui/SearchableCombobox';
import type { ComboboxOption } from '@/components/ui/SearchableCombobox';
import { fetchModelProviders, type ModelProvider } from '@/lib/api';

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});

type AdminTab = 'users' | 'providers' | 'sharing' | 'approvals' | 'runtime' | 'secrets' | 'waitlist' | 'email';

const NAV_ITEMS: NestedSidebarItem[] = [
  { key: 'users', label: 'Users', icon: Users },
  { key: 'waitlist', label: 'Waitlist', icon: ClipboardList },
  { key: 'email', label: 'Email Settings', icon: Mail },
  { key: 'providers', label: 'Model Providers', icon: Layers },
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

  // Waitlist state
  const [waitlistEntries, setWaitlistEntries] = useState<Array<{id: string; email: string; status: string; invitedAt: number | null; registeredAt: number | null; createdAt: number}>>([]);
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [invitingId, setInvitingId] = useState<string | null>(null);

  // Email settings state
  const [emailSettings, setEmailSettings] = useState({
    smtpHost: '',
    smtpPort: 587,
    smtpUsername: '',
    smtpPassword: '',
    smtpUseTls: true,
    fromEmail: '',
    fromName: 'DjinnBot',
    configured: false,
  });
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailSaving, setEmailSaving] = useState(false);
  const [testEmailAddr, setTestEmailAddr] = useState('');
  const [testingSend, setTestingSend] = useState(false);

  // Add user dialog state
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserDisplayName, setNewUserDisplayName] = useState('');
  const [newUserIsAdmin, setNewUserIsAdmin] = useState(false);
  const [addUserLoading, setAddUserLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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

  // Load waitlist entries
  useEffect(() => {
    if (activeTab === 'waitlist') {
      setWaitlistLoading(true);
      authFetch(`${API_BASE}/waitlist/`)
        .then((res) => res.json())
        .then(setWaitlistEntries)
        .catch(() => toast.error('Failed to load waitlist'))
        .finally(() => setWaitlistLoading(false));
    }
  }, [activeTab]);

  // Load email settings
  useEffect(() => {
    if (activeTab === 'email') {
      setEmailLoading(true);
      authFetch(`${API_BASE}/waitlist/email-settings`)
        .then((res) => res.json())
        .then(setEmailSettings)
        .catch(() => toast.error('Failed to load email settings'))
        .finally(() => setEmailLoading(false));
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

  const handleAddUser = async () => {
    const email = newUserEmail.trim();
    const password = newUserPassword;
    if (!email || !password) {
      toast.error('Email and password are required');
      return;
    }
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    setAddUserLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          displayName: newUserDisplayName.trim() || null,
          isAdmin: newUserIsAdmin,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to create user');
      }
      const created = await res.json();
      setUsers((prev) => [created, ...prev]);
      setAddUserOpen(false);
      setNewUserEmail('');
      setNewUserPassword('');
      setNewUserDisplayName('');
      setNewUserIsAdmin(false);
      setShowPassword(false);
      toast.success(`User ${created.email} created`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create user');
    } finally {
      setAddUserLoading(false);
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

  const handleInvite = async (entryId: string) => {
    setInvitingId(entryId);
    try {
      const res = await authFetch(`${API_BASE}/waitlist/${entryId}/invite`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Failed to invite');
      }
      setWaitlistEntries((prev) => prev.map((e) => e.id === entryId ? { ...e, status: 'invited', invitedAt: Date.now() } : e));
      toast.success('Invite sent!');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to send invite');
    } finally {
      setInvitingId(null);
    }
  };

  const handleDeleteWaitlistEntry = async (entryId: string) => {
    try {
      await authFetch(`${API_BASE}/waitlist/${entryId}`, { method: 'DELETE' });
      setWaitlistEntries((prev) => prev.filter((e) => e.id !== entryId));
      toast.success('Entry removed');
    } catch {
      toast.error('Failed to remove entry');
    }
  };

  const handleSaveEmailSettings = async () => {
    setEmailSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/waitlist/email-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(emailSettings),
      });
      if (!res.ok) throw new Error('Failed to save');
      toast.success('Email settings saved');
      // Reload to get masked password
      const updated = await authFetch(`${API_BASE}/waitlist/email-settings`).then((r) => r.json());
      setEmailSettings(updated);
    } catch {
      toast.error('Failed to save email settings');
    } finally {
      setEmailSaving(false);
    }
  };

  const handleTestEmail = async () => {
    if (!testEmailAddr.trim()) {
      toast.error('Enter a recipient email address');
      return;
    }
    setTestingSend(true);
    try {
      const res = await authFetch(`${API_BASE}/waitlist/email-settings/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientEmail: testEmailAddr.trim() }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Test email failed');
      }
      toast.success(`Test email sent to ${testEmailAddr}`);
    } catch (err: any) {
      toast.error(err?.message || 'Test email failed');
    } finally {
      setTestingSend(false);
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
              <Dialog open={addUserOpen} onOpenChange={(open) => {
                setAddUserOpen(open);
                if (!open) {
                  setNewUserEmail('');
                  setNewUserPassword('');
                  setNewUserDisplayName('');
                  setNewUserIsAdmin(false);
                  setShowPassword(false);
                }
              }}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <UserPlus className="h-4 w-4 mr-1" />
                    Add User
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add User</DialogTitle>
                    <DialogDescription>
                      Create a new user account. They can sign in with the email and password you set here.
                    </DialogDescription>
                  </DialogHeader>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleAddUser();
                    }}
                    className="space-y-4"
                  >
                    <div className="space-y-2">
                      <Label htmlFor="newUserEmail">Email</Label>
                      <Input
                        id="newUserEmail"
                        type="email"
                        required
                        placeholder="user@example.com"
                        value={newUserEmail}
                        onChange={(e) => setNewUserEmail(e.target.value)}
                        autoFocus
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="newUserDisplayName">Display Name</Label>
                      <Input
                        id="newUserDisplayName"
                        placeholder="Optional"
                        value={newUserDisplayName}
                        onChange={(e) => setNewUserDisplayName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="newUserPassword">Password</Label>
                      <div className="relative">
                        <Input
                          id="newUserPassword"
                          type={showPassword ? 'text' : 'password'}
                          required
                          minLength={8}
                          placeholder="Min 8 characters"
                          value={newUserPassword}
                          onChange={(e) => setNewUserPassword(e.target.value)}
                          className="pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          tabIndex={-1}
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={newUserIsAdmin}
                        onClick={() => setNewUserIsAdmin((v) => !v)}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${newUserIsAdmin ? 'bg-primary' : 'bg-muted'}`}
                      >
                        <span
                          className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${newUserIsAdmin ? 'translate-x-4' : 'translate-x-0'}`}
                        />
                      </button>
                      <Label className="cursor-pointer" onClick={() => setNewUserIsAdmin((v) => !v)}>
                        Admin role
                      </Label>
                    </div>
                    <DialogFooter>
                      <Button type="submit" disabled={addUserLoading}>
                        {addUserLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-1" />
                        ) : (
                          <UserPlus className="h-4 w-4 mr-1" />
                        )}
                        Create User
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
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

        {/* ── Model Providers ── */}
        {activeTab === 'providers' && (
          <div className="max-w-5xl mx-auto space-y-2">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Layers className="h-5 w-5" />
                Model Providers
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Configure instance-level API keys for AI model providers.
                These keys can be shared with users via Key Sharing.
              </p>
            </div>
            <ModelProvidersSettings />
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

        {/* ── Waitlist ── */}
        {activeTab === 'waitlist' && (
          <div className="max-w-5xl mx-auto space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <ClipboardList className="h-5 w-5" />
                Waitlist
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                People who signed up to join DjinnBot. Send invites to grant access.
              </p>
            </div>

            {waitlistLoading ? (
              <div className="text-sm text-muted-foreground py-4 text-center">Loading...</div>
            ) : waitlistEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No waitlist signups yet.
              </p>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">Email</th>
                      <th className="text-left px-4 py-3 font-medium">Status</th>
                      <th className="text-left px-4 py-3 font-medium">Signed Up</th>
                      <th className="text-right px-4 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {waitlistEntries.map((entry) => (
                      <tr key={entry.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-medium">{entry.email}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            entry.status === 'invited'
                              ? 'bg-blue-500/10 text-blue-600'
                              : entry.status === 'registered'
                                ? 'bg-green-500/10 text-green-600'
                                : 'bg-yellow-500/10 text-yellow-600'
                          }`}>
                            {entry.status === 'waiting' && (
                              <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> Waiting</span>
                            )}
                            {entry.status === 'invited' && (
                              <span className="inline-flex items-center gap-1"><Send className="h-3 w-3" /> Invited</span>
                            )}
                            {entry.status === 'registered' && (
                              <span className="inline-flex items-center gap-1"><Check className="h-3 w-3" /> Registered</span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {new Date(entry.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-right space-x-2">
                          {entry.status === 'waiting' && (
                            <button
                              onClick={() => handleInvite(entry.id)}
                              disabled={invitingId === entry.id}
                              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1"
                            >
                              {invitingId === entry.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Send className="h-3 w-3" />
                              )}
                              Invite
                            </button>
                          )}
                          <button
                            onClick={() => handleDeleteWaitlistEntry(entry.id)}
                            className="text-destructive hover:underline text-xs inline-flex items-center gap-1"
                          >
                            <X className="h-3 w-3" />
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              {waitlistEntries.length} total &middot;{' '}
              {waitlistEntries.filter((e) => e.status === 'waiting').length} waiting &middot;{' '}
              {waitlistEntries.filter((e) => e.status === 'invited').length} invited
            </div>
          </div>
        )}

        {/* ── Email Settings ── */}
        {activeTab === 'email' && (
          <div className="max-w-5xl mx-auto space-y-6">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Mail className="h-5 w-5" />
                Email Settings
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Configure SMTP settings for sending invite emails and other notifications.
              </p>
            </div>

            {emailLoading ? (
              <div className="text-sm text-muted-foreground py-4 text-center">Loading...</div>
            ) : (
              <>
                <div className="space-y-4 max-w-lg">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="smtpHost">SMTP Host</Label>
                      <Input
                        id="smtpHost"
                        value={emailSettings.smtpHost}
                        onChange={(e) => setEmailSettings((s) => ({ ...s, smtpHost: e.target.value }))}
                        placeholder="smtp.gmail.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="smtpPort">Port</Label>
                      <Input
                        id="smtpPort"
                        type="number"
                        value={emailSettings.smtpPort}
                        onChange={(e) => setEmailSettings((s) => ({ ...s, smtpPort: parseInt(e.target.value) || 587 }))}
                        placeholder="587"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="smtpUsername">Username</Label>
                    <Input
                      id="smtpUsername"
                      value={emailSettings.smtpUsername}
                      onChange={(e) => setEmailSettings((s) => ({ ...s, smtpUsername: e.target.value }))}
                      placeholder="your-email@gmail.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="smtpPassword">Password / App Password</Label>
                    <Input
                      id="smtpPassword"
                      type="password"
                      value={emailSettings.smtpPassword}
                      onChange={(e) => setEmailSettings((s) => ({ ...s, smtpPassword: e.target.value }))}
                      placeholder="Enter password"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="fromEmail">From Email</Label>
                      <Input
                        id="fromEmail"
                        type="email"
                        value={emailSettings.fromEmail}
                        onChange={(e) => setEmailSettings((s) => ({ ...s, fromEmail: e.target.value }))}
                        placeholder="noreply@yourdomain.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="fromName">From Name</Label>
                      <Input
                        id="fromName"
                        value={emailSettings.fromName}
                        onChange={(e) => setEmailSettings((s) => ({ ...s, fromName: e.target.value }))}
                        placeholder="DjinnBot"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={emailSettings.smtpUseTls}
                      onClick={() => setEmailSettings((s) => ({ ...s, smtpUseTls: !s.smtpUseTls }))}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${emailSettings.smtpUseTls ? 'bg-primary' : 'bg-muted'}`}
                    >
                      <span
                        className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${emailSettings.smtpUseTls ? 'translate-x-4' : 'translate-x-0'}`}
                      />
                    </button>
                    <Label className="cursor-pointer" onClick={() => setEmailSettings((s) => ({ ...s, smtpUseTls: !s.smtpUseTls }))}>
                      Use TLS (STARTTLS)
                    </Label>
                  </div>
                  <Button onClick={handleSaveEmailSettings} disabled={emailSaving}>
                    {emailSaving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                    Save Settings
                  </Button>
                </div>

                {/* Test Send */}
                <div className="border-t pt-6 max-w-lg">
                  <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <Send className="h-4 w-4" />
                    Test Email
                  </h3>
                  <p className="text-xs text-muted-foreground mb-3">
                    Send a test email to verify your SMTP settings are working.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      type="email"
                      value={testEmailAddr}
                      onChange={(e) => setTestEmailAddr(e.target.value)}
                      placeholder="recipient@example.com"
                      className="flex-1"
                    />
                    <Button
                      onClick={handleTestEmail}
                      disabled={testingSend || !testEmailAddr.trim()}
                      variant="outline"
                    >
                      {testingSend ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />}
                      Send Test
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </NestedSidebar>
    </div>
  );
}
