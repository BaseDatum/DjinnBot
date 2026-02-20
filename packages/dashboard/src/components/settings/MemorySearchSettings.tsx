import { useState, useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  Trash2,
  Key,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { fetchModelProviders, upsertModelProvider, removeModelProvider } from '@/lib/api';
import type { ModelProvider } from '@/lib/api';

// The env var names that map to each field label shown in the UI.
// Order matches the backend extraFields declaration in settings.py.
const FIELD_LABELS: Record<string, string> = {
  QMD_OPENAI_BASE_URL: 'Embeddings Base URL',
  QMD_EMBED_PROVIDER: 'Embed Provider',
  QMD_OPENAI_EMBED_MODEL: 'Embed Model',
  QMD_RERANK_PROVIDER: 'Rerank Provider',
  QMD_RERANK_MODE: 'Rerank Mode',
  QMD_OPENAI_MODEL: 'Rerank / Query Expansion Model',
};

const FIELD_PLACEHOLDERS: Record<string, string> = {
  QMD_OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
  QMD_EMBED_PROVIDER: 'openai',
  QMD_OPENAI_EMBED_MODEL: 'openai/text-embedding-3-small',
  QMD_RERANK_PROVIDER: 'openai',
  QMD_RERANK_MODE: 'llm',
  QMD_OPENAI_MODEL: 'openai/gpt-4o-mini',
};

const FIELD_DESCRIPTIONS: Record<string, string> = {
  QMD_OPENAI_BASE_URL:
    'OpenAI-compatible API base URL for embeddings and reranking. OpenRouter is recommended — it proxies 100+ embedding models via a single key.',
  QMD_EMBED_PROVIDER:
    "Embedding backend. Use 'openai' for any OpenAI-compatible endpoint (including OpenRouter). Use 'siliconflow' for SiliconFlow.",
  QMD_OPENAI_EMBED_MODEL:
    'Model ID used to generate vector embeddings. When using OpenRouter, prefix with provider, e.g. openai/text-embedding-3-small.',
  QMD_RERANK_PROVIDER:
    "Reranking backend. 'openai' works with OpenRouter. 'gemini' uses the Gemini API. 'siliconflow' uses SiliconFlow.",
  QMD_RERANK_MODE:
    "'llm' uses a chat model to extract and score relevant passages (default, works with any provider). 'rerank' uses a dedicated reranker API endpoint.",
  QMD_OPENAI_MODEL:
    'Chat model used for reranking and query expansion. When using OpenRouter, use the full model ID, e.g. openai/gpt-4o-mini.',
};

export function MemorySearchSettings() {
  const [provider, setProvider] = useState<ModelProvider | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchModelProviders()
      .then((providers) => {
        const qmdr = providers.find((p) => p.providerId === 'qmdr') ?? null;
        setProvider(qmdr);
      })
      .catch(() => toast.error('Failed to load memory search settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!apiKey.trim() && !provider?.configured) {
      toast.error('Please enter an API key');
      return;
    }
    setSaving(true);
    try {
      const extraConfig = Object.fromEntries(
        Object.entries(extraValues).filter(([, v]) => v.trim().length > 0),
      );
      const updated = await upsertModelProvider('qmdr', {
        enabled: true,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(Object.keys(extraConfig).length > 0 ? { extraConfig } : {}),
      });
      setApiKey('');
      setExtraValues({});
      setProvider(updated);
      toast.success('Memory search configuration saved');
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await removeModelProvider('qmdr');
      setProvider((prev) =>
        prev
          ? { ...prev, configured: false, enabled: false, maskedApiKey: undefined, maskedExtraConfig: undefined }
          : prev,
      );
      toast.success('Memory search configuration removed');
    } catch (err) {
      toast.error(`Failed to remove: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRemoving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {/* Status row */}
        <div className="flex items-center justify-between">
          <Skeleton width={160} height={16} />
          <Skeleton width={70} height={28} />
        </div>
        {/* Info banner */}
        <div className="rounded-md border p-4 space-y-2">
          <Skeleton width="40%" height={14} />
          <Skeleton height={13} />
          <Skeleton width="90%" height={13} />
        </div>
        {/* API key field */}
        <div className="space-y-2">
          <Skeleton width={120} height={14} />
          <Skeleton height={40} />
        </div>
        {/* Extra fields */}
        {[...Array(4)].map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton width="35%" height={14} />
            <Skeleton height={13} />
            <Skeleton height={40} />
          </div>
        ))}
        <Skeleton height={40} />
      </div>
    );
  }

  const extraFields = provider?.extraFields ?? [];
  const maskedExtra = provider?.maskedExtraConfig ?? {};
  const plainExtra = provider?.plainExtraConfig ?? {};

  return (
    <div className="space-y-6">
      {/* Status row */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 text-sm">
          {provider?.configured ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <span className="text-green-600 dark:text-green-400 font-medium">Configured</span>
            </>
          ) : (
            <>
              <XCircle className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Not configured — agent memory recall will use keyword search only</span>
            </>
          )}
        </div>

        {provider?.configured && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            disabled={removing}
            className="h-7 text-xs text-destructive hover:text-destructive"
          >
            {removing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Trash2 className="h-3.5 w-3.5 mr-1" />
            )}
            Remove
          </Button>
        )}
      </div>

      {/* Explanation banner */}
      <div className="rounded-md border bg-muted/40 px-4 py-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-muted-foreground shrink-0" />
          <p className="text-sm font-medium">How it works</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Agent memory (ClawVault) uses <strong>QMDR</strong> — a hybrid search engine combining BM25
          keyword matching with vector semantic search and LLM reranking. An OpenAI-compatible embeddings
          API is required to generate and query vectors.{' '}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-primary hover:underline"
          >
            OpenRouter
            <ExternalLink className="h-3 w-3 ml-0.5" />
          </a>{' '}
          is recommended — a single key gives access to dozens of embedding and chat models.
        </p>
        <p className="text-xs text-muted-foreground">
          Set credentials here or via the{' '}
          <code className="text-[11px] bg-muted px-1 py-0.5 rounded font-mono">QMD_OPENAI_API_KEY</code>{' '}
          environment variable. Environment variables are synced to the database on engine startup.
        </p>
      </div>

      {/* Configured credential hints */}
      {provider?.configured && (provider.maskedApiKey || Object.keys(maskedExtra).length > 0) && (
        <div className="flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground mb-0.5">Active configuration</p>
          {provider.maskedApiKey && (
            <div className="flex items-center gap-2">
              <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <code className="text-xs text-muted-foreground font-mono">
                QMD_OPENAI_API_KEY: {provider.maskedApiKey}
              </code>
            </div>
          )}
          {Object.entries(plainExtra).map(([envVar, value]) => (
            <div key={envVar} className="flex items-center gap-2">
              <Key className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <code className="text-xs text-muted-foreground font-mono">
                {envVar}: {value}
              </code>
            </div>
          ))}
        </div>
      )}

      {/* API key input */}
      <div className="space-y-2">
        <Label className="text-sm">
          {provider?.configured ? 'Update API Key' : 'API Key'}
          <span className="text-muted-foreground ml-1 text-xs font-normal">(QMD_OPENAI_API_KEY)</span>
        </Label>
        <p className="text-xs text-muted-foreground">
          Your OpenRouter (or other provider) API key. Visit{' '}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-primary hover:underline"
          >
            openrouter.ai/keys
            <ExternalLink className="h-3 w-3 ml-0.5" />
          </a>{' '}
          to create one.
        </p>
        <div className="relative">
          <Input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider?.configured ? '(leave blank to keep existing)' : 'sk-or-v1-...'}
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

      {/* Extra fields */}
      {extraFields.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground px-2">Optional overrides</span>
            <div className="flex-1 h-px bg-border" />
          </div>
          {extraFields.map((field) => (
            <div key={field.envVar} className="space-y-1.5">
              <Label className="text-sm">
                {FIELD_LABELS[field.envVar] ?? field.label}
                <span className="text-muted-foreground ml-1 text-xs font-normal">
                  ({field.envVar})
                </span>
              </Label>
              <p className="text-xs text-muted-foreground">
                {FIELD_DESCRIPTIONS[field.envVar] ?? field.description}
              </p>
              <Input
                type="text"
                value={extraValues[field.envVar] ?? ''}
                onChange={(e) =>
                  setExtraValues((prev) => ({ ...prev, [field.envVar]: e.target.value }))
                }
                placeholder={
                  maskedExtra[field.envVar]
                    ? `(configured: ${maskedExtra[field.envVar]})`
                    : (FIELD_PLACEHOLDERS[field.envVar] ?? field.placeholder)
                }
                className="font-mono text-sm"
              />
            </div>
          ))}
        </div>
      )}

      {/* Save button */}
      <Button
        onClick={handleSave}
        disabled={saving || (!apiKey.trim() && !provider?.configured)}
        className="w-full"
      >
        {saving ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Saving...
          </>
        ) : provider?.configured ? (
          'Update Configuration'
        ) : (
          'Save Configuration'
        )}
      </Button>

      <p className="text-xs text-muted-foreground">
        Configuration is stored in the database and injected into the engine process and agent
        containers at runtime. Changes take effect on the next vault embed cycle without a restart.
      </p>
    </div>
  );
}
