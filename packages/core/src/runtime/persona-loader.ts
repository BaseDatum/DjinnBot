import { readFile } from 'fs/promises';
import { join } from 'path';

export interface StepContext {
  stepId: string;
  outputs?: string[];
  input?: string;
  useTools?: boolean;
}

export interface SessionContext {
  sessionType: 'slack' | 'pulse' | 'pipeline' | 'chat';
  runId?: string;
  channelContext?: string;
  installedTools?: string[];
  /** API base URL for the DjinnBot server (e.g. http://api:8000) */
  apiBaseUrl?: string;
}

export interface AgentPersona {
  agentId: string;
  identity: string;
  soul: string;
  agents: string;
  decision: string;
  systemPrompt: string;
}

interface ManifestEntry {
  id: string;
  description: string;
  tags: string[];
}

interface ManifestResponse {
  skills: ManifestEntry[];
  manifest_text: string;
}

export class PersonaLoader {
  constructor(private agentsDir: string) {}

  /**
   * Fetch the skills manifest for an agent from the DjinnBot API.
   * Returns the pre-built manifest_text ready for injection.
   * Falls back gracefully to empty string if the API is unreachable.
   */
  private async fetchSkillManifest(agentId: string, apiBaseUrl: string): Promise<string> {
    try {
      const url = `${apiBaseUrl}/v1/skills/agents/${agentId}/manifest`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        console.warn(`[PersonaLoader] Manifest API returned ${res.status} for ${agentId}`);
        return '';
      }
      const data = await res.json() as ManifestResponse;
      if (data.skills.length > 0) {
        console.log(`[PersonaLoader] Loaded manifest with ${data.skills.length} skills for ${agentId}`);
      }
      return data.manifest_text ?? '';
    } catch (err) {
      console.warn(`[PersonaLoader] Could not fetch skill manifest for ${agentId} (${apiBaseUrl}): ${err}`);
      return '';
    }
  }

  /**
   * Load persona for an agent by ID.
   */
  async loadPersona(agentId: string, stepContext?: StepContext, sessionContext?: SessionContext): Promise<AgentPersona> {
    const agentDir = join(this.agentsDir, agentId);

    const apiBaseUrl = sessionContext?.apiBaseUrl
      || process.env.DJINNBOT_API_URL
      || 'http://api:8000';

    const [identity, soul, agents, decision, memoryToolsTemplate, manifestText] = await Promise.all([
      this.loadFileIfExists(join(agentDir, 'IDENTITY.md')),
      this.loadFileIfExists(join(agentDir, 'SOUL.md')),
      this.loadFileIfExists(join(agentDir, 'AGENTS.md')),
      this.loadFileIfExists(join(agentDir, 'DECISION.md')),
      this.loadMemoryToolsTemplate(),
      this.fetchSkillManifest(agentId, apiBaseUrl),
    ]);

    if (!identity && !soul && !agents) {
      console.warn(`[PersonaLoader] No persona files found for ${agentId}, using defaults`);
    }

    const systemPrompt = this.assembleSystemPrompt(
      agentId,
      identity || `You are ${agentId}, an AI assistant.`,
      soul || '',
      agents || '',
      decision || '',
      stepContext,
      sessionContext,
      stepContext?.useTools ?? true,
      memoryToolsTemplate,
      manifestText,
    );

    return {
      agentId,
      identity: identity || '',
      soul: soul || '',
      agents: agents || '',
      decision: decision || '',
      systemPrompt,
    };
  }

  /**
   * Load persona for a Slack/ad-hoc session with full context.
   */
  async loadPersonaForSession(
    agentId: string,
    sessionContext: SessionContext,
  ): Promise<AgentPersona> {
    return this.loadPersona(agentId, undefined, sessionContext);
  }

  private async loadFileIfExists(filePath: string): Promise<string | null> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return content.trim();
    } catch {
      return null;
    }
  }

  private memoryToolsCache: string | null | undefined = undefined;

  private async loadMemoryToolsTemplate(): Promise<string> {
    if (this.memoryToolsCache !== undefined) return this.memoryToolsCache ?? '';
    const templatePath = join(this.agentsDir, '_templates', 'MEMORY_TOOLS.md');
    const content = await this.loadFileIfExists(templatePath);
    this.memoryToolsCache = content;
    if (content) {
      console.log(`[PersonaLoader] Loaded MEMORY_TOOLS.md (${content.length} chars)`);
    } else {
      console.warn('[PersonaLoader] _templates/MEMORY_TOOLS.md not found — memory doctrine will not be injected');
    }
    return content ?? '';
  }

  private assembleSystemPrompt(
    agentId: string,
    identity: string,
    soul: string,
    agents: string,
    decision: string,
    stepContext?: StepContext,
    sessionContext?: SessionContext,
    useTools: boolean = true,
    memoryToolsTemplate: string = '',
    manifestText: string = '',
  ): string {
    const sections: string[] = [];

    if (identity) {
      sections.push('# IDENTITY', identity);
    }

    if (soul) {
      sections.push('# SOUL', soul);
    }

    if (decision) {
      sections.push('# DECISION FRAMEWORK', decision);
    }

    if (agents) {
      sections.push('# OTHER AGENTS', agents);
    }

    sections.push(this.buildEnvironmentSection(agentId, sessionContext));

    if (useTools) {
      const toolLines: string[] = [
        '# TOOLS & COMPLETION',
        '',
        'You have tools available. You MUST call `complete` or `fail` when finished.',
        '',
        '## `complete` — Signal task completion',
        'Call this when you have successfully completed your assigned task.',
        'Provide all required outputs as key-value pairs in the `outputs` parameter.',
        '',
      ];

      if (stepContext?.outputs && stepContext.outputs.length > 0) {
        toolLines.push(
          '**Required output keys for this step:**',
          ...stepContext.outputs.map(key => `- \`${key}\``),
          '',
          'Example:',
          '```',
          'complete({',
          '  status: "done",',
          '  outputs: {',
          ...stepContext.outputs.map(key => `    "${key}": "your value here",`),
          '  },',
          '  summary: "Brief description of what was done"',
          '})',
          '```',
          '',
        );
      }

      toolLines.push(
        '## `fail` — Signal task failure',
        'Call this if you cannot complete the task. Explain what went wrong clearly.',
        'Set `recoverable: true` if retrying with different context might help.',
        '',
        '## `share_knowledge` — Share learnings with other agents',
        'Call this during your work to share important decisions, patterns, issues,',
        'or conventions that other agents in later pipeline steps should know about.',
        'Categories: pattern, decision, issue, convention',
        'Importance: low, medium, high, critical',
        '',
        '⚠️ IMPORTANT: You MUST call `complete` or `fail` before finishing.',
        'Do NOT just output text without calling a tool.',
        '',
        '## Coding Tools',
        'You have file system tools: read, write, edit, bash, grep, find, ls.',
        'All file paths are relative to your workspace root.',
        'Use ls/find to explore, read before editing, and bash for shell commands.',
        'Bash commands run in an isolated container — you cannot affect the host system.',
      );

      sections.push(toolLines.join('\n'));

      if (memoryToolsTemplate) {
        sections.push(memoryToolsTemplate);
      }
    } else {
      if (stepContext?.outputs && stepContext.outputs.length > 0) {
        sections.push(
          '# OUTPUT FORMAT',
          'When you complete your task, output your results using KEY: VALUE pairs.',
          '',
          'Required outputs for this step:',
          stepContext.outputs.map(key => `${key.toUpperCase()}: <your value>`).join('\n'),
          '',
          'STATUS: done|fail'
        );
      } else {
        sections.push(
          '# OUTPUT FORMAT',
          'When you complete your task, output your results using this format:',
          '',
          'STATUS: done|fail',
          'RESULT: brief summary of outcome',
          '',
          'For structured outputs, use KEY: value pairs:',
          'OUTPUT_NAME: value',
          '  continuation lines can be indented'
        );
      }
    }

    // Inject manifest (API-fetched, access-controlled)
    if (manifestText) {
      sections.push(manifestText);
    }

    return sections.join('\n\n');
  }

  private buildEnvironmentSection(agentId: string, sessionContext?: SessionContext): string {
    const lines: string[] = ['# YOUR ENVIRONMENT'];

    lines.push('');
    lines.push('## Your Environment');
    lines.push('');
    lines.push('Your home directory is `/home/agent/` with this structure:');
    lines.push('- `clawvault/` — Your memory system (use `recall` tool to search, `remember` to store)');
    lines.push('  - `{your-id}/` — Your personal memories');
    lines.push('  - `shared/` — Team shared knowledge');
    lines.push('- `run-workspace/` — Git worktree for the current pipeline run (pipeline sessions only)');
    lines.push('- `task-workspaces/{taskId}/` — Persistent authenticated git workspaces for pulse tasks');
    lines.push('- `project-workspace/` — Project repository');
    lines.push('');
    lines.push('### Key Rules:');
    lines.push('1. Pipeline task work goes in `/home/agent/run-workspace/`');
    lines.push('2. Pulse task work goes in `/home/agent/task-workspaces/{taskId}/` (provisioned by claim_task)');
    lines.push('2. Use `recall` and `remember` tools for memory, not direct file access to clawvault');
    lines.push('3. Your home directory persists across sessions');

    if (sessionContext) {
      lines.push('');
      lines.push('## Session Context');

      if (sessionContext.sessionType === 'pipeline' && sessionContext.runId) {
        lines.push(`- **Session Type**: Pipeline execution`);
        lines.push(`- **Run ID**: \`${sessionContext.runId}\``);
        lines.push('');
        lines.push('## 🗂️ WORKSPACE HIERARCHY — READ CAREFULLY');
        lines.push('');
        lines.push('You have TWO workspaces during pipeline runs. Using the right one is CRITICAL:');
        lines.push('');
        lines.push('### `/home/agent/run-workspace/` — THE RUN WORKSPACE (USE THIS FOR TASK OUTPUTS)');
        lines.push('- **This is where you do your WORK for this task**');
        lines.push('- Files here are VISIBLE in the dashboard and to other agents');
        lines.push('- Code, outputs, deliverables, documentation → PUT THEM HERE');
        lines.push('- Environment variable: `$RUN_WORKSPACE`');
        lines.push('- Quick access: `cd $RUN_WORKSPACE`');
        lines.push('');
        lines.push('### `/home/agent/project-workspace/` — PROJECT REPOSITORY');
        lines.push('- The main project git repository');
        lines.push('- Use for reference and context');
        lines.push('- Task outputs should still go in run-workspace');
        lines.push('');
        lines.push('### ⚠️ RULE: Task work goes in `/home/agent/run-workspace/`');
        lines.push('When working on a pipeline task:');
        lines.push('1. `cd $RUN_WORKSPACE` first');
        lines.push('2. Create all task-related files there');
        lines.push('3. Reference project files from project-workspace as needed');
      } else if (sessionContext.sessionType === 'chat') {
        lines.push(`- **Session Type**: Interactive dashboard chat`);
        if (sessionContext.runId) {
          lines.push(`- **Session ID**: \`${sessionContext.runId}\``);
        }
        lines.push('');
        lines.push('You are having a direct, interactive conversation with a human via the dashboard.');
        lines.push('Be conversational, helpful, and engage naturally with the user\'s requests.');
        lines.push('You have full access to your workspace and tools to help with complex requests.');
        lines.push('Use your tools when appropriate, but also feel free to have a natural discussion.');
      } else if (sessionContext.sessionType === 'slack') {
        lines.push(`- **Session Type**: Slack conversation`);
        if (sessionContext.channelContext) {
          lines.push(`- **Channel Context**: ${sessionContext.channelContext}`);
        }
        lines.push('');
        lines.push('You are responding in a Slack conversation. Keep responses concise and natural.');
        lines.push('You have full access to your workspace and tools to help with complex requests.');
      } else if (sessionContext.sessionType === 'pulse') {
        lines.push(`- **Session Type**: Pulse wake-up routine`);
        lines.push('');
        lines.push('This is your periodic check-in. Review your inbox, check memories for pending items,');
        lines.push('and take autonomous actions using the pulse tools.');
        lines.push('');
        lines.push('## Git Workflow for Pulse Tasks');
        lines.push('1. Call `claim_task(projectId, taskId)` — this provisions an authenticated git workspace automatically.');
        lines.push('2. Your workspace is at `/home/agent/task-workspaces/{taskId}/` already on the right branch.');
        lines.push('3. `cd /home/agent/task-workspaces/{taskId}`, make changes, `git add -A && git commit -m "..." && git push`.');
        lines.push('4. Call `open_pull_request(...)` when ready for review.');
        lines.push('5. Call `transition_task(..., "review")` to move the task forward.');
        lines.push('6. DO NOT use `/home/agent/run-workspace/` — that is for pipeline runs only.');
      }

      if (sessionContext.installedTools && sessionContext.installedTools.length > 0) {
        lines.push('');
        lines.push('## Installed Tools');
        lines.push('Previously installed in your sandbox (persistent across sessions):');
        for (const tool of sessionContext.installedTools) {
          lines.push(`- ${tool}`);
        }
        lines.push('');
        lines.push("You don't need to reinstall these — they're already available in bash.");
      }
    }

    lines.push('');
    lines.push('## Container Environment');
    lines.push('Your bash commands run in an isolated container. You have:');
    lines.push('- Full read/write access to your workspace');
    lines.push('- Network access for installing packages and fetching resources');
    lines.push('- Python 3, Node.js, and common CLI tools');
    lines.push('- Installed tools persist across sessions');

    return lines.join('\n');
  }
}
