import type { AgentState } from '@/types/lifecycle';
import { MessageType } from '@/types/inbox';

export const STATE_CONFIG: Record<AgentState, { color: string; textColor: string; label: string; emoji: string }> = {
  idle: { color: 'bg-green-500', textColor: 'text-green-400', label: 'IDLE', emoji: '🟢' },
  working: { color: 'bg-blue-500', textColor: 'text-blue-400', label: 'WORKING', emoji: '🔵' },
  thinking: { color: 'bg-purple-500', textColor: 'text-purple-400', label: 'THINKING', emoji: '🟣' },
};

export const MESSAGE_TYPE_CONFIG: Record<MessageType, { icon: string; label: string; color: string }> = {
  info: { icon: 'Info', label: 'Info', color: 'text-blue-500' },
  review_request: { icon: 'FileQuestion', label: 'Review Request', color: 'text-purple-500' },
  help_request: { icon: 'HelpCircle', label: 'Help Request', color: 'text-orange-500' },
  urgent: { icon: 'AlertCircle', label: 'Urgent', color: 'text-red-500' },
  work_assignment: { icon: 'Briefcase', label: 'Work Assignment', color: 'text-green-500' },
};

export const SIZE_CONFIG = {
  sm: { dot: 'h-1.5 w-1.5', text: 'text-xs', padding: 'px-1.5 py-0.5', gap: 'gap-1' },
  md: { dot: 'h-2 w-2', text: 'text-sm', padding: 'px-2 py-1', gap: 'gap-1.5' },
  lg: { dot: 'h-2.5 w-2.5', text: 'text-base', padding: 'px-3 py-1.5', gap: 'gap-2' },
} as const;

// Chat model constants — empty so the ProviderModelSelector opens at the provider stage
export const DEFAULT_CHAT_MODEL = '';

export const CHAT_MODEL_OPTIONS = [
  { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
  { value: 'anthropic/claude-opus-4', label: 'Claude Opus 4' },
  { value: 'openrouter/moonshotai/kimi-k2.5', label: 'Kimi K2.5' },
  { value: 'openrouter/google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'openrouter/openai/gpt-4o', label: 'GPT-4o' },
] as const;
