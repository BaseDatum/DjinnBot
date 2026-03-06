/**
 * StructuredOutputRunner — Makes direct OpenAI-compatible API calls with response_format
 * for guaranteed JSON Schema compliance.
 * 
 * Used for pipeline steps that have outputSchema configured.
 * Falls back to tool_use approach when response_format is not supported.
 */
import { authFetch } from '../api/auth-fetch.js';
import { PROVIDER_ENV_MAP } from '../constants.js';

/** Default max output tokens. Large enough for validation/rewrite steps that need
 *  to reproduce large structured data (e.g. 50K+ char task breakdowns). */
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export interface StructuredOutputConfig {
  onStreamChunk?: (runId: string, stepId: string, chunk: string) => void;
  /**
   * Base URL of the Python API server (e.g. "http://api:8000").
   * When set, provider API keys are fetched from the DB before each request.
   */
  apiBaseUrl?: string;
}

export interface StructuredOutputOptions {
  runId: string;
  stepId: string;
  model: string;           // e.g. "openrouter/moonshotai/kimi-k2.5"
  systemPrompt: string;
  userPrompt: string;
  outputSchema: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
  outputMethod?: 'response_format' | 'tool_use';
  timeout?: number;
  temperature?: number;
  /** Max output tokens for the structured output call. Defaults to DEFAULT_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
  /** DjinnBot user ID for per-user provider key resolution. */
  userId?: string;
}

export interface StructuredOutputResult {
  success: boolean;
  data: Record<string, unknown> | null;
  rawJson: string;
  error?: string;
  /** The model that actually served the request (from the API response). */
  modelUsed?: string;
  /** The finish reason from the API response (e.g. 'stop', 'length', 'tool_calls'). */
  finishReason?: string;
}

/**
 * Resolve model string to API base URL and actual model ID.
 */
function resolveModel(modelString: string): { baseUrl: string; modelId: string; apiKey: string } {
  const parts = modelString.split('/');
  
  if (parts[0] === 'openrouter' || parts.length > 2) {
    // OpenRouter model: openrouter/provider/model-name
    const modelId = parts.slice(1).join('/');
    return {
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId,
      apiKey: process.env.OPENROUTER_API_KEY || '',
    };
  }
  
  // Direct provider mapping
  const provider = parts[0];
  const modelId = parts.slice(1).join('/');
  
  // Note: Only include providers with OpenAI-compatible APIs.
  // Anthropic and Google use different API formats (/v1/messages, different auth headers, etc.)
  // and are routed through OpenRouter for structured output compatibility.
  const providerMap: Record<string, { baseUrl: string; envKey: string }> = {
    openai: { baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY' },
    xai: { baseUrl: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY' },
  };
  
  const config = providerMap[provider];
  if (!config || !process.env[config.envKey]) {
    // Unknown provider or missing API key — route through OpenRouter
    return {
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: parts.length > 2 ? parts.slice(1).join('/') : modelString,
      apiKey: process.env.OPENROUTER_API_KEY || '',
    };
  }
  
  return {
    baseUrl: config.baseUrl,
    modelId,
    apiKey: process.env[config.envKey] || '',
  };
}

/**
 * Validate that a structured output is non-trivially populated.
 * Returns an error message if the output appears empty, or null if it looks OK.
 *
 * This catches the case where a model returns the minimal valid schema response
 * (e.g. {"tasks": []}) instead of actual content — typically caused by output
 * token limits being too low for the expected response size.
 */
function validateOutputNotEmpty(data: Record<string, unknown>): string | null {
  // Check all top-level array fields — if ALL are empty, the output is trivially empty
  const arrayFields: string[] = [];
  let allArraysEmpty = true;
  let hasNonArrayContent = false;

  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      arrayFields.push(key);
      if (value.length > 0) {
        allArraysEmpty = false;
      }
    } else if (value !== null && value !== undefined && value !== '') {
      hasNonArrayContent = true;
    }
  }

  // If the schema has array fields and ALL of them are empty, and there's no other
  // meaningful content, this is likely a degenerate response
  if (arrayFields.length > 0 && allArraysEmpty && !hasNonArrayContent) {
    return `Structured output has only empty arrays (${arrayFields.join(', ')}). ` +
      `This typically means the model could not produce the full output within the ` +
      `max_tokens limit. Consider increasing maxOutputTokens for this step.`;
  }

  return null;
}

export class StructuredOutputRunner {
  private config: StructuredOutputConfig;
  
  constructor(config: StructuredOutputConfig = {}) {
    this.config = config;
  }

  /**
   * Fetch provider API keys from the DB and inject them into process.env.
   * This ensures UI-set keys are available to resolveModel() without restart.
   */
  private async injectProviderApiKeys(userId?: string): Promise<void> {
    const apiBaseUrl = this.config.apiBaseUrl
      || process.env.DJINNBOT_API_URL
      || null;

    if (!apiBaseUrl) return;

    const userParam = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
    try {
      const res = await authFetch(`${apiBaseUrl}/v1/settings/providers/keys/all${userParam}`);
      if (res.ok) {
        const data = await res.json() as { keys: Record<string, string> };
        for (const [providerId, apiKey] of Object.entries(data.keys ?? {})) {
          const envVar = PROVIDER_ENV_MAP[providerId];
          if (envVar && apiKey) {
            process.env[envVar] = apiKey;
          }
        }
      }
    } catch (err) {
      console.warn('[StructuredOutputRunner] Failed to fetch provider keys from settings:', err);
    }
  }

  /**
   * Run a structured output request using response_format (default) or tool_use fallback.
   */
  async run(options: StructuredOutputOptions): Promise<StructuredOutputResult> {
    // Inject DB-stored API keys into process.env before resolving model/key.
    // Pass userId so per-user key resolution is applied when the run is scoped
    // to a specific user.
    await this.injectProviderApiKeys(options.userId);

    const method = options.outputMethod || 'response_format';
    
    if (method === 'tool_use') {
      return this.runWithToolUse(options);
    }
    
    return this.runWithResponseFormat(options);
  }
  
  /**
   * Primary method: Use response_format with JSON Schema for constrained decoding.
   * Works with OpenAI, OpenRouter (passthrough), xAI, and most modern providers.
   */
  private async runWithResponseFormat(options: StructuredOutputOptions): Promise<StructuredOutputResult> {
    const { baseUrl, modelId, apiKey } = resolveModel(options.model);
    const maxTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    console.log(`[StructuredOutput] Calling ${baseUrl} with model ${modelId} (max_tokens: ${maxTokens}, timeout: ${options.timeout || 300_000}ms)`);
    
    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: options.outputSchema.name,
          strict: options.outputSchema.strict !== false,
          schema: options.outputSchema.schema,
        },
      },
      temperature: options.temperature ?? 0.7,
      max_tokens: maxTokens,
    };
    
    // Add OpenRouter-specific headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    
    if (baseUrl.includes('openrouter')) {
      headers['HTTP-Referer'] = 'https://djinnbot.dev';
      headers['X-Title'] = 'DjinnBot';
      // Tell OpenRouter to only route to models that support structured output
      (requestBody as any).provider = {
        require_parameters: true,
      };
    }
    
    const controller = new AbortController();
    const timeoutMs = options.timeout || 300_000;
    const timeoutId = setTimeout(() => {
      console.error(`[StructuredOutput] TIMEOUT after ${timeoutMs}ms for ${modelId} — aborting`);
      controller.abort();
    }, timeoutMs);
    
    try {
      console.log(`[StructuredOutput] POST ${baseUrl}/chat/completions model=${modelId} max_tokens=${maxTokens} timeout=${timeoutMs}ms`);
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      console.log(`[StructuredOutput] Response: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        const errorBody = await response.text();
        
        // If response_format is not supported, fall back to tool_use
        if (response.status === 400 && (
          errorBody.includes('response_format') || 
          errorBody.includes('json_schema') ||
          errorBody.includes('not supported')
        )) {
          console.warn(`[StructuredOutput] response_format not supported for ${options.model}, falling back to tool_use`);
          return this.runWithToolUse(options);
        }
        
        return {
          success: false,
          data: null,
          rawJson: '',
          error: `API error ${response.status}: ${errorBody}`,
        };
      }
      
      console.log(`[StructuredOutput] Reading response body...`);
      const bodyText = await response.text();
      console.log(`[StructuredOutput] Body length: ${bodyText.length}, preview: ${bodyText.slice(0, 200)}`);
      const result = JSON.parse(bodyText);
      const modelUsed = result.model ?? modelId;
      const finishReason = result.choices?.[0]?.finish_reason;
      console.log(`[StructuredOutput] Parsed response. choices: ${result.choices?.length}, model: ${modelUsed}, finish_reason: ${finishReason}`);
      const content = result.choices?.[0]?.message?.content;
      console.log(`[StructuredOutput] Content length: ${content?.length ?? 'null'}, preview: ${content?.slice(0, 100)}`);
      
      // Check finish_reason — 'length' means output was truncated due to max_tokens
      if (finishReason === 'length') {
        console.error(`[StructuredOutput] TRUNCATED: finish_reason=length for ${modelId} (max_tokens=${maxTokens}). Output was cut off.`);
        return {
          success: false,
          data: null,
          rawJson: content || '',
          error: `Output truncated (finish_reason=length). The model ran out of output tokens ` +
            `(max_tokens=${maxTokens}). Increase maxOutputTokens for this step.`,
          modelUsed,
          finishReason,
        };
      }
      
      if (!content) {
        // Check for refusal
        const refusal = result.choices?.[0]?.message?.refusal;
        if (refusal) {
          return { success: false, data: null, rawJson: '', error: `Model refused: ${refusal}`, modelUsed, finishReason };
        }
        return { success: false, data: null, rawJson: '', error: 'No content in response', modelUsed, finishReason };
      }
      
      // Stream chunk for logging
      if (this.config.onStreamChunk) {
        this.config.onStreamChunk(options.runId, options.stepId, content);
      }
      
      // Parse — should be guaranteed valid by the provider
      try {
        const parsed = JSON.parse(content);

        // Validate that the output is non-trivially populated
        const emptyError = validateOutputNotEmpty(parsed);
        if (emptyError) {
          console.error(`[StructuredOutput] EMPTY OUTPUT: ${emptyError} (model=${modelUsed}, max_tokens=${maxTokens}, finish_reason=${finishReason})`);
          return {
            success: false,
            data: parsed,
            rawJson: content,
            error: emptyError,
            modelUsed,
            finishReason,
          };
        }

        return { success: true, data: parsed, rawJson: content, modelUsed, finishReason };
      } catch (parseErr) {
        return {
          success: false,
          data: null,
          rawJson: content,
          error: `JSON parse failed despite response_format: ${parseErr}`,
          modelUsed,
          finishReason,
        };
      }
      
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, rawJson: '', error };
    }
  }
  
  /**
   * Fallback method: Use tool_use/function calling to enforce JSON schema.
   * Works with all providers that support function calling (including Anthropic).
   */
  private async runWithToolUse(options: StructuredOutputOptions): Promise<StructuredOutputResult> {
    const { baseUrl, modelId, apiKey } = resolveModel(options.model);
    const maxTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    
    const toolName = `submit_${options.outputSchema.name}`;
    
    const requestBody: Record<string, unknown> = {
      model: modelId,
      messages: [
        { role: 'system', content: options.systemPrompt },
        { 
          role: 'user', 
          content: `${options.userPrompt}\n\nYou MUST call the ${toolName} tool with your response. Do not output any text — only call the tool.`
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: toolName,
            description: `Submit the structured output for this step. The output must conform to the required schema.`,
            parameters: options.outputSchema.schema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: toolName } },
      temperature: options.temperature ?? 0.7,
      max_tokens: maxTokens,
    };
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    
    if (baseUrl.includes('openrouter')) {
      headers['HTTP-Referer'] = 'https://djinnbot.dev';
      headers['X-Title'] = 'DjinnBot';
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 300_000);
    
    try {
      console.log(`[StructuredOutput] tool_use POST ${baseUrl}/chat/completions model=${modelId} max_tokens=${maxTokens}`);
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, data: null, rawJson: '', error: `API error ${response.status}: ${errorBody}` };
      }
      
      const result = await response.json() as any;
      const modelUsed = result.model ?? modelId;
      const finishReason = result.choices?.[0]?.finish_reason;

      console.log(`[StructuredOutput] tool_use response: model=${modelUsed}, finish_reason=${finishReason}`);

      // Check finish_reason — 'length' means output was truncated
      if (finishReason === 'length') {
        console.error(`[StructuredOutput] TRUNCATED: finish_reason=length for tool_use (model=${modelUsed}, max_tokens=${maxTokens})`);
        return {
          success: false,
          data: null,
          rawJson: '',
          error: `Output truncated (finish_reason=length). The model ran out of output tokens ` +
            `(max_tokens=${maxTokens}). Increase maxOutputTokens for this step.`,
          modelUsed,
          finishReason,
        };
      }

      const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
      
      if (!toolCall || toolCall.function?.name !== toolName) {
        // Fall back to content if model didn't use tool
        const content = result.choices?.[0]?.message?.content;
        if (content) {
          try {
            const parsed = JSON.parse(content);
            const emptyError = validateOutputNotEmpty(parsed);
            if (emptyError) {
              return { success: false, data: parsed, rawJson: content, error: emptyError, modelUsed, finishReason };
            }
            return { success: true, data: parsed, rawJson: content, modelUsed, finishReason };
          } catch {
            return { success: false, data: null, rawJson: content || '', error: 'Model did not call tool and content is not valid JSON', modelUsed, finishReason };
          }
        }
        return { success: false, data: null, rawJson: '', error: 'Model did not call the expected tool', modelUsed, finishReason };
      }
      
      const args = toolCall.function.arguments;
      
      if (this.config.onStreamChunk) {
        this.config.onStreamChunk(options.runId, options.stepId, args);
      }
      
      try {
        const parsed = JSON.parse(args);
        const emptyError = validateOutputNotEmpty(parsed);
        if (emptyError) {
          return { success: false, data: parsed, rawJson: args, error: emptyError, modelUsed, finishReason };
        }
        return { success: true, data: parsed, rawJson: args, modelUsed, finishReason };
      } catch (parseErr) {
        return { success: false, data: null, rawJson: args, error: `Tool call JSON parse failed: ${parseErr}`, modelUsed, finishReason };
      }
      
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, rawJson: '', error };
    }
  }
}
