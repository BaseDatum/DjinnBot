/**
 * Pipeline YAML parser and template system.
 * 
 * @module pipeline
 */

export { parsePipeline, validatePipeline } from './parser.js';
export {
  resolveTemplate,
  extractVariables,
  createLoopVariables,
  mergeVariables,
} from './template.js';
