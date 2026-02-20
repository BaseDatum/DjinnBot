import type { AgentRunner, RunAgentOptions, AgentRunResult } from './agent-executor.js';

/**
 * MockRunner — testing implementation of AgentRunner.
 * Returns configurable responses for pipeline testing without LLM calls.
 */
export class MockRunner implements AgentRunner {
  private responses: Map<string, string> = new Map();
  private defaultResponse: string;
  private delay: number;

  constructor(options?: { defaultResponse?: string; delayMs?: number }) {
    this.defaultResponse = options?.defaultResponse ??
      'STATUS: done\nRESULT: Mock agent completed successfully\nCHANGES: No changes made (mock)';
    this.delay = options?.delayMs ?? 100;
  }

  /**
   * Set a custom response for a specific step.
   */
  setResponse(stepId: string, output: string): void {
    this.responses.set(stepId, output);
  }

  /**
   * Set a response that simulates failure.
   */
  setFailure(stepId: string, error: string): void {
    this.responses.set(stepId, `STATUS: failed\nERROR: ${error}`);
  }

  async runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
    const sessionId = `mock_${options.runId}_${options.stepId}_${Date.now()}`;

    // Simulate processing time
    await new Promise((resolve) => setTimeout(resolve, this.delay));

    // Use custom response if set, otherwise generate step-appropriate mock output
    const output = this.responses.get(options.stepId) || this.generateStepOutput(options.stepId);

    console.log(`[MockRunner] Step ${options.stepId} completed (agent: ${options.agentId})`);

    return {
      sessionId,
      output,
      success: true,
    };
  }

  /**
   * Generate mock output appropriate for common step types.
   * Produces the output keys that engineering pipeline steps expect.
   */
  private generateStepOutput(stepId: string): string {
    const stepOutputs: Record<string, string> = {
      SPEC: [
        'STATUS: done',
        'PRODUCT_BRIEF: Mock product brief for testing',
        'REQUIREMENTS_DOC: Mock requirements document',
        'USER_STORIES_JSON: [{"id": "US-1", "title": "Basic CRUD", "priority": "P0"}]',
        'SUCCESS_METRICS: Mock success metrics',
      ].join('\n'),
      DESIGN: [
        'STATUS: done',
        'ARCHITECTURE_DOC: Mock architecture document',
        'API_DESIGN: Mock API design',
        'DB_SCHEMA: Mock database schema',
        'COMPONENT_BREAKDOWN_JSON: ["Header", "TodoList", "TodoItem", "AddTodoForm"]',
        'TASK_BREAKDOWN_JSON: ["Set up project scaffolding", "Implement API endpoints", "Build UI components"]',
        'DEPLOYMENT_PLAN: Mock deployment plan',
      ].join('\n'),
      UX: [
        'STATUS: done',
        'UX_SPEC: Mock UX specification',
        'DESIGN_SYSTEM: Mock design system',
        'COMPONENT_SPECS_JSON: {"TodoList": {"states": ["empty", "loaded"]}}',
        'ACCESSIBILITY_NOTES: Mock accessibility notes',
      ].join('\n'),
      IMPLEMENT: [
        'STATUS: done',
        'IMPLEMENTATION_NOTES: Mock implementation completed',
        'FILES_CHANGED: src/App.tsx, src/api.ts',
        'COMMIT_HASH: mock-abc123',
      ].join('\n'),
      REVIEW: [
        'STATUS: done',
        'REVIEW_RESULT: APPROVED',
        'REVIEW_FEEDBACK: Code looks good',
        'CODE_QUALITY_NOTES: Clean implementation',
      ].join('\n'),
      TEST: [
        'STATUS: done',
        'TEST_RESULT: PASS',
        'TEST_REPORT: All tests passed',
        'BUG_REPORTS_JSON: []',
        'REGRESSION_NOTES: No regressions found',
      ].join('\n'),
      DEPLOY: [
        'STATUS: done',
        'DEPLOY_STATUS: SUCCESS',
        'DEPLOY_URL: https://mock-app.example.com',
        'INFRA_NOTES: Mock infrastructure notes',
        'MONITORING_CONFIG: Mock monitoring configured',
      ].join('\n'),
    };

    return stepOutputs[stepId] || this.defaultResponse;
  }
}
