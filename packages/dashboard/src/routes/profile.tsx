import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { User, MessageSquare, Shield } from 'lucide-react';
import { NestedSidebar } from '@/components/layout/NestedSidebar';
import type { NestedSidebarItem } from '@/components/layout/NestedSidebar';
import { TwoFactorSettings } from '@/components/settings/TwoFactorSettings';
import { APIKeySettings } from '@/components/settings/APIKeySettings';
import { useAutoSave } from '@/hooks/useAutoSave';

export const Route = createFileRoute('/profile')({
  component: ProfilePage,
});

type ProfileTab = 'info' | 'slack' | 'auth';

// Profile is identity-only. Credentials and configuration live in /settings.
const NAV_ITEMS: NestedSidebarItem[] = [
  { key: 'info', label: 'Profile Info', icon: User },
  { key: 'slack', label: 'Slack', icon: MessageSquare },
  { key: 'auth', label: 'Authentication', icon: Shield },
];

interface UserProfile {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  slackId: string | null;
  totpEnabled: boolean;
}

function ProfilePage() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ProfileTab>('info');
  const [profileEdited, setProfileEdited] = useState(false);

  useEffect(() => {
    authFetch(`${API_BASE}/users/me/profile`)
      .then((res) => res.json())
      .then((data) => {
        setProfile(data);
        setLoading(false);
      })
      .catch(() => {
        toast.error('Failed to load profile');
        setLoading(false);
      });
  }, []);

  const { saveState } = useAutoSave({
    value: profileEdited ? profile : null,
    onSave: async (value) => {
      if (!value) return;
      const res = await authFetch(`${API_BASE}/users/me/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: value.displayName,
          slackId: value.slackId,
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
    },
    delay: 600,
  });

  const handleChange = (field: keyof UserProfile, value: string) => {
    if (!profile) return;
    setProfile({ ...profile, [field]: value });
    setProfileEdited(true);
  };

  if (loading || !profile) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 md:px-8 md:pt-8 md:pb-4 shrink-0">
        <div className="flex items-center gap-3">
          <User className="h-8 w-8" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Profile</h1>
            <p className="text-muted-foreground">Your account identity</p>
          </div>
        </div>
      </div>

      <NestedSidebar
        items={NAV_ITEMS}
        activeKey={activeTab}
        onSelect={(key) => setActiveTab(key as ProfileTab)}
      >
        {/* ── Profile Info ── */}
        {activeTab === 'info' && (
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <User className="h-5 w-5" />
                  Profile Information
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Your account details.
                </p>
              </div>
              {saveState === 'saving' && <span className="text-xs text-muted-foreground animate-pulse">Saving...</span>}
              {saveState === 'saved' && <span className="text-xs text-green-500">&#x2713; Saved</span>}
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Email</Label>
                <Input value={profile.email} disabled className="max-w-sm" />
                <p className="text-xs text-muted-foreground">Email cannot be changed.</p>
              </div>
              <div className="space-y-2">
                <Label>Display Name</Label>
                <Input
                  value={profile.displayName || ''}
                  onChange={(e) => handleChange('displayName', e.target.value)}
                  placeholder="Your display name"
                  className="max-w-sm"
                />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <div className="text-sm">
                  {profile.isAdmin ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">
                      Admin
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-xs font-medium">
                      User
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Slack ── */}
        {activeTab === 'slack' && (
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <MessageSquare className="h-5 w-5" />
                  Slack
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Link your Slack account so agents can identify you in Slack messages.
                </p>
              </div>
              {saveState === 'saving' && <span className="text-xs text-muted-foreground animate-pulse">Saving...</span>}
              {saveState === 'saved' && <span className="text-xs text-green-500">&#x2713; Saved</span>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="slackId">Slack Member ID</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Your Slack member ID (e.g. U0123456789). Find it in Slack under your profile
                &rarr; "Copy member ID". This is required for agents to recognize your Slack messages.
              </p>
              <Input
                id="slackId"
                value={profile.slackId || ''}
                onChange={(e) => handleChange('slackId', e.target.value)}
                placeholder="U0123456789"
                className="max-w-sm font-mono"
              />
            </div>
          </div>
        )}

        {/* ── Authentication ── */}
        {activeTab === 'auth' && (
          <div className="max-w-3xl mx-auto space-y-6">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Authentication
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Manage two-factor authentication and API keys.
              </p>
            </div>
            <TwoFactorSettings />
            <div className="border-t pt-6">
              <APIKeySettings />
            </div>
          </div>
        )}
      </NestedSidebar>
    </div>
  );
}
