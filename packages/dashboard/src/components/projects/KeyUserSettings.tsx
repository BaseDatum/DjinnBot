/**
 * KeyUserSettings — project-level setting for which user's API keys
 * are used for automated runs (pipeline steps, pulse sessions).
 */
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SearchableCombobox } from '@/components/ui/SearchableCombobox';
import type { ComboboxOption } from '@/components/ui/SearchableCombobox';
import { Key, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';

interface KeyUserSettingsProps {
  projectId: string;
  currentKeyUserId: string | null;
  onUpdate: () => void;
}

export function KeyUserSettings({ projectId, currentKeyUserId, onUpdate }: KeyUserSettingsProps) {
  const { user } = useAuth();
  const [keyUserId, setKeyUserId] = useState(currentKeyUserId || '');
  const [userOptions, setUserOptions] = useState<ComboboxOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load users for the dropdown (admin sees all, non-admin sees only themselves)
    const fetchUsers = async () => {
      try {
        if (user?.isAdmin) {
          const res = await authFetch(`${API_BASE}/admin/users`);
          if (res.ok) {
            const users = await res.json();
            setUserOptions([
              { value: '', label: 'System default (instance keys)', sublabel: 'No per-user resolution' },
              ...users.map((u: any) => ({
                value: u.id,
                label: u.displayName || u.email,
                sublabel: u.email,
              })),
            ]);
          }
        } else if (user) {
          // Non-admin: can only set themselves or clear
          setUserOptions([
            { value: '', label: 'System default (instance keys)', sublabel: 'No per-user resolution' },
            {
              value: user.id,
              label: user.displayName || user.email || 'Me',
              sublabel: user.email || undefined,
            },
          ]);
        }
      } catch {
        // Silently fail — dropdown will be empty
      } finally {
        setLoading(false);
      }
    };
    fetchUsers();
  }, [user]);

  useEffect(() => {
    setKeyUserId(currentKeyUserId || '');
  }, [currentKeyUserId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/projects/${projectId}/key-user`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key_user_id: keyUserId || null }),
      });
      if (!res.ok) throw new Error('Failed to save');
      toast.success('API key user updated');
      onUpdate();
    } catch {
      toast.error('Failed to update API key user');
    } finally {
      setSaving(false);
    }
  };

  const hasChanged = (keyUserId || '') !== (currentKeyUserId || '');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Key className="h-4 w-4" />
          API Key User
        </CardTitle>
        <CardDescription>
          Choose whose API keys are used for automated runs (pipeline steps and pulse sessions)
          in this project. When set, the selected user's personal or admin-shared provider keys
          are used. When unset, system-level instance keys are used.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading users...
          </div>
        ) : (
          <>
            <SearchableCombobox
              options={userOptions}
              value={keyUserId}
              onChange={setKeyUserId}
              placeholder="System default (instance keys)"
              searchPlaceholder="Search by name or email..."
            />
            {hasChanged && (
              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving} size="sm">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  Save
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
