import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Hash,
  User,
} from 'lucide-react';

interface Props {
  projectId: string;
  currentChannelId?: string;
  currentNotifyUserId?: string;
  onUpdate: () => void;
}

export function SlackSettings({
  projectId,
  currentChannelId,
  currentNotifyUserId,
  onUpdate,
}: Props) {
  const [channelId, setChannelId] = useState(currentChannelId || '');
  const [notifyUserId, setNotifyUserId] = useState(currentNotifyUserId || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Sync when props change (e.g. after re-fetch)
  useEffect(() => {
    setChannelId(currentChannelId || '');
    setNotifyUserId(currentNotifyUserId || '');
  }, [currentChannelId, currentNotifyUserId]);

  const hasChanges =
    channelId !== (currentChannelId || '') ||
    notifyUserId !== (currentNotifyUserId || '');

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await authFetch(
        `${API_BASE}/projects/${projectId}/slack`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slack_channel_id: channelId || null,
            slack_notify_user_id: notifyUserId || null,
          }),
        }
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Failed to save Slack settings');
      }

      setSuccess('Slack settings saved!');
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setChannelId('');
    setNotifyUserId('');
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await authFetch(
        `${API_BASE}/projects/${projectId}/slack`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slack_channel_id: null,
            slack_notify_user_id: null,
          }),
        }
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Failed to clear Slack settings');
      }

      setSuccess('Slack settings cleared.');
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear');
    } finally {
      setSaving(false);
    }
  };

  const isConfigured = Boolean(currentChannelId || currentNotifyUserId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.52-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.52V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.522 2.522v6.312zm-2.522 10.124a2.528 2.528 0 0 1 2.522 2.52A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.521-2.522v-2.52h2.521zm0-1.271a2.527 2.527 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.522h-6.313z" />
          </svg>
          Slack Notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Configure where pipeline run updates are posted in Slack. Both fields
          are required for streaming updates in channel threads.
        </p>

        {/* Channel ID */}
        <div>
          <label className="text-sm font-medium mb-2 flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5 text-muted-foreground" />
            Channel ID
          </label>
          <Input
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            placeholder="C0123456789"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">
            The Slack channel ID (not name) where run threads will be posted.
            Find it in Slack: right-click channel &gt; View channel details &gt;
            scroll to bottom.
          </p>
        </div>

        {/* Notify User ID */}
        <div>
          <label className="text-sm font-medium mb-2 flex items-center gap-1.5">
            <User className="w-3.5 h-3.5 text-muted-foreground" />
            Recipient User ID
          </label>
          <Input
            value={notifyUserId}
            onChange={(e) => setNotifyUserId(e.target.value)}
            placeholder="U0123456789"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Your Slack user ID, used as the recipient for streaming step updates.
            Find it in Slack: click your profile &gt; three dots menu &gt; Copy
            member ID.
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            size="sm"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : null}
            Save
          </Button>
          {isConfigured && (
            <Button
              onClick={handleClear}
              disabled={saving}
              variant="outline"
              size="sm"
            >
              Clear
            </Button>
          )}
        </div>

        {/* Status Messages */}
        {error && (
          <Alert variant="destructive">
            <XCircle className="w-4 h-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert>
            <CheckCircle2 className="w-4 h-4" />
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
