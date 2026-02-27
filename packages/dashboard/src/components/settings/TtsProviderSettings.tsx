/**
 * TtsProviderSettings — per-user TTS API key management.
 *
 * Displayed on the Settings page under the "TTS Providers" tab.
 * Mirrors the pattern of UserProviderSettings but for TTS providers (Fish Audio).
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
  const [providers, setProviders] = useState<TtsProviderItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadProviders = async () => {
    try {
      const res = await authFetch(`${API_BASE}/settings/tts-providers`);
      if (res.ok) {
        const data = await res.json();
        setProviders(data);
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

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {providers.map((provider) => (
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
