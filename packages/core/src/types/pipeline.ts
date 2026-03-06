export interface PipelineConfig {
  id: string;
  name: string;
  version: string;
  description?: string;
  defaults: PipelineDefaults;
  agents: AgentConfig[];
  steps: StepConfig[];
}

export interface PipelineDefaults {
  model?: string;
  tools?: string[];
  /** Timeout in seconds. Replaces the old `timeout` alias. */
  timeoutSeconds?: number;
  maxRetries?: number;
  /** Max agent turns before forced stop (default: 50) */
  maxTurns?: number;
  /** Max output tokens for structured output steps (default: 16384) */
  maxOutputTokens?: number;
  /** Temperature for structured output steps (default: 0.7) */
  temperature?: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  persona: string;  // Path to persona directory
  model?: string;   // Override default model
  thinkingLevel?: string; // Thinking level for this agent's model ('off'|'minimal'|'low'|'medium'|'high'|'xhigh')
  tools: string[];
}

export type StepType = 'standard' | 'loop';

export interface StepConfig {
  id: string;
  agent: string;    // References AgentConfig.id
  description?: string;
  type?: StepType;
  model?: string;   // Override model for this step (highest precedence)
  input: string;    // Template string with {{variables}}
  outputs?: string[];
  loop?: LoopConfig;
  onComplete?: string;  // Next step ID
  onResult?: Record<string, StepResultAction>;
  maxRetries?: number;
  timeoutSeconds?: number;
  /** Max agent turns before forced stop (default: 50) */
  maxTurns?: number;
  /** Max output tokens for structured output steps. Overrides pipeline default.
   *  If not set, falls back to pipeline defaults.maxOutputTokens, then 16384. */
  maxOutputTokens?: number;
  /** Temperature for structured output steps. Overrides pipeline default. */
  temperature?: number;
  /** JSON Schema for structured output. When set, the step uses constrained decoding
   *  to guarantee valid JSON matching this schema. */
  outputSchema?: {
    /** Name for the schema (used in API calls) */
    name: string;
    /** JSON Schema definition */
    schema: Record<string, unknown>;
    /** Whether to use strict mode (default: true) */
    strict?: boolean;
  };
  /** How to enforce structured output. 
   *  'response_format' = use provider's native JSON Schema enforcement (default)
   *  'tool_use' = wrap schema as a tool call for providers without native support */
  outputMethod?: 'response_format' | 'tool_use';
}

export interface LoopConfig {
  over: string;           // Variable name containing JSON array
  onEachComplete?: string; // Step to run after each item
  onAllComplete?: string;  // Step to run after all items
}

export interface StepResultAction {
  continueLoop?: boolean;
  retry?: boolean;
  notify?: {
    agent: string;
    message: string;
  };
  goto?: string;
  maxRetries?: number;
}
