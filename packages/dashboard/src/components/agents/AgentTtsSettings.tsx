/**
 * AgentTtsSettings — TTS configuration for an individual agent.
 *
 * Allows enabling/disabling TTS, selecting a TTS provider override
 * (Fish Audio cloud or Voicebox local), and picking a voice.
 * Displayed on the agent detail page settings tab.
 *
 * Voice sources:
 * - Fish Audio: GET /v1/tts/voices (proxied to api.fish.audio/model)
 * - Voicebox:   GET /v1/tts/voicebox/profiles (proxied to local Voicebox)
 */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Volume2,
  Search,
  Loader2,
  Check,
  X,
  AlertCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';

interface Voice {
  id: string;
  title: string;
  description: string;
  coverImage: string | null;
  tags: string[];
  languages: string[];
  author: string;
}

// Fish Audio's official default/recommended voices (from docs).
// Shown at the top of the picker so users don't have to search for them.
const FISH_AUDIO_DEFAULT_VOICES: Voice[] = [
  { id: '8ef4a238714b45718ce04243307c57a7', title: 'E-girl', description: '', coverImage: 'https://public-platform.r2.fish.audio/coverimage/8ef4a238714b45718ce04243307c57a7', tags: [], languages: ['en'], author: 'Fish Audio' },
  { id: '802e3bc2b27e49c2995d23ef70e6ac89', title: 'Energetic Male', description: '', coverImage: 'https://public-platform.r2.fish.audio/coverimage/802e3bc2b27e49c2995d23ef70e6ac89', tags: [], languages: ['en'], author: 'Fish Audio' },
  { id: '933563129e564b19a115bedd57b7406a', title: 'Sarah', description: '', coverImage: 'https://public-platform.r2.fish.audio/coverimage/933563129e564b19a115bedd57b7406a', tags: [], languages: ['en'], author: 'Fish Audio' },
  { id: 'bf322df2096a46f18c579d0baa36f41d', title: 'Adrian', description: '', coverImage: 'https://public-platform.r2.fish.audio/coverimage/bf322df2096a46f18c579d0baa36f41d', tags: [], languages: ['en'], author: 'Fish Audio' },
  { id: 'b347db033a6549378b48d00acb0d06cd', title: 'Selene', description: '', coverImage: 'https://public-platform.r2.fish.audio/coverimage/b347db033a6549378b48d00acb0d06cd', tags: [], languages: ['en'], author: 'Fish Audio' },
  { id: '536d3a5e000945adb7038665781a4aca', title: 'Ethan', description: '', coverImage: 'https://public-platform.r2.fish.audio/coverimage/536d3a5e000945adb7038665781a4aca', tags: [], languages: ['en'], author: 'Fish Audio' },
];

function VoiceRow({ voice, selected, onSelect }: { voice: Voice; selected: boolean; onSelect: (v: Voice) => void }) {
  return (
    <button
      onClick={() => onSelect(voice)}
      className={`w-full flex items-center gap-3 p-3 text-left hover:bg-muted/50 transition-colors ${
        selected ? 'bg-primary/5' : ''
      }`}
    >
      {voice.coverImage ? (
        <img src={voice.coverImage} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
      ) : (
        <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
          <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      )}
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="text-sm font-medium truncate leading-tight">{voice.title}</div>
        {(voice.author || voice.languages.length > 0) && (
          <div className="text-xs text-muted-foreground truncate leading-tight mt-0.5">
            {[
              voice.author ? `by ${voice.author}` : '',
              voice.languages.length > 0 ? voice.languages.slice(0, 3).join(', ') : '',
            ].filter(Boolean).join(' \u00b7 ')}
          </div>
        )}
      </div>
      {selected && <Check className="h-4 w-4 text-primary shrink-0" />}
    </button>
  );
}

/** Helper to fetch agent TTS settings from the DB-backed endpoint. */
async function fetchAgentTtsSettings(agentId: string) {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/tts-settings`);
  if (!res.ok) throw new Error('Failed to fetch TTS settings');
  return res.json();
}

/** Helper to update agent TTS settings via the DB-backed endpoint. */
async function saveAgentTtsSettings(agentId: string, updates: Record<string, unknown>) {
  const res = await authFetch(`${API_BASE}/agents/${agentId}/tts-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error('Failed to update TTS settings');
  return res.json();
}

export function AgentTtsSettings({
  agentId,
}: {
  agentId: string;
}) {
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<string>('');
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [manualVoiceId, setManualVoiceId] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load settings from DB on mount
  useEffect(() => {
    fetchAgentTtsSettings(agentId)
      .then(data => {
        setTtsEnabled(data.tts_enabled || false);
        setTtsProvider(data.tts_provider || '');
        setVoiceId(data.tts_voice_id || null);
        setVoiceName(data.tts_voice_name || null);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load agent TTS settings:', err);
        setLoading(false);
      });
  }, [agentId]);

  const handleToggle = async (enabled: boolean) => {
    setTtsEnabled(enabled);
    setSaving(true);
    try {
      await saveAgentTtsSettings(agentId, { tts_enabled: enabled });
      toast.success(enabled ? 'TTS enabled' : 'TTS disabled');
    } catch {
      toast.error('Failed to update TTS setting');
      setTtsEnabled(!enabled);
    } finally {
      setSaving(false);
    }
  };

  const handleProviderChange = async (provider: string) => {
    setTtsProvider(provider);
    // Clear voice selection when switching providers
    setVoiceId(null);
    setVoiceName(null);
    setShowVoicePicker(false);
    setSaving(true);
    try {
      await saveAgentTtsSettings(agentId, {
        tts_provider: provider || null,
        tts_voice_id: null,
        tts_voice_name: null,
      });
      toast.success(
        provider
          ? `TTS provider set to ${provider === 'voicebox' ? 'Voicebox' : 'Fish Audio'}`
          : 'Using system default TTS provider',
      );
    } catch {
      toast.error('Failed to update TTS provider');
    } finally {
      setSaving(false);
    }
  };

  // Determine which provider is active for voice listing
  const activeProvider = ttsProvider || 'fish-audio';

  const loadVoices = useCallback(async (search?: string) => {
    setLoadingVoices(true);
    setVoiceError(null);
    try {
      if (activeProvider === 'voicebox') {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        const res = await authFetch(`${API_BASE}/tts/voicebox/profiles?${params}`);
        if (res.ok) {
          const data = await res.json();
          setVoices(data.voices || []);
        } else if (res.status === 502) {
          setVoiceError('Voicebox not reachable. Make sure it is running.');
          setVoices([]);
        } else {
          setVoiceError('Failed to load Voicebox profiles.');
          setVoices([]);
        }
      } else {
        const params = new URLSearchParams({ page_size: '20' });
        if (search) params.set('search', search);
        const res = await authFetch(`${API_BASE}/tts/voices?${params}`);
        if (res.ok) {
          const data = await res.json();
          setVoices(data.voices || []);
        } else if (res.status === 503) {
          setVoiceError('No Fish Audio API key configured. Add one in Settings \u2192 TTS Providers.');
          setVoices([]);
        } else {
          setVoiceError('Failed to load voices from Fish Audio.');
          setVoices([]);
        }
      }
    } catch (err) {
      console.error('Failed to load voices:', err);
      setVoiceError('Network error loading voices.');
      setVoices([]);
    } finally {
      setLoadingVoices(false);
    }
  }, [activeProvider]);

  const handleOpenPicker = () => {
    setShowVoicePicker(true);
    setVoiceSearch('');
    loadVoices();
  };

  const handleSelectVoice = async (voice: Voice) => {
    setVoiceId(voice.id);
    setVoiceName(voice.title);
    setShowVoicePicker(false);
    setSaving(true);
    try {
      await saveAgentTtsSettings(agentId, {
        tts_voice_id: voice.id,
        tts_voice_name: voice.title,
      });
      toast.success(`Voice set to ${voice.title}`);
    } catch {
      toast.error('Failed to update voice');
    } finally {
      setSaving(false);
    }
  };

  const handleClearVoice = async () => {
    setVoiceId(null);
    setVoiceName(null);
    setSaving(true);
    try {
      await saveAgentTtsSettings(agentId, {
        tts_voice_id: null,
        tts_voice_name: null,
      });
      toast.success('Voice reset to default');
    } catch {
      toast.error('Failed to clear voice');
    } finally {
      setSaving(false);
    }
  };

  const handleSearchVoices = () => {
    loadVoices(voiceSearch || undefined);
  };

  const handleManualVoiceId = async () => {
    const id = manualVoiceId.trim();
    if (!id) return;
    setSaving(true);
    try {
      // Try to resolve the name from the API
      let name = id;
      try {
        const res = await authFetch(`${API_BASE}/tts/voices/${id}`);
        if (res.ok) {
          const data = await res.json();
          name = data.title || id;
        }
      } catch {
        // If lookup fails, just use the raw ID as the name
      }
      setVoiceId(id);
      setVoiceName(name);
      setShowVoicePicker(false);
      setManualVoiceId('');
      await saveAgentTtsSettings(agentId, {
        tts_voice_id: id,
        tts_voice_name: name,
      });
      toast.success(`Voice set to ${name}`);
    } catch {
      toast.error('Failed to set voice ID');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex-1 min-w-0 mr-4">
            <CardTitle className="text-base flex items-center gap-2">
              <Volume2 className="h-4 w-4 shrink-0" />
              Text-to-Speech
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              When enabled, voice message inputs will receive an audio response
              in addition to the text response.
            </CardDescription>
          </div>
          <Switch
            checked={ttsEnabled}
            onCheckedChange={handleToggle}
            disabled={saving || loading}
            className="shrink-0"
          />
        </div>
      </CardHeader>

      {ttsEnabled && (
        <CardContent className="pt-0 space-y-4">
          {/* Provider override */}
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1.5">TTS Provider</div>
            <select
              value={ttsProvider}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={saving}
              className="flex h-8 w-56 rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">System Default</option>
              <option value="fish-audio">Fish Audio (Cloud)</option>
              <option value="voicebox">Voicebox (Local)</option>
            </select>
          </div>

          {/* Current voice display */}
          <div className="flex items-center justify-between gap-3 p-3 rounded-md border bg-muted/30">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-muted-foreground mb-0.5">Voice</div>
              {voiceName ? (
                <div className="text-sm font-medium truncate">{voiceName}</div>
              ) : (
                <div className="text-sm text-muted-foreground italic">
                  {activeProvider === 'voicebox' ? 'Default Voicebox voice' : 'Default (Fish Audio S1)'}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {voiceId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClearVoice}
                  disabled={saving}
                  className="h-7 px-2 text-muted-foreground hover:text-destructive"
                  title="Reset to default voice"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenPicker}
                className="h-7 text-xs"
              >
                {voiceId ? 'Change' : 'Select Voice'}
              </Button>
            </div>
          </div>

          {/* Voice picker */}
          {showVoicePicker && (
            <div className="border rounded-lg overflow-hidden">
              {/* Picker header */}
              <div className="flex items-center justify-between p-3 border-b bg-muted/20">
                <span className="text-sm font-medium">
                  {activeProvider === 'voicebox' ? 'Select a Voicebox Profile' : 'Select a Voice'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowVoicePicker(false)}
                  className="h-6 w-6 p-0"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>

              {/* Search bar */}
              <div className="flex gap-2 p-3 border-b">
                <Input
                  placeholder={activeProvider === 'voicebox' ? 'Search profiles...' : 'Search voices...'}
                  value={voiceSearch}
                  onChange={(e) => setVoiceSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearchVoices()}
                  className="text-sm h-8"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSearchVoices}
                  disabled={loadingVoices}
                  className="h-8 px-3 shrink-0"
                >
                  <Search className="h-3 w-3" />
                </Button>
              </div>

              {/* Manual voice ID input */}
              {activeProvider !== 'voicebox' && (
                <div className="flex gap-2 px-3 pb-3 items-center">
                  <Input
                    placeholder="Or paste a voice ID..."
                    value={manualVoiceId}
                    onChange={(e) => setManualVoiceId(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleManualVoiceId()}
                    className="text-sm h-8 font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleManualVoiceId}
                    disabled={!manualVoiceId.trim() || saving}
                    className="h-8 px-3 shrink-0"
                  >
                    Use
                  </Button>
                </div>
              )}

              {/* Voice list */}
              <div className="max-h-72 overflow-y-auto">
                {/* Default voices section (Fish Audio only, always shown) */}
                {activeProvider !== 'voicebox' && !voiceSearch && (
                  <>
                    <div className="px-3 pt-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Default Voices
                    </div>
                    <div className="divide-y">
                      {FISH_AUDIO_DEFAULT_VOICES.map((voice) => (
                        <VoiceRow key={voice.id} voice={voice} selected={voice.id === voiceId} onSelect={handleSelectVoice} />
                      ))}
                    </div>
                  </>
                )}

                {/* Search results / discovery section */}
                {(voiceSearch || activeProvider === 'voicebox') ? (
                  // Searched or Voicebox — show only API results
                  loadingVoices ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-sm text-muted-foreground">Loading voices...</span>
                    </div>
                  ) : voiceError ? (
                    <div className="flex items-start gap-2 p-4 text-sm text-orange-500">
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>{voiceError}</span>
                    </div>
                  ) : voices.length === 0 ? (
                    <div className="text-center text-sm text-muted-foreground py-8">
                      {activeProvider === 'voicebox'
                        ? 'No profiles found. Make sure Voicebox is running and has voice profiles.'
                        : 'No voices found. Try a different search.'}
                    </div>
                  ) : (
                    <div className="divide-y">
                      {voices.map((voice) => (
                        <VoiceRow key={voice.id} voice={voice} selected={voice.id === voiceId} onSelect={handleSelectVoice} />
                      ))}
                    </div>
                  )
                ) : (
                  // No search — show discovery below defaults
                  <>
                    {voices.length > 0 && (
                      <>
                        <div className="px-3 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-t">
                          Discovery
                        </div>
                        <div className="divide-y">
                          {voices
                            .filter(v => !FISH_AUDIO_DEFAULT_VOICES.some(d => d.id === v.id))
                            .map((voice) => (
                              <VoiceRow key={voice.id} voice={voice} selected={voice.id === voiceId} onSelect={handleSelectVoice} />
                            ))}
                        </div>
                      </>
                    )}
                    {loadingVoices && (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}
                    {voiceError && (
                      <div className="flex items-start gap-2 p-4 text-sm text-orange-500">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        <span>{voiceError}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
