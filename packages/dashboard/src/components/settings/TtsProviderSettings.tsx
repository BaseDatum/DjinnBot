/**
 * TtsProviderSettings — per-user TTS provider preference and API key management.
 *
 * Displayed on the Settings page under the "TTS Providers" tab.
 * Allows users to:
 * 1. Choose their preferred TTS provider (Fish Audio or Voicebox)
 * 2. Configure API keys for cloud providers (Fish Audio)
 */
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Loader2,
  Trash2,
  Key,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import { useAuth } from '@/hooks/useAuth';

interface TtsProviderItem {
  providerId: string;
  enabled: boolean;
  configured: boolean;
  maskedApiKey: string | null;
  name: string;
  description: string;
  docsUrl: string;
}

export function TtsProviderSettings() {
  const { user } = useAuth();
  const [providers, setProviders] = useState<TtsProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [preferredProvider, setPreferredProvider] = useState<string | null>(null);
  const [savingPref, setSavingPref] = useState(false);

  const loadProviders = async () => {
    try {
      const [providersRes, prefRes] = await Promise.all([
        authFetch(`${API_BASE}/settings/tts-providers`),
        user ? authFetch(`${API_BASE}/settings/user-tts-preference?user_id=${user.id}`) : Promise.resolve(null),
      ]);
      if (providersRes.ok) {
        setProviders(await providersRes.json());
      }
      if (prefRes && prefRes.ok) {
        const prefData = await prefRes.json();
        setPreferredProvider(prefData.defaultTtsProvider || null);
      }
    } catch (err) {
      console.error('Failed to load TTS providers:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProviders();
  }, []);

  const handleSetPreference = async (provider: string) => {
    if (!user) return;
    setSavingPref(true);
    try {
      if (provider === '') {
        // Clear preference — use admin default
        const res = await authFetch(`${API_BASE}/settings/user-tts-preference?user_id=${user.id}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          setPreferredProvider(null);
          toast.success('Using system default TTS provider');
        }
      } else {
        const res = await authFetch(`${API_BASE}/settings/user-tts-preference?user_id=${user.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultTtsProvider: provider }),
        });
        if (res.ok) {
          setPreferredProvider(provider);
          toast.success(`TTS provider set to ${provider === 'voicebox' ? 'Voicebox' : 'Fish Audio'}`);
        }
      }
    } catch {
      toast.error('Failed to update preference');
    } finally {
      setSavingPref(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Provider Preference */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Preferred TTS Provider</CardTitle>
          <CardDescription className="text-xs">
            Choose which TTS provider to use for your sessions. Leave on "System Default"
            to use the admin-configured provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <select
            value={preferredProvider || ''}
            onChange={(e) => handleSetPreference(e.target.value)}
            disabled={savingPref}
            className="flex h-9 w-64 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">System Default</option>
            <option value="fish-audio">Fish Audio (Cloud)</option>
            <option value="voicebox">Voicebox (Local)</option>
          </select>
        </CardContent>
      </Card>

      {/* API Key Cards (only show Fish Audio — Voicebox needs no key) */}
      {providers.filter(p => p.providerId === 'fish-audio').map((provider) => (
        <TtsProviderCard
          key={provider.providerId}
          provider={provider}
          onSaved={loadProviders}
        />
      ))}
    </div>
  );
}

function TtsProviderCard({
  provider,
  onSaved,
}: {
  provider: TtsProviderItem;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      const res = await authFetch(
        `${API_BASE}/settings/tts-providers/${provider.providerId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: provider.providerId,
            enabled: true,
            apiKey: apiKey.trim(),
          }),
        },
      );
      if (res.ok) {
        toast.success(`${provider.name} API key saved`);
        setApiKey('');
        onSaved();
      } else {
        toast.error('Failed to save API key');
      }
    } catch {
      toast.error('Failed to save API key');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await authFetch(
        `${API_BASE}/settings/tts-providers/${provider.providerId}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        toast.success(`${provider.name} API key removed`);
        onSaved();
      }
    } catch {
      toast.error('Failed to remove API key');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <CardTitle className="text-base">{provider.name}</CardTitle>
            {provider.configured ? (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-green-500/50 text-green-500">
                <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                Configured
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-orange-500/50 text-orange-500">
                <XCircle className="h-2.5 w-2.5 mr-1" />
                Not configured
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {provider.docsUrl && (
              <a
                href={provider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                Docs <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {provider.configured && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRemove}
                disabled={removing}
                className="h-7 px-2 text-destructive hover:text-destructive"
              >
                {removing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              </Button>
            )}
          </div>
        </div>
        <CardDescription className="text-xs">{provider.description}</CardDescription>
      </CardHeader>

      <CardContent className="pt-0">
        {provider.configured && provider.maskedApiKey && (
          <div className="flex items-center gap-2 mb-3 text-xs text-muted-foreground">
            <Key className="h-3 w-3" />
            <code className="font-mono">{provider.maskedApiKey}</code>
          </div>
        )}

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              type={showKey ? 'text' : 'password'}
              placeholder={provider.configured ? 'Replace API key...' : 'Enter Fish Audio API key...'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="text-sm pr-8"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!apiKey.trim() || saving}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
