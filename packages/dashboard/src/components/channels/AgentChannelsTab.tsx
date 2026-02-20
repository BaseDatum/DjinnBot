import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Loader2,
  Trash2,
  Key,
} from 'lucide-react';
import { toast } from 'sonner';
import { fetchAgentChannels, upsertAgentChannel, removeAgentChannel } from '@/lib/api';
import type { AgentChannel } from '@/lib/api';

interface ChannelCardProps {
  agentId: string;
  channel: AgentChannel;
  onUpdate: (updated: AgentChannel) => void;
  onRemove: (channelId: string) => void;
}

function ChannelCard({ agentId, channel, onUpdate, onRemove }: ChannelCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [primaryToken, setPrimaryToken] = useState('');
  const [secondaryToken, setSecondaryToken] = useState('');
  const [showPrimary, setShowPrimary] = useState(false);
  const [showSecondary, setShowSecondary] = useState(false);
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const canSave =
    (primaryToken.trim() || channel.configured) &&
    (secondaryToken.trim() || channel.configured);

  const handleSave = async () => {
    if (!primaryToken.trim() && !channel.configured) {
      toast.error(`Please enter a ${channel.primaryTokenLabel}`);
      return;
    }
    if (!secondaryToken.trim() && !channel.configured) {
      toast.error(`Please enter a ${channel.secondaryTokenLabel}`);
      return;
    }
    setSaving(true);
    try {
      const extraConfig = Object.fromEntries(
        Object.entries(extraValues).filter(([, v]) => v.trim().length > 0),
      );
      const updated = await upsertAgentChannel(agentId, channel.channel, {
        enabled: true,
        ...(primaryToken.trim() ? { primaryToken: primaryToken.trim() } : {}),
        ...(secondaryToken.trim() ? { secondaryToken: secondaryToken.trim() } : {}),
        ...(Object.keys(extraConfig).length > 0 ? { extraConfig } : {}),
      });
      setPrimaryToken('');
      setSecondaryToken('');
      setExtraValues({});
      toast.success(`${channel.name} configured`);
      onUpdate(updated);
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await removeAgentChannel(agentId, channel.channel);
      toast.success(`${channel.name} removed`);
      onRemove(channel.channel);
    } catch (err) {
      toast.error(`Failed to remove: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRemoving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!channel.configured) {
      toast.error('Configure credentials first');
      return;
    }
    setSaving(true);
    try {
      const updated = await upsertAgentChannel(agentId, channel.channel, {
        enabled: !channel.enabled,
      });
      onUpdate(updated);
    } catch (err) {
      toast.error('Failed to update');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base">{channel.name}</CardTitle>
              {channel.configured ? (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-green-500/50 text-green-500">
                  <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                  <XCircle className="h-2.5 w-2.5 mr-1" />
                  Not connected
                </Badge>
              )}
              {channel.configured && !channel.enabled && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  Disabled
                </Badge>
              )}
            </div>
            <CardDescription className="text-xs">{channel.description}</CardDescription>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {channel.configured && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleToggleEnabled}
                  disabled={saving}
                  className="h-7 text-xs"
                >
                  {channel.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleRemove}
                  disabled={removing}
                  className="h-7 w-7 text-destructive hover:text-destructive"
                >
                  {removing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </>
            )}
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Masked token hints */}
        {channel.configured && (channel.maskedPrimaryToken || channel.maskedSecondaryToken) && (
          <div className="flex flex-col gap-1 mt-2">
            {channel.maskedPrimaryToken && (
              <div className="flex items-center gap-2">
                <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <code className="text-xs text-muted-foreground font-mono">
                  {channel.primaryTokenLabel}: {channel.maskedPrimaryToken}
                </code>
              </div>
            )}
            {channel.maskedSecondaryToken && (
              <div className="flex items-center gap-2">
                <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <code className="text-xs text-muted-foreground font-mono">
                  {channel.secondaryTokenLabel}: {channel.maskedSecondaryToken}
                </code>
              </div>
            )}
            {channel.maskedExtra &&
              Object.entries(channel.maskedExtra).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2">
                  <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <code className="text-xs text-muted-foreground font-mono">
                    {key}: {value}
                  </code>
                </div>
              ))}
          </div>
        )}
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 space-y-4">
          {/* How to get credentials */}
          <div className="rounded-md bg-muted/50 px-3 py-2.5 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">How to get credentials</p>
            <p className="text-xs text-muted-foreground">
              Visit{' '}
              <a
                href={channel.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                {channel.docsUrl}
                <ExternalLink className="h-3 w-3 ml-0.5" />
              </a>{' '}
              to create or manage your app.
            </p>
            <p className="text-xs text-muted-foreground">
              Set tokens here or via environment variables — env vars are synced to the database on
              engine startup and will not overwrite values you set through the UI.
            </p>
          </div>

          {/* Primary token */}
          <div className="space-y-2">
            <Label className="text-sm">
              {channel.configured ? `Update ${channel.primaryTokenLabel}` : channel.primaryTokenLabel}
            </Label>
            <p className="text-xs text-muted-foreground">{channel.primaryTokenHint}</p>
            <div className="relative">
              <Input
                type={showPrimary ? 'text' : 'password'}
                value={primaryToken}
                onChange={(e) => setPrimaryToken(e.target.value)}
                placeholder={
                  channel.configured
                    ? '(leave blank to keep existing)'
                    : channel.primaryTokenEnvVarSuffix === 'BOT_TOKEN'
                    ? 'xoxb-...'
                    : 'Token value'
                }
                className="font-mono text-sm pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPrimary(!showPrimary)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPrimary ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Secondary token */}
          <div className="space-y-2">
            <Label className="text-sm">
              {channel.configured
                ? `Update ${channel.secondaryTokenLabel}`
                : channel.secondaryTokenLabel}
            </Label>
            <p className="text-xs text-muted-foreground">{channel.secondaryTokenHint}</p>
            <div className="relative">
              <Input
                type={showSecondary ? 'text' : 'password'}
                value={secondaryToken}
                onChange={(e) => setSecondaryToken(e.target.value)}
                placeholder={
                  channel.configured
                    ? '(leave blank to keep existing)'
                    : channel.secondaryTokenEnvVarSuffix === 'APP_TOKEN'
                    ? 'xapp-...'
                    : 'Token value'
                }
                className="font-mono text-sm pr-10"
              />
              <button
                type="button"
                onClick={() => setShowSecondary(!showSecondary)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showSecondary ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Extra fields */}
          {channel.extraFields.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground px-2">Optional</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              {channel.extraFields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label className="text-sm">
                    {field.label}
                    <span className="text-muted-foreground ml-1 text-xs font-normal">
                      ({field.key})
                    </span>
                  </Label>
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                  <Input
                    type={field.secret ? 'password' : 'text'}
                    value={extraValues[field.key] ?? ''}
                    onChange={(e) =>
                      setExtraValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={
                      channel.maskedExtra?.[field.key]
                        ? `(configured: ${channel.maskedExtra[field.key]})`
                        : field.placeholder
                    }
                    className="font-mono text-sm"
                  />
                </div>
              ))}
            </div>
          )}

          <Button
            onClick={handleSave}
            disabled={saving || !canSave}
            className="w-full"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : channel.configured ? (
              'Update Configuration'
            ) : (
              'Save Configuration'
            )}
          </Button>
        </CardContent>
      )}
    </Card>
  );
}

interface AgentChannelsTabProps {
  agentId: string;
}

export function AgentChannelsTab({ agentId }: AgentChannelsTabProps) {
  const [channels, setChannels] = useState<AgentChannel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAgentChannels(agentId)
      .then(setChannels)
      .catch(() => toast.error('Failed to load channel configuration'))
      .finally(() => setLoading(false));
  }, [agentId]);

  const handleUpdate = (updated: AgentChannel) => {
    setChannels((prev) =>
      prev.map((c) => (c.channel === updated.channel ? updated : c)),
    );
  };

  const handleRemove = (channelId: string) => {
    setChannels((prev) =>
      prev.map((c) =>
        c.channel === channelId
          ? { ...c, configured: false, enabled: false, maskedPrimaryToken: undefined, maskedSecondaryToken: undefined, maskedExtra: undefined }
          : c,
      ),
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const connectedCount = channels.filter((c) => c.configured && c.enabled).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Channels</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect this agent to messaging platforms. Tokens are stored in the database and never
          exposed in full after saving. You can also set them via environment variables — env vars
          are synced to the database on engine startup.
        </p>
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {connectedCount > 0 ? (
          <>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <span>
              {connectedCount} channel{connectedCount !== 1 ? 's' : ''} connected
            </span>
          </>
        ) : (
          <>
            <XCircle className="h-4 w-4 text-muted-foreground" />
            <span>No channels connected — connect Slack to enable real-time messaging</span>
          </>
        )}
      </div>

      <div className="space-y-3">
        {channels.map((channel) => (
          <ChannelCard
            key={channel.channel}
            agentId={agentId}
            channel={channel}
            onUpdate={handleUpdate}
            onRemove={handleRemove}
          />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Tokens are stored in the database and never exposed in full after saving. Environment
        variables (e.g.{' '}
        <code className="text-[11px] bg-muted px-1 py-0.5 rounded font-mono">
          SLACK_&lt;AGENT&gt;_BOT_TOKEN
        </code>
        ) are synced to the database on engine startup but will not overwrite credentials you set
        through this UI.
      </p>
    </div>
  );
}
