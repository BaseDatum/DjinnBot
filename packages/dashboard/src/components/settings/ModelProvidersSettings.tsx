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
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Loader2,
  Trash2,
  Key,
  Zap,
  AlertTriangle,
  Plus,
  Server,
} from 'lucide-react';
import { toast } from 'sonner';
import { fetchModelProviders, upsertModelProvider, removeModelProvider, createCustomProvider } from '@/lib/api';
import type { ModelProvider, ProviderExtraField } from '@/lib/api';

const PROVIDER_ORDER = [
  'opencode', 'xai', 'anthropic', 'openai', 'google', 'openrouter',
  'groq', 'zai', 'mistral', 'cerebras', 'minimax', 'kimi-coding',
  'azure-openai-responses', 'huggingface', 'minimax-cn',
];

interface ProviderCardProps {
  provider: ModelProvider;
  onUpdate: (updated: ModelProvider) => void;
  onRemove: (providerId: string) => void;
}

function ProviderCard({ provider, onUpdate, onRemove }: ProviderCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  // Extra fields keyed by envVar name
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const hasExtraFields = provider.extraFields && provider.extraFields.length > 0;

  // Determine if the form is complete enough to save.
  // For Azure: needs API key + at least one of base URL / resource name.
  const canSave = (() => {
    if (!apiKey.trim() && !provider.configured) return false;
    if (!hasExtraFields) return apiKey.trim().length > 0 || provider.configured;
    // Multi-field: check required fields are filled or already configured
    const requiredFields = provider.extraFields.filter(f => f.required);
    const allRequired = requiredFields.every(f =>
      extraValues[f.envVar]?.trim() || provider.maskedExtraConfig?.[f.envVar]
    );
    // Azure special: either base URL or resource name must be present
    if (provider.providerId === 'azure-openai-responses') {
      const hasBaseUrl = extraValues['AZURE_OPENAI_BASE_URL']?.trim() ||
        provider.maskedExtraConfig?.['AZURE_OPENAI_BASE_URL'];
      const hasResource = extraValues['AZURE_OPENAI_RESOURCE_NAME']?.trim() ||
        provider.maskedExtraConfig?.['AZURE_OPENAI_RESOURCE_NAME'];
      return (apiKey.trim() || provider.configured) && (hasBaseUrl || hasResource);
    }
    return allRequired;
  })();

  const handleSave = async () => {
    if (!apiKey.trim() && !provider.configured) {
      toast.error('Please enter an API key');
      return;
    }
    setSaving(true);
    try {
      // Only send non-empty extra values
      const extraConfig = hasExtraFields
        ? Object.fromEntries(
            Object.entries(extraValues).filter(([, v]) => v.trim().length > 0)
          )
        : undefined;

      const updated = await upsertModelProvider(provider.providerId, {
        enabled: true,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(extraConfig && Object.keys(extraConfig).length > 0 ? { extraConfig } : {}),
      });
      setApiKey('');
      setExtraValues({});
      toast.success(`${provider.name} configured`);
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
      await removeModelProvider(provider.providerId);
      toast.success(`${provider.name} removed`);
      onRemove(provider.providerId);
    } catch (err) {
      toast.error(`Failed to remove: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRemoving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!provider.configured) {
      toast.error('Configure credentials first');
      return;
    }
    setSaving(true);
    try {
      const updated = await upsertModelProvider(provider.providerId, {
        enabled: !provider.enabled,
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
              <CardTitle className="text-base">{provider.name}</CardTitle>
              {provider.configured ? (
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
              {provider.configured && !provider.enabled && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  Disabled
                </Badge>
              )}
            </div>
            <CardDescription className="text-xs">{provider.description}</CardDescription>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {provider.configured && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleToggleEnabled}
                  disabled={saving}
                  className="h-7 text-xs"
                >
                  {provider.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleRemove}
                  disabled={removing}
                  className="h-7 w-7 text-destructive hover:text-destructive"
                >
                  {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
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

        {/* Show configured credential hints */}
        {provider.configured && (provider.maskedApiKey || provider.maskedExtraConfig) && (
          <div className="flex flex-col gap-1 mt-2">
            {provider.maskedApiKey && (
              <div className="flex items-center gap-2">
                <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <code className="text-xs text-muted-foreground font-mono">
                  {provider.apiKeyEnvVar}: {provider.maskedApiKey}
                </code>
              </div>
            )}
            {provider.maskedExtraConfig && Object.entries(provider.maskedExtraConfig).map(([envVar, masked]) => (
              <div key={envVar} className="flex items-center gap-2">
                <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <code className="text-xs text-muted-foreground font-mono">
                  {envVar}: {masked}
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
                href={provider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                {provider.docsUrl}
                <ExternalLink className="h-3 w-3 ml-0.5" />
              </a>{' '}
              to create or manage your API key.
            </p>
            <p className="text-xs text-muted-foreground">
              Set it here or via the{' '}
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded font-mono">{provider.apiKeyEnvVar}</code>{' '}
              environment variable.
            </p>
          </div>

          {/* Primary API key input */}
          <div className="space-y-2">
            <Label htmlFor={`key-${provider.providerId}`} className="text-sm">
              {provider.configured ? 'Update API Key' : 'API Key'}
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                ({provider.apiKeyEnvVar})
              </span>
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id={`key-${provider.providerId}`}
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={provider.configured ? '(leave blank to keep existing)' : `${provider.apiKeyEnvVar} value`}
                  className="font-mono text-sm pr-10"
                  onKeyDown={(e) => e.key === 'Enter' && !hasExtraFields && handleSave()}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {!hasExtraFields && (
                <Button
                  onClick={handleSave}
                  disabled={saving || (!apiKey.trim() && !provider.configured)}
                  className="shrink-0"
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    provider.configured ? 'Update' : 'Save Key'
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* Extra fields for multi-value providers (e.g. Azure) */}
          {hasExtraFields && (
            <div className="space-y-3">
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                  This provider requires additional configuration
                </p>
                {provider.providerId === 'azure-openai-responses' && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Provide either <strong>Base URL</strong> or <strong>Resource Name</strong> — not both.
                  </p>
                )}
              </div>

              {provider.extraFields.map((field: ProviderExtraField) => (
                <ExtraFieldInput
                  key={field.envVar}
                  field={field}
                  value={extraValues[field.envVar] ?? ''}
                  existingMasked={provider.maskedExtraConfig?.[field.envVar]}
                  onChange={(val) => setExtraValues(prev => ({ ...prev, [field.envVar]: val }))}
                />
              ))}

              <Button
                onClick={handleSave}
                disabled={saving || !canSave}
                className="w-full"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  provider.configured ? 'Update Configuration' : 'Save Configuration'
                )}
              </Button>
            </div>
          )}

          {/* Available models */}
          {provider.models.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Available Models</p>
              <div className="grid grid-cols-1 gap-1">
                {provider.models.slice(0, 6).map((model) => (
                  <div key={model.id} className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-muted/50">
                    <Zap className="h-3 w-3 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <span className="text-xs font-medium">{model.name}</span>
                      {model.description && (
                        <span className="text-[11px] text-muted-foreground ml-2">{model.description}</span>
                      )}
                    </div>
                    <code className="text-[10px] text-muted-foreground font-mono ml-auto shrink-0">{model.id}</code>
                  </div>
                ))}
                {provider.models.length > 6 && (
                  <p className="text-xs text-muted-foreground px-2">
                    +{provider.models.length - 6} more models
                  </p>
                )}
              </div>
            </div>
          )}

          {provider.providerId === 'openrouter' && (
            <p className="text-xs text-muted-foreground">
              OpenRouter gives access to 200+ models from Anthropic, OpenAI, Google, and more via a single API key.
              Models are prefixed with their provider name (e.g. <code className="text-[11px] font-mono">anthropic/claude-sonnet-4</code>).
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/**
 * Returns a suggested host.docker.internal replacement and a warning message
 * when the given URL contains localhost / 127.0.0.1, otherwise returns null.
 */
function useLocalhostWarning(url: string): { suggested: string; warning: string } | null {
  if (!/localhost|127\.0\.0\.1|::1/.test(url)) return null;
  const suggested = url.replace(/localhost|127\.0\.0\.1|::1/g, 'host.docker.internal');
  return {
    suggested,
    warning:
      `"localhost" won't be reachable from agent containers (Docker bridge network). ` +
      `Use "${suggested}" instead. On Linux, also add ` +
      `extra_hosts: ["host.docker.internal:host-gateway"] to the engine service in docker-compose.yml.`,
  };
}

/** Input for a single extra config field */
function ExtraFieldInput({
  field,
  value,
  existingMasked,
  onChange,
}: {
  field: ProviderExtraField;
  value: string;
  existingMasked?: string;
  onChange: (val: string) => void;
}) {
  const localhostWarning = useLocalhostWarning(value);

  return (
    <div className="space-y-1.5">
      <Label className="text-sm">
        {field.label}
        {field.required && <span className="text-destructive ml-0.5">*</span>}
        <span className="text-muted-foreground ml-1 text-xs font-normal">({field.envVar})</span>
      </Label>
      <p className="text-xs text-muted-foreground">{field.description}</p>
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={existingMasked ? `(configured: ${existingMasked})` : field.placeholder}
        className="font-mono text-sm"
      />
      {localhostWarning && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 flex gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-xs text-amber-600 dark:text-amber-400">{localhostWarning.warning}</p>
            <button
              type="button"
              className="text-xs text-primary underline underline-offset-2 hover:no-underline"
              onClick={() => onChange(localhostWarning.suggested)}
            >
              Use {localhostWarning.suggested}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Add Custom Provider Form ─────────────────────────────────────────────────

function AddCustomProviderForm({ onCreated }: { onCreated: (p: ModelProvider) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Auto-derive slug from name
  const handleNameChange = (v: string) => {
    setName(v);
    setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32));
  };

  const localhostWarning = useLocalhostWarning(baseUrl);

  const handleCreate = async () => {
    if (!name.trim() || !baseUrl.trim() || !slug.trim()) {
      toast.error('Name, slug, and Base URL are required');
      return;
    }
    setSaving(true);
    try {
      const created = await createCustomProvider({
        name: name.trim(),
        slug: slug.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      toast.success(`Custom provider "${created.name}" added`);
      onCreated(created);
      setOpen(false);
      setName(''); setSlug(''); setBaseUrl(''); setApiKey('');
    } catch (err: any) {
      toast.error(`Failed to add provider: ${err?.message ?? 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="w-full gap-2">
        <Plus className="h-4 w-4" />
        Add Custom Provider
      </Button>
    );
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">New Custom Provider</CardTitle>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground text-xs"
          >
            Cancel
          </button>
        </div>
        <CardDescription className="text-xs">
          Add any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, llama.cpp server, etc.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-sm">Display Name <span className="text-destructive">*</span></Label>
            <Input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="My Ollama"
              className="text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">
              Slug <span className="text-destructive">*</span>
              <span className="text-muted-foreground ml-1 text-xs font-normal">(used in model IDs)</span>
            </Label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32))}
              placeholder="my-ollama"
              className="text-sm font-mono"
            />
            {slug && (
              <p className="text-[11px] text-muted-foreground font-mono">
                Model IDs: <span className="text-foreground">custom-{slug}/model-name</span>
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm">Base URL <span className="text-destructive">*</span></Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
            className="text-sm font-mono"
          />
          {localhostWarning && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 flex gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-xs text-amber-600 dark:text-amber-400">{localhostWarning.warning}</p>
                <button
                  type="button"
                  className="text-xs text-primary underline underline-offset-2 hover:no-underline"
                  onClick={() => setBaseUrl(localhostWarning.suggested)}
                >
                  Use {localhostWarning.suggested}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm">
            API Key
            <span className="text-muted-foreground ml-1 text-xs font-normal">(optional — leave blank for unauthenticated endpoints)</span>
          </Label>
          <div className="relative">
            <Input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="text-sm font-mono pr-10"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <Button
          onClick={handleCreate}
          disabled={saving || !name.trim() || !slug.trim() || !baseUrl.trim()}
          className="w-full"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
          Add Provider
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Custom Provider Card ─────────────────────────────────────────────────────

function CustomProviderCard({
  provider,
  onUpdate,
  onRemove,
}: {
  provider: ModelProvider;
  onUpdate: (updated: ModelProvider) => void;
  onRemove: (providerId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Derive the base URL env var key for this provider to show its current value
  const slug = provider.providerId.slice('custom-'.length).toUpperCase().replace(/-/g, '_');
  const baseUrlEnvKey = `CUSTOM_${slug}_BASE_URL`;
  const currentBaseUrl = provider.plainExtraConfig?.[baseUrlEnvKey] ?? '';

  const [baseUrl, setBaseUrl] = useState(currentBaseUrl);

  // Keep the input in sync when the provider prop updates (e.g. after a successful save)
  useEffect(() => {
    setBaseUrl(currentBaseUrl);
  }, [currentBaseUrl]);

  const localhostWarning = useLocalhostWarning(baseUrl);

  const handleSave = async () => {
    if (!baseUrl.trim() && !currentBaseUrl) {
      toast.error('Base URL is required');
      return;
    }
    setSaving(true);
    try {
      const extraConfig: Record<string, string> = {};
      if (baseUrl.trim()) extraConfig[baseUrlEnvKey] = baseUrl.trim();

      const updated = await upsertModelProvider(provider.providerId, {
        enabled: true,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(Object.keys(extraConfig).length > 0 ? { extraConfig } : {}),
      });
      setApiKey('');
      toast.success(`${provider.name} updated`);
      onUpdate(updated);
    } catch (err: any) {
      toast.error(`Failed to save: ${err?.message ?? 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await removeModelProvider(provider.providerId);
      toast.success(`${provider.name} removed`);
      onRemove(provider.providerId);
    } catch (err: any) {
      toast.error(`Failed to remove: ${err?.message ?? 'Unknown error'}`);
    } finally {
      setRemoving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!provider.configured) {
      toast.error('Configure base URL first');
      return;
    }
    setSaving(true);
    try {
      const updated = await upsertModelProvider(provider.providerId, {
        enabled: !provider.enabled,
      });
      onUpdate(updated);
    } catch {
      toast.error('Failed to update');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Server className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <CardTitle className="text-base">{provider.name}</CardTitle>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-primary/40 text-primary/80">
                Custom
              </Badge>
              {provider.configured ? (
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
              {provider.configured && !provider.enabled && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Disabled</Badge>
              )}
            </div>
            {currentBaseUrl && (
              <code className="text-[11px] text-muted-foreground font-mono flex items-center gap-1 mt-0.5">
                <span>{currentBaseUrl}</span>
              </code>
            )}
            <p className="text-[11px] text-muted-foreground font-mono">
              provider prefix: <span className="text-foreground">{provider.providerId}/</span>
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {provider.configured && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleToggleEnabled}
                  disabled={saving}
                  className="h-7 text-xs"
                >
                  {provider.enabled ? 'Disable' : 'Enable'}
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRemove}
              disabled={removing}
              className="h-7 w-7 text-destructive hover:text-destructive"
            >
              {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-sm">
              Base URL
              <span className="text-muted-foreground ml-1 text-xs font-normal">({baseUrlEnvKey})</span>
            </Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://host.docker.internal:11434/v1"
              className="font-mono text-sm"
            />
            {localhostWarning && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 flex gap-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-xs text-amber-600 dark:text-amber-400">{localhostWarning.warning}</p>
                  <button
                    type="button"
                    className="text-xs text-primary underline underline-offset-2 hover:no-underline"
                    onClick={() => setBaseUrl(localhostWarning.suggested)}
                  >
                    Use {localhostWarning.suggested}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm">
              API Key
              <span className="text-muted-foreground ml-1 text-xs font-normal">(optional)</span>
            </Label>
            <div className="relative">
              <Input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={provider.maskedApiKey ? `(configured: ${provider.maskedApiKey})` : 'Leave blank for unauthenticated endpoints'}
                className="font-mono text-sm pr-10"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <Button
            onClick={handleSave}
            disabled={saving || (!baseUrl.trim() && !currentBaseUrl)}
            className="w-full"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {provider.configured ? 'Update' : 'Save Configuration'}
          </Button>

          {/* Live model list */}
          {provider.models.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Available Models</p>
              <div className="grid grid-cols-1 gap-1">
                {provider.models.slice(0, 8).map((model) => (
                  <div key={model.id} className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-muted/50">
                    <Zap className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs font-medium">{model.name}</span>
                    <code className="text-[10px] text-muted-foreground font-mono ml-auto shrink-0">{model.id}</code>
                  </div>
                ))}
                {provider.models.length > 8 && (
                  <p className="text-xs text-muted-foreground px-2">+{provider.models.length - 8} more</p>
                )}
              </div>
            </div>
          )}

          <div className="rounded-md bg-muted/50 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              Use this provider in agent model fields with{' '}
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded font-mono">{provider.providerId}/model-name</code>.
              The base URL must be reachable from agent containers.
            </p>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ─── ModelProvidersSettings ───────────────────────────────────────────────────

export function ModelProvidersSettings() {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchModelProviders()
      .then((data) => {
        const sorted = [...data]
          .filter((p) => p.providerId !== 'qmdr')
          .sort((a, b) => {
            const aOrder = PROVIDER_ORDER.indexOf(a.providerId);
            const bOrder = PROVIDER_ORDER.indexOf(b.providerId);
            return (aOrder === -1 ? 999 : aOrder) - (bOrder === -1 ? 999 : bOrder);
          });
        setProviders(sorted);
      })
      .catch((err) => {
        console.error('Failed to load providers:', err);
        toast.error('Failed to load model providers');
      })
      .finally(() => setLoading(false));
  }, []);

  const handleUpdate = (updated: ModelProvider) => {
    setProviders((prev) =>
      prev.map((p) => (p.providerId === updated.providerId ? updated : p))
    );
  };

  const handleRemove = (providerId: string) => {
    setProviders((prev) => {
      const provider = prev.find((p) => p.providerId === providerId);
      // Custom providers are fully deleted; built-in ones just get cleared
      if (provider?.isCustom) {
        return prev.filter((p) => p.providerId !== providerId);
      }
      return prev.map((p) =>
        p.providerId === providerId
          ? { ...p, configured: false, enabled: false, maskedApiKey: undefined, maskedExtraConfig: undefined }
          : p
      );
    });
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="rounded-lg border p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-2 flex-1">
                <div className="flex items-center gap-2">
                  <Skeleton width={120} height={16} />
                  <Skeleton width={70} height={18} />
                </div>
                <Skeleton width="70%" height={13} />
              </div>
              <div className="flex gap-2 shrink-0">
                <Skeleton width={60} height={28} />
                <Skeleton width={28} height={28} />
                <Skeleton width={16} height={16} />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const builtinProviders = providers.filter((p) => !p.isCustom);
  const customProviders = providers.filter((p) => p.isCustom);
  const configuredCount = providers.filter((p) => p.configured && p.enabled).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {configuredCount > 0 ? (
          <>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <span>{configuredCount} provider{configuredCount !== 1 ? 's' : ''} active</span>
          </>
        ) : (
          <>
            <XCircle className="h-4 w-4 text-muted-foreground" />
            <span>No providers configured — set up at least one to run agents</span>
          </>
        )}
      </div>

      {/* Built-in providers */}
      <div className="space-y-3">
        {builtinProviders.map((provider) => (
          <ProviderCard
            key={provider.providerId}
            provider={provider}
            onUpdate={handleUpdate}
            onRemove={handleRemove}
          />
        ))}
      </div>

      {/* Custom providers section */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Custom Providers</span>
          <span className="text-xs text-muted-foreground">(OpenAI-compatible endpoints)</span>
        </div>

        {customProviders.length > 0 && (
          <div className="space-y-3">
            {customProviders.map((provider) => (
              <CustomProviderCard
                key={provider.providerId}
                provider={provider}
                onUpdate={handleUpdate}
                onRemove={handleRemove}
              />
            ))}
          </div>
        )}

        <AddCustomProviderForm
          onCreated={(p) => setProviders((prev) => [...prev, p])}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        API keys are stored in the database and never exposed in full after saving.
        You can also set them via environment variables — environment variables are synced to the database on engine startup.
      </p>
    </div>
  );
}
