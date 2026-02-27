/**
 * AgentTtsSettings — TTS configuration for an individual agent.
 *
 * Allows enabling/disabling TTS and selecting a Fish Audio voice model.
 * Displayed on the agent detail page settings tab.
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
} from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE, updateAgentConfig } from '@/lib/api';
import { authFetch } from '@/lib/auth';
import type { AgentConfig } from '@/types/config';

interface Voice {
  id: string;
  title: string;
  description: string;
  coverImage: string;
  tags: string[];
  languages: string[];
  author: string;
}

export function AgentTtsSettings({
  agentId,
  config,
  onConfigChange,
}: {
  agentId: string;
  config: AgentConfig | null;
  onConfigChange: (updates: Partial<AgentConfig>) => void;
}) {
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync from config
  useEffect(() => {
    if (config) {
      setTtsEnabled((config as any).tts_enabled || false);
      setVoiceId((config as any).tts_voice_id || null);
      setVoiceName((config as any).tts_voice_name || null);
    }
  }, [config]);

  const handleToggle = async (enabled: boolean) => {
    setTtsEnabled(enabled);
    setSaving(true);
    try {
      await updateAgentConfig(agentId, { tts_enabled: enabled } as any);
      onConfigChange({ tts_enabled: enabled } as any);
      toast.success(enabled ? 'TTS enabled' : 'TTS disabled');
    } catch {
      toast.error('Failed to update TTS setting');
      setTtsEnabled(!enabled);
    } finally {
      setSaving(false);
    }
  };

  const loadVoices = useCallback(async (search?: string) => {
    setLoadingVoices(true);
    try {
      const params = new URLSearchParams({ page_size: '20' });
      if (search) params.set('search', search);
      const res = await authFetch(`${API_BASE}/tts/voices?${params}`);
      if (res.ok) {
        const data = await res.json();
        setVoices(data.voices || []);
      }
    } catch (err) {
      console.error('Failed to load voices:', err);
    } finally {
      setLoadingVoices(false);
    }
  }, []);

  const handleOpenPicker = () => {
    setShowVoicePicker(true);
    loadVoices();
  };

  const handleSelectVoice = async (voice: Voice) => {
    setVoiceId(voice.id);
    setVoiceName(voice.title);
    setShowVoicePicker(false);
    setSaving(true);
    try {
      await updateAgentConfig(agentId, {
        tts_voice_id: voice.id,
        tts_voice_name: voice.title,
      } as any);
      onConfigChange({
        tts_voice_id: voice.id,
        tts_voice_name: voice.title,
      } as any);
      toast.success(`Voice set to ${voice.title}`);
    } catch {
      toast.error('Failed to update voice');
    } finally {
      setSaving(false);
    }
  };

  const handleSearchVoices = () => {
    loadVoices(voiceSearch || undefined);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Volume2 className="h-4 w-4" />
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
            disabled={saving}
          />
        </div>
      </CardHeader>

      {ttsEnabled && (
        <CardContent className="pt-0 space-y-3">
          {/* Current voice */}
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <span className="text-muted-foreground">Voice: </span>
              {voiceName ? (
                <span className="font-medium">{voiceName}</span>
              ) : (
                <span className="text-muted-foreground italic">Default (no specific voice)</span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenPicker}
              className="h-7 text-xs"
            >
              {voiceId ? 'Change Voice' : 'Select Voice'}
            </Button>
          </div>

          {/* Voice picker modal */}
          {showVoicePicker && (
            <div className="border rounded-lg p-3 space-y-3 bg-card">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Select a Voice</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowVoicePicker(false)}
                  className="h-6 w-6 p-0"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>

              {/* Search */}
              <div className="flex gap-2">
                <Input
                  placeholder="Search voices..."
                  value={voiceSearch}
                  onChange={(e) => setVoiceSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearchVoices()}
                  className="text-sm h-8"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSearchVoices}
                  className="h-8"
                >
                  <Search className="h-3 w-3" />
                </Button>
              </div>

              {/* Voice list */}
              <div className="max-h-64 overflow-y-auto space-y-1">
                {loadingVoices ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : voices.length === 0 ? (
                  <div className="text-center text-sm text-muted-foreground py-4">
                    No voices found. Try a different search.
                  </div>
                ) : (
                  voices.map((voice) => (
                    <button
                      key={voice.id}
                      onClick={() => handleSelectVoice(voice)}
                      className={`w-full flex items-center gap-3 p-2 rounded-md text-left hover:bg-muted transition-colors ${
                        voice.id === voiceId ? 'bg-muted ring-1 ring-primary' : ''
                      }`}
                    >
                      {voice.coverImage ? (
                        <img
                          src={voice.coverImage}
                          alt={voice.title}
                          className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                          <Volume2 className="h-3 w-3 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{voice.title}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {voice.author && `by ${voice.author}`}
                          {voice.languages.length > 0 && ` | ${voice.languages.join(', ')}`}
                        </div>
                      </div>
                      {voice.id === voiceId && (
                        <Check className="h-4 w-4 text-primary flex-shrink-0" />
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
