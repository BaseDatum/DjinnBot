import { z } from 'zod';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { PipelineConfig } from '../types/pipeline.js';

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────────

const StepResultActionSchema = z.object({
  continueLoop: z.boolean().optional(),
  retry: z.boolean().optional(),
  notify: z.object({
    agent: z.string(),
    message: z.string(),
  }).optional(),
  goto: z.string().optional(),
  maxRetries: z.number().optional(),
});

const LoopConfigSchema = z.object({
  over: z.string(), // Variable name containing array (e.g., "task_breakdown_json")
  onEachComplete: z.string().optional(), // Step ID to run after each iteration
  onAllComplete: z.string().optional(), // Step ID to run after loop finishes
});

const OutputSchemaConfigSchema = z.object({
  name: z.string(),
  strict: z.boolean().optional(),
  schema: z.record(z.unknown()),
}).optional();

const StepConfigSchema = z.object({
  id: z.string(),
  agent: z.string(), // References AgentConfig.id
  description: z.string().optional(),
  type: z.enum(['standard', 'loop']).optional(),
  input: z.string(), // Template string with {{variables}}
  outputs: z.array(z.string()).optional(),
  loop: LoopConfigSchema.optional(),
  onComplete: z.string().optional(), // Step ID to run next
  onResult: z.record(z.string(), StepResultActionSchema).optional(), // Conditional actions
  maxRetries: z.number().optional(),
  timeoutSeconds: z.number().optional(),
  maxTurns: z.number().optional(),
  outputSchema: OutputSchemaConfigSchema,
  outputMethod: z.enum(['response_format', 'tool_use']).optional(),
});

const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  persona: z.string(), // Path to persona .md file
  model: z.string().optional(),
  tools: z.array(z.string()).optional().default([]),
});

const PipelineConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  defaults: z.object({
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    maxRetries: z.number().optional(),
    timeout: z.number().optional(),
    timeoutSeconds: z.number().optional(),
    maxTurns: z.number().optional(),
  }).default({}).transform(d => ({
    ...d,
    timeoutSeconds: d.timeoutSeconds ?? d.timeout,
    timeout: undefined,
  })),
  agents: z.array(AgentConfigSchema),
  steps: z.array(StepConfigSchema),
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-Reference Validation
// ─────────────────────────────────────────────────────────────────────────────

function validateCrossReferences(config: z.infer<typeof PipelineConfigSchema>): void {
  const agentIds = new Set(config.agents.map(a => a.id));
  const stepIds = new Set(config.steps.map(s => s.id));

  // Validate step.agent references
  for (const step of config.steps) {
    if (!agentIds.has(step.agent)) {
      throw new Error(
        `Step "${step.id}" references unknown agent "${step.agent}". ` +
        `Available agents: ${Array.from(agentIds).join(', ')}`
      );
    }

    // Validate onComplete references
    if (step.onComplete && !stepIds.has(step.onComplete)) {
      throw new Error(
        `Step "${step.id}" onComplete references unknown step "${step.onComplete}". ` +
        `Available steps: ${Array.from(stepIds).join(', ')}`
      );
    }

    // Validate loop references
    if (step.loop) {
      if (step.loop.onEachComplete && !stepIds.has(step.loop.onEachComplete)) {
        throw new Error(
          `Step "${step.id}" loop.onEachComplete references unknown step "${step.loop.onEachComplete}". ` +
          `Available steps: ${Array.from(stepIds).join(', ')}`
        );
      }
      if (step.loop.onAllComplete && !stepIds.has(step.loop.onAllComplete)) {
        throw new Error(
          `Step "${step.id}" loop.onAllComplete references unknown step "${step.loop.onAllComplete}". ` +
          `Available steps: ${Array.from(stepIds).join(', ')}`
        );
      }
    }

    // Validate onResult goto references
    if (step.onResult) {
      for (const [resultKey, action] of Object.entries(step.onResult)) {
        if (action.goto && !stepIds.has(action.goto)) {
          throw new Error(
            `Step "${step.id}" onResult.${resultKey}.goto references unknown step "${action.goto}". ` +
            `Available steps: ${Array.from(stepIds).join(', ')}`
          );
        }
        if (action.notify?.agent && !agentIds.has(action.notify.agent)) {
          throw new Error(
            `Step "${step.id}" onResult.${resultKey}.notify.agent references unknown agent "${action.notify.agent}". ` +
            `Available agents: ${Array.from(agentIds).join(', ')}`
          );
        }
      }
    }
  }

  // Check for duplicate IDs
  const agentIdCounts = new Map<string, number>();
  const stepIdCounts = new Map<string, number>();

  for (const agent of config.agents) {
    agentIdCounts.set(agent.id, (agentIdCounts.get(agent.id) || 0) + 1);
  }
  for (const step of config.steps) {
    stepIdCounts.set(step.id, (stepIdCounts.get(step.id) || 0) + 1);
  }

  for (const [id, count] of agentIdCounts.entries()) {
    if (count > 1) {
      throw new Error(`Duplicate agent ID: "${id}" appears ${count} times`);
    }
  }
  for (const [id, count] of stepIdCounts.entries()) {
    if (count > 1) {
      throw new Error(`Duplicate step ID: "${id}" appears ${count} times`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a pipeline configuration object.
 * Checks structure and cross-references.
 * @throws {Error} If validation fails with detailed error messages
 */
export function validatePipeline(config: unknown): PipelineConfig {
  // Zod schema validation
  const parsed = PipelineConfigSchema.parse(config);

  // Cross-reference validation
  validateCrossReferences(parsed);

  return parsed as PipelineConfig;
}

/**
 * Parse and validate a pipeline YAML file.
 * @param yamlPath Path to the YAML file
 * @returns Validated PipelineConfig object
 * @throws {Error} If file cannot be read, parsed, or validated
 */
export function parsePipeline(yamlPath: string): PipelineConfig {
  let fileContent: string;
  let yamlData: unknown;

  // Read file
  try {
    fileContent = readFileSync(yamlPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to read pipeline file "${yamlPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Parse YAML
  try {
    yamlData = parseYaml(fileContent);
  } catch (error) {
    throw new Error(
      `Failed to parse YAML in "${yamlPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Validate
  try {
    return validatePipeline(yamlData);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(issue => 
        `  - ${issue.path.join('.')}: ${issue.message}`
      ).join('\n');
      throw new Error(
        `Pipeline validation failed for "${yamlPath}":\n${issues}`
      );
    }
    throw error;
  }
}
