/**
 * StructuredOutputRunner — Makes direct OpenAI-compatible API calls with response_format
 * for guaranteed JSON Schema compliance.
 * 
 * Used for pipeline steps that have outputSchema configured.
 * Falls back to tool_use approach when response_format is not supported.
 */
import { authFetch } from '../api/auth-fetch.js';
import { PROVIDER_ENV_MAP } from '../constants.js';

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
}

export interface StructuredOutputResult {
  success: boolean;
  data: Record<string, unknown> | null;
  rawJson: string;
  error?: string;
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

export class StructuredOutputRunner {
  private config: StructuredOutputConfig;
  
  constructor(config: StructuredOutputConfig = {}) {
    this.config = config;
  }

  /**
   * Fetch provider API keys from the DB and inject them into process.env.
   * This ensures UI-set keys are available to resolveModel() without restart.
   */
  private async injectProviderApiKeys(): Promise<void> {
    const apiBaseUrl = this.config.apiBaseUrl
      || process.env.DJINNBOT_API_URL
      || null;

    if (!apiBaseUrl) return;

    try {
      const res = await authFetch(`${apiBaseUrl}/v1/settings/providers/keys/all`);
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
    // Inject DB-stored API keys into process.env before resolving model/key
    await this.injectProviderApiKeys();

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
    console.log(`[StructuredOutput] Calling ${baseUrl} with model ${modelId} (timeout: ${options.timeout || 300_000}ms)`);
    
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
      max_tokens: 16384,
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
      console.log(`[StructuredOutput] POST ${baseUrl}/chat/completions model=${modelId} timeout=${timeoutMs}ms`);
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
      console.log(`[StructuredOutput] Parsed response. choices: ${result.choices?.length}, model: ${result.model}`);
      const content = result.choices?.[0]?.message?.content;
      console.log(`[StructuredOutput] Content length: ${content?.length ?? 'null'}, preview: ${content?.slice(0, 100)}`);
      
      if (!content) {
        // Check for refusal
        const refusal = result.choices?.[0]?.message?.refusal;
        if (refusal) {
          return { success: false, data: null, rawJson: '', error: `Model refused: ${refusal}` };
        }
        return { success: false, data: null, rawJson: '', error: 'No content in response' };
      }
      
      // Stream chunk for logging
      if (this.config.onStreamChunk) {
        this.config.onStreamChunk(options.runId, options.stepId, content);
      }
      
      // Parse — should be guaranteed valid by the provider
      try {
        const parsed = JSON.parse(content);
        return { success: true, data: parsed, rawJson: content };
      } catch (parseErr) {
        return {
          success: false,
          data: null,
          rawJson: content,
          error: `JSON parse failed despite response_format: ${parseErr}`,
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
      max_tokens: 16384,
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
      const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
      
      if (!toolCall || toolCall.function?.name !== toolName) {
        // Fall back to content if model didn't use tool
        const content = result.choices?.[0]?.message?.content;
        if (content) {
          try {
            const parsed = JSON.parse(content);
            return { success: true, data: parsed, rawJson: content };
          } catch {
            return { success: false, data: null, rawJson: content || '', error: 'Model did not call tool and content is not valid JSON' };
          }
        }
        return { success: false, data: null, rawJson: '', error: 'Model did not call the expected tool' };
      }
      
      const args = toolCall.function.arguments;
      
      if (this.config.onStreamChunk) {
        this.config.onStreamChunk(options.runId, options.stepId, args);
      }
      
      try {
        const parsed = JSON.parse(args);
        return { success: true, data: parsed, rawJson: args };
      } catch (parseErr) {
        return { success: false, data: null, rawJson: args, error: `Tool call JSON parse failed: ${parseErr}` };
      }
      
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, rawJson: '', error };
    }
  }
}
