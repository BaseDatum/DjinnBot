/**
 * Template variable resolution for pipeline step inputs.
 * 
 * Resolves {{variable_name}} placeholders with actual values from:
 * - Accumulated step outputs
 * - Loop variables (current_item, completed_items, progress_file)
 * - Initial pipeline inputs (task_description, etc.)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Template Parsing
// ─────────────────────────────────────────────────────────────────────────────

const VARIABLE_PATTERN = /\{\{([a-zA-Z0-9_]+)\}\}/g;

/**
 * Extract all variable names from a template string.
 * @param template String containing {{variable_name}} placeholders
 * @returns Array of variable names (without {{ }})
 * @example
 * extractVariables("Read {{file_path}} and {{action}}")
 * // => ["file_path", "action"]
 */
export function extractVariables(template: string): string[] {
  const variables: string[] = [];
  const matches = template.matchAll(VARIABLE_PATTERN);
  
  for (const match of matches) {
    const varName = match[1];
    if (!variables.includes(varName)) {
      variables.push(varName);
    }
  }
  
  return variables;
}

// Pattern for conditional blocks: {% if varname %}...{% endif %}
const CONDITIONAL_PATTERN = /\{%\s*if\s+([a-zA-Z0-9_]+)\s*\%\}([\s\S]*?)\{%\s*endif\s*\%\}/g;

/**
 * Resolve all {{variable}} placeholders in a template string.
 * Also handles basic conditionals: {% if varname %}...{% endif %}
 * If the variable is empty/undefined, the conditional block is removed.
 * @param template String containing {{variable_name}} placeholders
 * @param variables Object mapping variable names to values
 * @returns Resolved string with all placeholders replaced
 * @throws {Error} If a required variable is missing
 * @example
 * resolveTemplate("Hello {{name}}!", { name: "World" })
 * // => "Hello World!"
 */
export function resolveTemplate(
  template: string,
  variables: Record<string, string>
): string {
  // First, process conditionals
  let result = template.replace(CONDITIONAL_PATTERN, (match, varName, content) => {
    // If variable exists and is truthy, keep the content; otherwise, remove the block
    const value = variables[varName];
    if (value && value.trim() !== '') {
      return content;
    }
    return '';
  });

  // Then, resolve regular variables
  const requiredVars = extractVariables(result);
  const missingVars = requiredVars.filter(varName => !(varName in variables));

  if (missingVars.length > 0) {
    console.warn(
      `[Template] Missing variables (replaced with empty): ${missingVars.join(', ')}. ` +
      `Available: ${Object.keys(variables).join(', ')}`
    );
  }

  return result.replace(VARIABLE_PATTERN, (match, varName) => {
    return variables[varName] ?? ''; // Replace missing variables with empty string
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Loop Variable Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create loop-specific variables for the current iteration.
 * @param currentItem The current item in the loop
 * @param completedItems Array of items completed so far
 * @param progressFile Path to the progress tracking file
 * @returns Object with loop variable names
 */
export function createLoopVariables(
  currentItem: string,
  completedItems: string[],
  progressFile: string
): Record<string, string> {
  return {
    current_item: currentItem,
    completed_items: JSON.stringify(completedItems),
    progress_file: progressFile,
  };
}

/**
 * Merge multiple variable sources for template resolution.
 * Later sources override earlier ones.
 * @param sources Variable objects to merge (order matters)
 * @returns Merged variable object
 */
export function mergeVariables(
  ...sources: Record<string, string>[]
): Record<string, string> {
  return Object.assign({}, ...sources);
}
