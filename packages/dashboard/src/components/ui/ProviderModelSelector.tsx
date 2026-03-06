/**
 * ProviderModelSelector — two-stage model picker with favorites and thinking level.
 *
 * Stage 1 (provider list):
 *   - Favorites section above providers when any are saved.
 *   - Searching filters both.
 *
 * Stage 2 (model list):
 *   - Star button on each row to toggle favorites.
 *   - For models with reasoning: true, a thinking level row appears
 *     at the bottom of the popover. Selecting a level fires
 *     onThinkingLevelChange, then closes.
 *
 * Props:
 *   value / onChange           — model ID string
 *   thinkingLevel / onThinkingLevelChange — optional; only shown for reasoning models
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ChevronDown, ChevronLeft, Search, Loader2, Star, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchModelProviders, fetchProviderModels, fetchFavorites, saveFavorites } from '@/lib/api';
import type { ModelProvider, ProviderModel, FavoriteModel } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const THINKING_LEVELS: { value: ThinkingLevel; label: string; description: string }[] = [
  { value: 'off',     label: 'Off',     description: 'No extended thinking' },
  { value: 'minimal', label: 'Minimal', description: 'Fastest, lightest reasoning' },
  { value: 'low',     label: 'Low',     description: 'Quick reasoning pass' },
  { value: 'medium',  label: 'Medium',  description: 'Balanced depth and speed' },
  { value: 'high',    label: 'High',    description: 'Deep reasoning, slower' },
  { value: 'xhigh',   label: 'Max',     description: 'Maximum thinking budget' },
];

// ─── Favorites persistence ────────────────────────────────────────────────────

const FAVORITES_KEY = 'djinnbot:model-favorites';

function loadFavoritesLocal(): FavoriteModel[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveFavoritesLocal(favs: FavoriteModel[]): void {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs)); } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseModelString(s: string): { provider: string; modelId: string } {
  const parts = s.split('/');
  return parts.length >= 2
    ? { provider: parts[0], modelId: parts.slice(1).join('/') }
    : { provider: '', modelId: s };
}

function formatDisplayValue(
  value: string,
  providers: ModelProvider[],
  favorites: FavoriteModel[],
  thinkingLevel?: ThinkingLevel,
): string {
  if (!value) return '';
  let base = '';
  const fav = favorites.find((f) => f.modelId === value);
  if (fav) {
    base = `${fav.providerName} · ${fav.modelName}`;
  } else {
    const { provider, modelId } = parseModelString(value);
    const providerInfo = providers.find((p) => p.providerId === provider);
    if (providerInfo) {
      const catalogModel = providerInfo.models.find((m) => m.id === value || m.id === modelId);
      base = catalogModel
        ? `${providerInfo.name} · ${catalogModel.name}`
        : `${providerInfo.name} · ${modelId.split('/').pop() || modelId}`;
    } else {
      base = value;
    }
  }
  if (thinkingLevel && thinkingLevel !== 'off') {
    const lvl = THINKING_LEVELS.find((l) => l.value === thinkingLevel);
    base += ` (${lvl?.label ?? thinkingLevel})`;
  }
  return base;
}

const PROVIDER_ORDER = [
  'opencode', 'xai', 'anthropic', 'openai', 'google',
  'openrouter', 'groq', 'zai', 'mistral', 'cerebras',
];

// ─── Component ────────────────────────────────────────────────────────────────

interface ProviderModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

type Stage = 'provider' | 'model';

export function ProviderModelSelector({
  value,
  onChange,
  thinkingLevel,
  onThinkingLevelChange,
  onOpenChange,
  disabled,
  className,
  placeholder = 'Select model...',
}: ProviderModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  const [stage, setStage] = useState<Stage>('provider');
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider | null>(null);
  const [search, setSearch] = useState('');
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [favorites, setFavorites] = useState<FavoriteModel[]>(() => loadFavoritesLocal());
  // The model the user has highlighted in the current session (to show thinking level for)
  const [pendingModel, setPendingModel] = useState<ProviderModel | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // On mount: sync favorites from backend
  useEffect(() => {
    fetchFavorites()
      .then((remote) => { setFavorites(remote); saveFavoritesLocal(remote); })
      .catch(() => {});
  }, []);

  // Load providers once on first open
  useEffect(() => {
    if (!open || providers.length > 0) return;
    setProvidersLoading(true);
    fetchModelProviders()
      .then((data) => {
        const sorted = [...data].sort((a, b) => {
          const ai = PROVIDER_ORDER.indexOf(a.providerId);
          const bi = PROVIDER_ORDER.indexOf(b.providerId);
          return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });
        setProviders(sorted);
      })
      .catch(console.error)
      .finally(() => setProvidersLoading(false));
  }, [open]);

  // Fetch models when provider is selected
  useEffect(() => {
    if (!selectedProvider) return;
    setModelsLoading(true);
    setModels([]);
    fetchProviderModels(selectedProvider.providerId)
      .then(({ models: fetched }) => setModels(fetched))
      .catch(console.error)
      .finally(() => setModelsLoading(false));
  }, [selectedProvider]);

  // Focus search on open; reset on close
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 80);
    } else {
      setSearch('');
      setStage('provider');
      setSelectedProvider(null);
      setModels([]);
      setPendingModel(null);
    }
  }, [open]);

  // ── Favorites ──────────────────────────────────────────────────────────────

  const isFavorite = useCallback(
    (modelId: string) => favorites.some((f) => f.modelId === modelId),
    [favorites],
  );

  const toggleFavorite = useCallback(
    (model: ProviderModel, provider: ModelProvider, e: React.MouseEvent) => {
      e.stopPropagation();
      setFavorites((prev) => {
        const next = prev.some((f) => f.modelId === model.id)
          ? prev.filter((f) => f.modelId !== model.id)
          : [...prev, { modelId: model.id, modelName: model.name || model.id, providerName: provider.name }];
        saveFavoritesLocal(next);
        saveFavorites(next).catch(console.error);
        return next;
      });
    },
    [],
  );

  // ── Derived lists ──────────────────────────────────────────────────────────

  const displayValue = formatDisplayValue(value, providers, favorites, thinkingLevel);

  const filteredFavorites = useMemo(() => {
    if (!search) return favorites;
    const s = search.toLowerCase();
    return favorites.filter(
      (f) => f.modelId.toLowerCase().includes(s) || f.modelName.toLowerCase().includes(s) || f.providerName.toLowerCase().includes(s),
    );
  }, [favorites, search]);

  const filteredProviders = useMemo(() => {
    if (!search) return providers;
    const s = search.toLowerCase();
    return providers.filter(
      (p) => p.name.toLowerCase().includes(s) || p.providerId.toLowerCase().includes(s) || p.description.toLowerCase().includes(s),
    );
  }, [providers, search]);

  const filteredModels = useMemo(() => {
    if (!search) return models;
    const s = search.toLowerCase();
    return models.filter(
      (m) => m.id.toLowerCase().includes(s) || (m.name && m.name.toLowerCase().includes(s)),
    );
  }, [models, search]);

  // The model to show the thinking level panel for — either the pending one or the current value's match
  const thinkingTargetModel = pendingModel ?? (
    value && models.length > 0
      ? models.find((m) => m.id === value) ?? null
      : null
  );
  const showThinkingPanel = onThinkingLevelChange != null && thinkingTargetModel?.reasoning === true;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSelectProvider = (provider: ModelProvider) => {
    setSelectedProvider(provider);
    setStage('model');
    setSearch('');
  };

  const handleSelectModel = (model: ProviderModel) => {
    onChange(model.id);
    if (onThinkingLevelChange && model.reasoning) {
      // Show thinking level panel before closing
      setPendingModel(model);
    } else {
      setOpen(false);
    }
  };

  const handleSelectFavorite = (fav: FavoriteModel) => {
    onChange(fav.modelId);
    setOpen(false);
  };

  const handleSelectThinkingLevel = (level: ThinkingLevel) => {
    onThinkingLevelChange?.(level);
    setOpen(false);
  };

  const handleBack = () => {
    setStage('provider');
    setSelectedProvider(null);
    setSearch('');
    setModels([]);
    setPendingModel(null);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'justify-between font-normal',
            'w-full sm:w-[260px]',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{value ? displayValue : placeholder}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[calc(100vw-2rem)] sm:w-[400px] p-0"
        align="start"
        side="bottom"
        sideOffset={4}
      >
        {/* ── Thinking level panel (shown after selecting a reasoning model) ── */}
        {pendingModel && showThinkingPanel ? (
          <>
            <div className="flex items-center border-b px-3 py-2 gap-2">
              <button
                onClick={() => setPendingModel(null)}
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <Brain className="h-4 w-4 shrink-0 opacity-50" />
              <span className="text-sm font-medium truncate">{pendingModel.name || pendingModel.id}</span>
            </div>
            <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-b bg-muted/30">
              Choose thinking level
            </div>
            <div className="p-1">
              {THINKING_LEVELS.map((level) => (
                <button
                  key={level.value}
                  onClick={() => handleSelectThinkingLevel(level.value)}
                  className={cn(
                    'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                    'hover:bg-accent hover:text-accent-foreground',
                    'focus:bg-accent focus:text-accent-foreground focus:outline-none',
                    thinkingLevel === level.value && 'bg-accent',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-medium">{level.label}</span>
                      <p className="text-[11px] text-muted-foreground">{level.description}</p>
                    </div>
                    {thinkingLevel === level.value && (
                      <div className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                    )}
                  </div>
                </button>
              ))}
            </div>
            <div className="border-t px-3 py-2 text-[10px] text-muted-foreground">
              Controls how much the model thinks before responding
            </div>
          </>
        ) : (
          <>
            {/* ── Search header ── */}
            <div className="flex items-center border-b px-3 py-2 gap-2">
              {stage === 'model' && (
                <button
                  onClick={handleBack}
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              )}
              <Search className="h-4 w-4 shrink-0 opacity-50" />
              <Input
                ref={inputRef}
                placeholder={
                  stage === 'provider'
                    ? 'Search providers or favorites...'
                    : `Search ${selectedProvider?.name ?? ''} models...`
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 border-0 p-0 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </div>

            {/* ── Stage label ── */}
            <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-b bg-muted/30">
              {stage === 'provider' ? (
                'Choose a provider'
              ) : (
                <span className="flex items-center gap-1.5">
                  <span className="font-medium">{selectedProvider?.name}</span>
                  <span>— choose a model</span>
                </span>
              )}
            </div>

            <ScrollArea className="h-[340px]">
              {/* ── Provider stage ── */}
              {stage === 'provider' && (
                <div className="p-1">
                  {providersLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      {filteredFavorites.length > 0 && (
                        <div className="mb-1">
                          <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                            Favorites
                          </div>
                          {filteredFavorites.map((fav) => (
                            <button
                              key={fav.modelId}
                              onClick={() => handleSelectFavorite(fav)}
                              className={cn(
                                'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                                'hover:bg-accent hover:text-accent-foreground',
                                value === fav.modelId && 'bg-accent',
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <Star className="h-3 w-3 text-muted-foreground fill-current shrink-0" />
                                  <div className="min-w-0">
                                    <span className="font-medium">{fav.modelName}</span>
                                    <span className="text-[11px] text-muted-foreground ml-2">{fav.providerName}</span>
                                  </div>
                                </div>
                                <code className="text-[10px] text-muted-foreground font-mono shrink-0 hidden sm:block truncate max-w-[120px]">
                                  {fav.modelId}
                                </code>
                              </div>
                            </button>
                          ))}
                          {filteredProviders.length > 0 && <div className="mx-2 my-1.5 border-t" />}
                        </div>
                      )}

                      {filteredProviders.length === 0 && filteredFavorites.length === 0 ? (
                        <div className="py-6 text-center text-sm text-muted-foreground">No results</div>
                      ) : (
                        filteredProviders.map((provider) => (
                          <button
                            key={provider.providerId}
                            onClick={() => handleSelectProvider(provider)}
                            className={cn(
                              'w-full rounded-md px-3 py-2.5 text-left text-sm transition-colors',
                              'hover:bg-accent hover:text-accent-foreground',
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <span className="font-medium">{provider.name}</span>
                                <p className="text-[11px] text-muted-foreground truncate">{provider.description}</p>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {provider.configured && (
                                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-green-500/40 text-green-600 dark:text-green-400">
                                    Active
                                  </Badge>
                                )}
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground -rotate-90" />
                              </div>
                            </div>
                          </button>
                        ))
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ── Model stage ── */}
              {stage === 'model' && (
                <div className="p-1">
                  {!selectedProvider?.configured && (
                    <div className="mx-2 mb-2 mt-1 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                      {selectedProvider?.name} is not configured. Go to Settings → Model Providers to add an API key.
                    </div>
                  )}

                  {modelsLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : filteredModels.length === 0 ? (
                    <div className="py-6 text-center text-sm text-muted-foreground">No models found</div>
                  ) : (
                    filteredModels.map((model) => {
                      const isSelected = value === model.id;
                      const starred = isFavorite(model.id);
                      return (
                        <button
                          key={model.id}
                          onClick={() => handleSelectModel(model)}
                          className={cn(
                            'group w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                            'hover:bg-accent hover:text-accent-foreground',
                            isSelected && 'bg-accent',
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium">{model.name || model.id}</span>
                                {model.reasoning && (
                                  <Brain className="h-3 w-3 text-muted-foreground shrink-0" />
                                )}
                              </div>
                              {model.description && (
                                <p className="text-[11px] text-muted-foreground">{model.description}</p>
                              )}
                            </div>
                            <code className="text-[10px] text-muted-foreground font-mono shrink-0 hidden sm:block truncate max-w-[120px]">
                              {model.id}
                            </code>
                            <button
                              onClick={(e) => toggleFavorite(model, selectedProvider!, e)}
                              className={cn(
                                'shrink-0 rounded p-0.5 transition-colors',
                                starred
                                  ? 'text-yellow-500 hover:text-yellow-600'
                                  : 'text-muted-foreground/30 hover:text-muted-foreground opacity-0 group-hover:opacity-100',
                              )}
                              aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
                            >
                              <Star className="h-3.5 w-3.5" fill={starred ? 'currentColor' : 'none'} />
                            </button>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </ScrollArea>

            <div className="border-t px-3 py-2 text-[10px] text-muted-foreground">
              {stage === 'provider'
                ? favorites.length > 0
                  ? `${favorites.length} favorite${favorites.length !== 1 ? 's' : ''} · star models to add more`
                  : 'Star models to add them as favorites'
                : `${filteredModels.length} model${filteredModels.length !== 1 ? 's' : ''} · star to favorite`}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
