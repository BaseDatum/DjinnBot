/**
 * UserProviderSettings — per-user API key management for model providers.
 *
 * Shows cards for each provider the user has configured (own key) and
 * read-only badges for admin-shared providers.
 */
import { useState, useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
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
  ChevronDown,
  ChevronUp,
  Loader2,
  Trash2,
  Key,
  Share2,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE, fetchModelProviders, type ModelProvider } from '@/lib/api';
import { authFetch } from '@/lib/auth';

interface UserProviderItem {
  providerId: string;
  enabled: boolean;
  configured: boolean;
  maskedApiKey: string | null;
  maskedExtraConfig: Record<string, string> | null;
  sharedByAdmin: boolean;
}

const PROVIDER_ORDER = [
  'opencode', 'xai', 'anthropic', 'openai', 'google', 'openrouter',
  'groq', 'zai', 'mistral', 'cerebras', 'minimax', 'kimi-coding',
  'azure-openai-responses', 'huggingface', 'minimax-cn',
];

function UserProviderCard({
  item,
  catalogName,
  catalogDescription,
  onRemove,
  onSaved,
}: {
  item: UserProviderItem;
  catalogName: string;
  catalogDescription: string;
  onRemove: (providerId: string) => void;
  onSaved: (updated: UserProviderItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (item.sharedByAdmin) {
    // Read-only shared provider row
    return (
      <Card className="opacity-80">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <CardTitle className="text-base">{catalogName}</CardTitle>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-blue-500/50 text-blue-500">
                <Share2 className="h-2.5 w-2.5 mr-1" />
                Shared by admin
              </Badge>
            </div>
          </div>
          <CardDescription className="text-xs">
            {catalogDescription} — This key is shared by an admin and cannot be edited.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const handleSave = async () => {
    if (!apiKey.trim()) {
      toast.error('Enter an API key');
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/users/me/providers/${item.providerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: item.providerId, enabled: true, apiKey: apiKey.trim() }),
      });
      if (!res.ok) throw new Error('Save failed');
      const data = await res.json();
      setApiKey('');
      toast.success(`${catalogName} key saved`);
      onSaved(data);
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await authFetch(`${API_BASE}/users/me/providers/${item.providerId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Delete failed');
      toast.success(`${catalogName} key removed`);
      onRemove(item.providerId);
    } catch (err) {
      toast.error(`Failed to remove: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base">{catalogName}</CardTitle>
              {item.configured ? (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-green-500/50 text-green-500">
                  <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                  <XCircle className="h-2.5 w-2.5 mr-1" />
                  Not set
                </Badge>
              )}
            </div>
            <CardDescription className="text-xs">{catalogDescription}</CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {item.configured && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRemove}
                disabled={removing}
                className="h-7 w-7 text-destructive hover:text-destructive"
              >
                {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            )}
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {item.configured && item.maskedApiKey && (
          <div className="flex items-center gap-2 mt-2">
            <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <code className="text-xs text-muted-foreground font-mono">{item.maskedApiKey}</code>
          </div>
        )}
      </CardHeader>
      {expanded && (
        <CardContent className="pt-0 space-y-4">
          <div className="space-y-2">
            <Label className="text-sm">
              {item.configured ? 'Update API Key' : 'API Key'}
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={item.configured ? '(leave blank to keep existing)' : 'Enter your API key'}
                  className="font-mono text-sm pr-10"
                  onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button onClick={handleSave} disabled={saving || !apiKey.trim()} className="shrink-0">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : item.configured ? 'Update' : 'Save Key'}
              </Button>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export function UserProviderSettings() {
  const [userProviders, setUserProviders] = useState<UserProviderItem[]>([]);
  const [catalog, setCatalog] = useState<ModelProvider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      authFetch(`${API_BASE}/users/me/providers`).then((r) => r.json()),
      fetchModelProviders(),
    ])
      .then(([userItems, catalogItems]) => {
        setUserProviders(userItems);
        setCatalog(catalogItems);
      })
      .catch(() => toast.error('Failed to load providers'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-lg border p-4 space-y-2">
            <Skeleton width={120} height={16} />
            <Skeleton width="70%" height={13} />
          </div>
        ))}
      </div>
    );
  }

  // Build a merged list — all catalog providers, with user overrides and shared markers
  const userProviderMap = new Map(userProviders.map((p) => [p.providerId, p]));
  const displayItems: Array<{ item: UserProviderItem; name: string; description: string }> = [];

  // First show user's own providers + shared
  for (const up of userProviders) {
    const cat = catalog.find((c) => c.providerId === up.providerId);
    displayItems.push({
      item: up,
      name: cat?.name ?? up.providerId,
      description: cat?.description ?? '',
    });
  }

  // Then list catalog providers not yet configured by user (for easy add)
  const unconfiguredCatalog = catalog
    .filter((c) => !userProviderMap.has(c.providerId) && !userProviders.some((u) => u.providerId === c.providerId && u.sharedByAdmin))
    .sort((a, b) => {
      const ai = PROVIDER_ORDER.indexOf(a.providerId);
      const bi = PROVIDER_ORDER.indexOf(b.providerId);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

  const handleSaved = (updated: UserProviderItem) => {
    setUserProviders((prev) => {
      const exists = prev.find((p) => p.providerId === updated.providerId);
      return exists ? prev.map((p) => (p.providerId === updated.providerId ? updated : p)) : [...prev, updated];
    });
  };

  const handleRemove = (providerId: string) => {
    setUserProviders((prev) => prev.filter((p) => p.providerId !== providerId));
  };

  const configuredCount = userProviders.filter((p) => p.configured && !p.sharedByAdmin).length;
  const sharedCount = userProviders.filter((p) => p.sharedByAdmin).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
        {configuredCount > 0 && (
          <span className="flex items-center gap-1">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            {configuredCount} own key{configuredCount !== 1 ? 's' : ''}
          </span>
        )}
        {sharedCount > 0 && (
          <span className="flex items-center gap-1">
            <Share2 className="h-4 w-4 text-blue-500" />
            {sharedCount} shared by admin
          </span>
        )}
        {configuredCount === 0 && sharedCount === 0 && (
          <span className="flex items-center gap-1">
            <XCircle className="h-4 w-4 text-muted-foreground" />
            No providers configured — add your own API key or ask an admin to share one
          </span>
        )}
      </div>

      {/* Configured / shared providers */}
      {displayItems.length > 0 && (
        <div className="space-y-3">
          {displayItems.map(({ item, name, description }) => (
            <UserProviderCard
              key={item.providerId}
              item={item}
              catalogName={name}
              catalogDescription={description}
              onRemove={handleRemove}
              onSaved={handleSaved}
            />
          ))}
        </div>
      )}

      {/* Quick-add unconfigured providers */}
      {unconfiguredCatalog.length > 0 && (
        <div className="space-y-3 pt-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Available Providers
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {unconfiguredCatalog.slice(0, 8).map((cat) => (
              <button
                key={cat.providerId}
                onClick={() => {
                  const newItem: UserProviderItem = {
                    providerId: cat.providerId,
                    enabled: false,
                    configured: false,
                    maskedApiKey: null,
                    maskedExtraConfig: null,
                    sharedByAdmin: false,
                  };
                  setUserProviders((prev) => [...prev, newItem]);
                }}
                className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors text-left"
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                {cat.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Your personal API keys are used when your sessions run.
        They take priority over admin-shared keys.
      </p>
    </div>
  );
}
