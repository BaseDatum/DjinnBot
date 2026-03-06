import type { ProgressFileManager } from './progress-file.js';

export interface AssembledContext {
  systemPrompt: string;
  projectContext: string;
  runContext: string;
  stepInput: string;
  fullPrompt: string;
}

export interface ContextAssemblerConfig {
  progressFiles: ProgressFileManager;
  getKnowledge: (runId: string) => Promise<Array<{ category: string; content: string; importance: string }>>;
  getOutputs: (runId: string) => Record<string, string>;
  // NEW: Get agent memory context for persistent memory injection
  getAgentMemoryContext?: (agentId: string, runId: string, stepId: string, taskDescription: string) => Promise<string>;
  // NEW: Get installed tools for workspace memory (persistent across runs)
  getInstalledTools?: (agentId: string) => string[];
  // NEW: Get git context for the run workspace (branch, base, recent commits)
  getWorkspaceGitContext?: (runId: string) => string;
  // NEW: Get unread inbox messages from other agents
  getUnreadMessages?: (agentId: string) => Promise<Array<{
    id: string;
    from: string;
    message: string;
    priority: 'normal' | 'high' | 'urgent';
    type: string;
    timestamp: number;
  }>>;
  // NEW: Mark inbox messages as read after they've been included in context
  markMessagesRead?: (agentId: string, lastMessageId: string) => Promise<void>;
  // NEW: Get document inventory for lightweight context injection
  getDocumentInventory?: () => Promise<Array<{
    attachmentId: string;
    filename: string;
    title: string | null;
    pageCount: number | null;
    chunkCount: number | null;
  }>>;
}

export class ContextAssembler {
  constructor(private config: ContextAssemblerConfig) {}

  async assemble(options: {
    runId: string;
    stepId: string;
    agentId: string;
    stepInput: string;
    systemPrompt: string;
    loopContext?: {
      currentItem: string;
      completedItems: string[];
      totalItems: number;
    };
    /** Pre-computed git context string — injected into the prompt before the task. */
    workspaceGitContext?: string;
  }): Promise<AssembledContext> {
    const { runId, stepId, agentId, stepInput, systemPrompt, loopContext, workspaceGitContext } = options;

    // 1. Read progress file for project context
    const progressContent = await this.config.progressFiles.read(runId);

    // 2. Get accumulated outputs for run context
    const outputs = this.config.getOutputs(runId);

    // 3. Get relevant knowledge
    const knowledge = await this.config.getKnowledge(runId);

    // 4. Resolve git context (caller may supply it directly, otherwise fetch via callback)
    const gitContext = workspaceGitContext
      ?? (this.config.getWorkspaceGitContext ? this.config.getWorkspaceGitContext(runId) : '');

    // 5. Build the full prompt
    let fullPrompt = await this.buildFullPrompt({
      progressContent,
      outputs,
      knowledge,
      stepInput,
      loopContext,
      agentId,
      runId,
      stepId,
      gitContext,
    });

    // 5. Inject installed tools context (persistent workspace memory)
    if (this.config.getInstalledTools) {
      const tools = this.config.getInstalledTools(agentId);
      if (tools.length > 0) {
        const toolsList = tools.map(t => `- ${t}`).join('\n');
        fullPrompt += `\n\n## 🔧 Your Environment\n\nPreviously installed tools (persistent across runs):\n${toolsList}\n\nYou don't need to reinstall these — they're already available in your sandbox.\n`;
      }
    }

    // 6. Mark inbox messages as read after they've been included in context
    // We need to re-fetch to get the last message ID, but to avoid double-fetching,
    // we store the unread messages in a temp variable. However, to keep it simple,
    // we do a separate check here. For efficiency, we could refactor to pass unread[] 
    // from buildFullPrompt up to assemble(), but that changes the API. For now, 
    // we accept the double-fetch or callers can ensure getUnreadMessages is idempotent.
    if (this.config.getUnreadMessages && this.config.markMessagesRead) {
      try {
        const unread = await this.config.getUnreadMessages(agentId);
        if (unread.length > 0) {
          const lastId = unread[unread.length - 1].id;
          await this.config.markMessagesRead(agentId, lastId);
        }
      } catch (err) {
        console.error('[ContextAssembler] Failed to mark inbox messages as read:', err);
      }
    }

    return {
      systemPrompt,
      projectContext: progressContent,
      runContext: this.formatOutputs(outputs),
      stepInput,
      fullPrompt,
    };
  }

  private async buildFullPrompt(params: {
    progressContent: string;
    outputs: Record<string, string>;
    knowledge: Array<{ category: string; content: string; importance: string }>;
    stepInput: string;
    loopContext?: {
      currentItem: string;
      completedItems: string[];
      totalItems: number;
    };
    agentId: string;
    runId: string;
    stepId: string;
    gitContext?: string;
  }): Promise<string> {
    const { progressContent, outputs, knowledge, stepInput, loopContext, agentId, runId, stepId, gitContext } = params;
    
    const sections: string[] = [];

    // Project Context section
    sections.push('## Project Context');
    if (progressContent) {
      sections.push(progressContent);
    } else {
      sections.push('(No previous progress for this run)');
    }
    sections.push('');

    // Previous Step Outputs section
    sections.push('## Previous Step Outputs');
    const outputsFormatted = this.formatOutputs(outputs);
    if (outputsFormatted) {
      sections.push(outputsFormatted);
    } else {
      sections.push('(No outputs from previous steps)');
    }
    sections.push('');

    // Shared Knowledge section
    sections.push('## Shared Knowledge');
    if (knowledge.length > 0) {
      for (const entry of knowledge) {
        sections.push(`**[${entry.importance.toUpperCase()}] ${entry.category}:** ${entry.content}`);
      }
    } else {
      sections.push('(No shared knowledge for this run)');
    }
    sections.push('');

    // Agent Memory section (persistent cross-run memory via ClawVault)
    if (this.config.getAgentMemoryContext) {
      try {
        const memoryContext = await this.config.getAgentMemoryContext(
          agentId, runId, stepId, stepInput
        );
        if (memoryContext && memoryContext.trim().length > 0) {
          sections.push('## Your Knowledge Graph Memory');
          sections.push('_Use the recall and graph_query tools to explore your memory further. After using recalled memories, call rate_memories to mark which were useful._');
          sections.push('');
          sections.push(memoryContext);
          sections.push('');
        }
      } catch (err) {
        // Memory is best-effort, don't fail the step
        console.error('[ContextAssembler] Failed to load agent memory:', err);
      }
    }

    // Inbox section (unread messages from other agents)
    if (this.config.getUnreadMessages) {
      try {
        const unread = await this.config.getUnreadMessages(agentId);
        if (unread.length > 0) {
          sections.push('## 📬 Unread Messages');
          sections.push('You have messages from other agents:');
          sections.push('');

          for (const msg of unread) {
            const urgentFlag = msg.priority === 'urgent' ? ' 🚨 URGENT' :
                              msg.priority === 'high' ? ' ⚡ HIGH' : '';
            const typeIcon = msg.type === 'review_request' ? '📝' :
                            msg.type === 'help_request' ? '🆘' :
                            msg.type === 'unblock' ? '🔓' : 'ℹ️';
            sections.push(`${typeIcon} **[${msg.from}]**${urgentFlag}: ${msg.message}`);
            sections.push('');
          }

          sections.push('Please acknowledge or respond to these messages if relevant to your current task.');
          sections.push('');
        }
      } catch (err) {
        // Inbox is best-effort, don't fail the step
        console.error('[ContextAssembler] Failed to check inbox:', err);
      }
    }

    // Workspace git context (branch, base, prior step commits)
    if (gitContext && gitContext.trim()) {
      sections.push(gitContext);
      sections.push('');
    }

    // Document inventory (lightweight — just filenames + page counts)
    if (this.config.getDocumentInventory) {
      try {
        const docs = await this.config.getDocumentInventory();
        if (docs.length > 0) {
          sections.push('## Available Documents');
          sections.push('Use the `read_document` tool to access specific sections. Use `recall` with scope="shared" to search across all document knowledge.');
          sections.push('');
          for (const doc of docs) {
            const title = doc.title || doc.filename;
            const pages = doc.pageCount ? `${doc.pageCount} pages` : 'unknown pages';
            const chunks = doc.chunkCount ? `, ${doc.chunkCount} sections` : '';
            sections.push(`- **${title}** (${pages}${chunks}) — ID: ${doc.attachmentId}`);
          }
          sections.push('');
        }
      } catch (err) {
        // Document inventory is best-effort, don't fail the step
        console.error('[ContextAssembler] Failed to load document inventory:', err);
      }
    }

    // Task section
    sections.push('## Your Task');
    sections.push(stepInput);

    // Loop context if applicable
    if (loopContext) {
      sections.push('');
      sections.push('## Loop Context');
      sections.push(`Progress: ${loopContext.completedItems.length + 1}/${loopContext.totalItems}`);
      sections.push(`Current item: ${loopContext.currentItem}`);
      if (loopContext.completedItems.length > 0) {
        sections.push(`Completed: ${loopContext.completedItems.join(', ')}`);
      }
    }

    return sections.join('\n');
  }

  private formatOutputs(outputs: Record<string, string>): string {
    const entries = Object.entries(outputs);
    if (entries.length === 0) {
      return '';
    }

    return entries
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
  }
}
