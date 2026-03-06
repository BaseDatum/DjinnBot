import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';

// Type definitions for our tool parameters
const CompleteParamsSchema = Type.Object({
  status: Type.Literal('done'),
  outputs: Type.Record(Type.String(), Type.String(), {
    description:
      'Key-value pairs of step outputs matching the required output keys',
  }),
  summary: Type.Optional(
    Type.String({
      description: 'Brief one-line summary of what you accomplished',
    })
  ),
});
type CompleteParams = Static<typeof CompleteParamsSchema>;

const FailParamsSchema = Type.Object({
  error: Type.String({ description: 'What went wrong' }),
  details: Type.Optional(
    Type.String({ description: 'Additional context or stack trace' })
  ),
  recoverable: Type.Optional(
    Type.Boolean({ description: 'Whether retrying might help' })
  ),
});
type FailParams = Static<typeof FailParamsSchema>;

const ShareKnowledgeParamsSchema = Type.Object({
  category: Type.Union(
    [
      Type.Literal('pattern'),
      Type.Literal('decision'),
      Type.Literal('issue'),
      Type.Literal('convention'),
    ],
    { description: 'Type of knowledge being shared' }
  ),
  content: Type.String({
    description: 'The knowledge to share — be specific and actionable',
  }),
  importance: Type.Union(
    [
      Type.Literal('low'),
      Type.Literal('medium'),
      Type.Literal('high'),
      Type.Literal('critical'),
    ],
    { default: 'medium', description: 'How important this is for other agents' }
  ),
});
type ShareKnowledgeParams = Static<typeof ShareKnowledgeParamsSchema>;

// Upgraded remember with ClawVault's 8 memory types + wiki-link support
const RememberParamsSchema = Type.Object({
  type: Type.Union(
    [
      Type.Literal('fact'),
      Type.Literal('feeling'),
      Type.Literal('decision'),
      Type.Literal('lesson'),
      Type.Literal('commitment'),
      Type.Literal('preference'),
      Type.Literal('relationship'),
      Type.Literal('project'),
    ],
    { description: 'What kind of memory this is (ClawVault memory types)' }
  ),
  title: Type.String({
    description: 'Short title for this memory (used as filename)',
  }),
  content: Type.String({
    description: 'Detailed content. Use [[wiki-links]] to reference other memories and build graph connections.',
  }),
  shared: Type.Optional(
    Type.Boolean({
      default: false,
      description: 'IMPORTANT: Set to true to store in the SHARED team vault (visible to all agents and persisted to the project knowledge graph). Set to false (default) for personal-only notes. During onboarding you MUST use shared: true for all project memories.',
    })
  ),
  links: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Optional array of memory IDs to link to (e.g., ["decisions/use-postgresql"])',
    })
  ),
});
type RememberParams = Static<typeof RememberParamsSchema>;

// Upgraded recall with graph profiles and budget
const RecallParamsSchema = Type.Object({
  query: Type.String({ description: 'What to search your memory for' }),
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal('personal'),
        Type.Literal('shared'),
        Type.Literal('all'),
      ],
      {
        default: 'all',
        description: 'Search personal memory, team knowledge, or both',
      }
    )
  ),
  profile: Type.Optional(
    Type.Union(
      [
        Type.Literal('default'),
        Type.Literal('planning'),
        Type.Literal('incident'),
        Type.Literal('handoff'),
        Type.Literal('auto'),
      ],
      {
        default: 'default',
        description: 'Context profile: planning (decisions+patterns), incident (facts+lessons), handoff (recent sessions), auto (adaptive)',
      }
    )
  ),
  budget: Type.Optional(
    Type.Number({
      default: 2000,
      description: 'Token budget for context retrieval (affects depth of graph traversal)',
    })
  ),
});
type RecallParams = Static<typeof RecallParamsSchema>;

// New: graph_query tool
const GraphQueryParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal('summary'),     // Get full graph stats
    Type.Literal('neighbors'),   // Get neighbors of a node
    Type.Literal('search'),      // Search nodes by name
  ], { description: 'What to query about your knowledge graph' }),
  nodeId: Type.Optional(Type.String({ 
    description: 'Node ID for neighbors query (e.g., "decisions/use-postgresql")' 
  })),
  query: Type.Optional(Type.String({ 
    description: 'Search term for node search' 
  })),
  maxHops: Type.Optional(Type.Number({ 
    description: 'How many hops for neighbors (1-3)', 
    default: 1 
  })),
  scope: Type.Optional(Type.Union([
    Type.Literal('personal'),
    Type.Literal('shared'),
    Type.Literal('all'),
  ], { default: 'personal', description: 'IMPORTANT: Set scope to "shared" to search the SHARED team vault (project knowledge visible to ALL agents), "all" to search BOTH personal and shared, or "personal" (default) for your own graph only. When looking for project-level knowledge, conventions, or decisions you MUST use scope="shared" or scope="all".' })),
});
type GraphQueryParams = Static<typeof GraphQueryParamsSchema>;

// New: link_memory tool
const LinkMemoryParamsSchema = Type.Object({
  fromId: Type.String({ 
    description: 'Source memory ID (e.g., "decisions/use-postgresql")' 
  }),
  toId: Type.String({ 
    description: 'Target memory ID (e.g., "projects/user-auth")' 
  }),
  relationType: Type.Union([
    Type.Literal('related'),
    Type.Literal('depends_on'),
    Type.Literal('blocks'),
  ], { description: 'How these memories are related' }),
});
type LinkMemoryParams = Static<typeof LinkMemoryParamsSchema>;

// New: checkpoint tool
const CheckpointParamsSchema = Type.Object({
  workingOn: Type.String({ 
    description: 'What you are currently working on' 
  }),
  focus: Type.Optional(Type.String({ 
    description: 'Current focus area' 
  })),
  decisions: Type.Optional(Type.Array(Type.String(), { 
    description: 'Decisions made so far in this step' 
  })),
});
type CheckpointParams = Static<typeof CheckpointParamsSchema>;

// New: message_agent tool
const MessageAgentParamsSchema = Type.Object({
  to: Type.String({ 
    description: 'Agent ID to message (e.g., eric, finn, yukihiro, chieko, stas, yang)' 
  }),
  message: Type.String({ 
    description: 'Message content' 
  }),
  priority: Type.Optional(Type.Union([
    Type.Literal('normal'),
    Type.Literal('high'),
    Type.Literal('urgent'),
  ], { 
    default: 'normal',
    description: 'Priority level (default: normal)' 
  })),
  type: Type.Optional(Type.Union([
    Type.Literal('info'),
    Type.Literal('review_request'),
    Type.Literal('help_request'),
    Type.Literal('unblock'),
  ], { 
    default: 'info',
    description: 'Message type (default: info)' 
  })),
});
type MessageAgentParams = Static<typeof MessageAgentParamsSchema>;

// research tool
const ResearchParamsSchema = Type.Object({
  query: Type.String({
    description: 'The research question or topic. Be specific — e.g. "current SaaS valuation multiples for B2B tools 2025".',
  }),
  focus: Type.Optional(Type.Union([
    Type.Literal('finance'),
    Type.Literal('marketing'),
    Type.Literal('technical'),
    Type.Literal('market'),
    Type.Literal('news'),
    Type.Literal('general'),
  ], {
    default: 'general',
    description: 'Domain focus to guide the research model',
  })),
  model: Type.Optional(Type.String({
    default: 'perplexity/sonar-pro',
    description: 'Perplexity model: sonar-pro (best quality), sonar (faster), sonar-reasoning (deeper reasoning)',
  })),
});
type ResearchParams = Static<typeof ResearchParamsSchema>;

// slack_dm tool for messaging the user directly
const SlackDmParamsSchema = Type.Object({
  message: Type.String({ 
    description: 'Message to send to the user via Slack DM' 
  }),
  urgent: Type.Optional(Type.Boolean({ 
    default: false,
    description: 'If true, marks the message as urgent (use sparingly!)' 
  })),
});
type SlackDmParams = Static<typeof SlackDmParamsSchema>;

interface TextContent {
  type: 'text';
  text: string;
}

// ── Code Knowledge Graph Tools ────────────────────────────────────────────

const CodeGraphQueryParamsSchema = Type.Object({
  query: Type.String({
    description: 'Natural language or keyword search query (e.g., "authentication middleware", "database connection")',
  }),
  task_context: Type.Optional(Type.String({
    description: 'What you are working on (helps ranking)',
  })),
  limit: Type.Optional(Type.Number({
    default: 10,
    description: 'Max results to return',
  })),
});
type CodeGraphQueryParams = Static<typeof CodeGraphQueryParamsSchema>;

const CodeGraphContextParamsSchema = Type.Object({
  symbol_name: Type.String({
    description: 'Symbol name (e.g., "validateUser", "AuthService")',
  }),
  file_path: Type.Optional(Type.String({
    description: 'File path to disambiguate common names',
  })),
});
type CodeGraphContextParams = Static<typeof CodeGraphContextParamsSchema>;

const CodeGraphImpactParamsSchema = Type.Object({
  target: Type.String({
    description: 'Name of function, class, or file to analyze',
  }),
  direction: Type.Union([
    Type.Literal('upstream'),
    Type.Literal('downstream'),
  ], {
    description: 'upstream = what depends on this, downstream = what this depends on',
  }),
  max_depth: Type.Optional(Type.Number({
    default: 3,
    description: 'Max relationship depth (1-5)',
  })),
  min_confidence: Type.Optional(Type.Number({
    default: 0.7,
    description: 'Minimum confidence 0-1',
  })),
});
type CodeGraphImpactParams = Static<typeof CodeGraphImpactParamsSchema>;

const CodeGraphChangesParamsSchema = Type.Object({});
type CodeGraphChangesParams = Static<typeof CodeGraphChangesParamsSchema>;

// read_document tool — lazy PDF content retrieval
const ReadDocumentParamsSchema = Type.Object({
  mode: Type.Union([
    Type.Literal('list'),      // List all available documents (lightweight inventory)
    Type.Literal('toc'),       // Get table of contents for a document
    Type.Literal('section'),   // Read a specific section by heading or page
    Type.Literal('search'),    // Search within a document
  ], { description: 'How to access the document. Start with "list" to see available docs, then "toc" to understand structure, then "section" or "search" to get specific content.' }),
  document_id: Type.Optional(Type.String({
    description: 'Attachment ID (att_xxx) of the document. Required for toc/section/search modes.',
  })),
  heading: Type.Optional(Type.String({
    description: 'Section heading to read (for section mode). Case-insensitive partial match.',
  })),
  page: Type.Optional(Type.Number({
    description: 'Page number to read (for section mode, 1-indexed).',
  })),
  chunk_index: Type.Optional(Type.Number({
    description: 'Direct chunk index (for section mode). Visible in toc output.',
  })),
  query: Type.Optional(Type.String({
    description: 'Search query (for search mode). Searches within the document chunks.',
  })),
});
type ReadDocumentParams = Static<typeof ReadDocumentParamsSchema>;

// onboarding_handoff tool
const OnboardingHandoffParamsSchema = Type.Object({
  next_agent: Type.Union([
    Type.Literal('jim'),
    Type.Literal('eric'),
    Type.Literal('finn'),
    Type.Literal('yang'),
    Type.Literal('done'),
  ], {
    description: 'Which agent to hand off to next. Use "done" if the user wants to skip straight to project creation.',
  }),
  summary: Type.String({
    description: 'One-sentence summary of the project as you understand it so far.',
  }),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'Structured context extracted during this interview phase. Keys: project_name, goal, repo, open_source, revenue_goal, target_customer, monetization, timeline, v1_scope, tech_preferences.',
  })),
});
type OnboardingHandoffParams = Static<typeof OnboardingHandoffParamsSchema>;

// The tool factory captures run context via closures
export interface DjinnBotToolCallbacks {
  onComplete: (outputs: Record<string, string>, summary?: string) => void;
  onFail: (error: string, details?: string) => void;
  onShareKnowledge: (entry: {
    category: string;
    content: string;
    importance: string;
  }) => Promise<void>;
  onRemember?: (entry: {
    type: string;
    title: string;
    content: string;
    shared: boolean;
    links?: string[];
  }) => Promise<void>;
  onRecall?: (query: string, scope: string, profile: string, budget: number) => Promise<string>;
  onGraphQuery?: (action: string, nodeId?: string, query?: string, maxHops?: number, scope?: string) => Promise<string>;
  onLinkMemory?: (fromId: string, toId: string, relationType: string) => Promise<void>;
  onCheckpoint?: (workingOn: string, focus?: string, decisions?: string[]) => Promise<void>;
  onMessageAgent?: (to: string, message: string, priority: string, type: string) => Promise<string>;
  onSlackDm?: (message: string, urgent: boolean) => Promise<string>;
  /** Research via Perplexity/OpenRouter. Returns the synthesized answer string. */
  onResearch?: (query: string, focus: string, model: string) => Promise<string>;
  /** Code knowledge graph: hybrid search across project codebase. */
  onCodeGraphQuery?: (query: string, taskContext?: string, limit?: number) => Promise<string>;
  /** Code knowledge graph: 360-degree symbol context. */
  onCodeGraphContext?: (symbolName: string, filePath?: string) => Promise<string>;
  /** Code knowledge graph: blast radius analysis. */
  onCodeGraphImpact?: (target: string, direction: string, maxDepth?: number, minConfidence?: number) => Promise<string>;
  /** Code knowledge graph: map uncommitted changes to affected symbols/processes. */
  onCodeGraphChanges?: () => Promise<string>;
  /** Read document: lazy PDF content retrieval (list, toc, section, search). */
  onReadDocument?: (mode: string, documentId?: string, heading?: string, page?: number, chunkIndex?: number, query?: string) => Promise<string>;
  /**
   * Onboarding handoff — signals to the orchestrator that this agent is done
   * and the next agent should take over. Only available in onboarding sessions.
   */
  onOnboardingHandoff?: (nextAgent: string, summary: string, context?: Record<string, unknown>) => Promise<string>;
}

// Simple void details for our tools
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface VoidDetails {}

export function createDjinnBotTools(
  callbacks: DjinnBotToolCallbacks
): AgentTool[] {
  return [
    // complete tool
    {
      name: 'complete',
      description:
        'Signal that your assigned task/step is complete. Provide all required outputs as key-value pairs. Call this ONCE when you are finished.',
      label: 'complete',
      parameters: CompleteParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as CompleteParams;
        callbacks.onComplete(typedParams.outputs, typedParams.summary);
        return {
          content: [
            { type: 'text', text: 'Step marked as complete. Outputs recorded.' },
          ],
          details: {},
        };
      },
    },
    // fail tool
    {
      name: 'fail',
      description:
        'Signal that you cannot complete the assigned task. Explain the reason clearly so the orchestrator can decide whether to retry or escalate.',
      label: 'fail',
      parameters: FailParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as FailParams;
        callbacks.onFail(typedParams.error, typedParams.details);
        return {
          content: [
            { type: 'text', text: 'Step marked as failed. Error recorded.' },
          ],
          details: {},
        };
      },
    },
    // share_knowledge tool
    {
      name: 'share_knowledge',
      description:
        'Share an important learning, decision, pattern, or issue with other agents working on this project. Use this for information that would help other agents in later steps.',
      label: 'share_knowledge',
      parameters: ShareKnowledgeParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as ShareKnowledgeParams;
        await callbacks.onShareKnowledge({
          category: typedParams.category as string,
          content: typedParams.content as string,
          importance: (typedParams.importance ?? 'medium') as string,
        });
        return {
          content: [{ type: 'text', text: 'Knowledge shared with the team.' }],
          details: {},
        };
      },
    },
    // remember tool (upgraded)
    {
      name: 'remember',
      description:
        'Store a memory. Pass shared: true to store in the SHARED team vault (visible to all agents) — REQUIRED for all project knowledge during onboarding. Pass shared: false (default) for personal notes only. Supports 8 memory types and wiki-links for building knowledge graphs. Use [[wiki-links]] in content to reference other memories.',
      label: 'remember',
      parameters: RememberParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as RememberParams;
        if (!callbacks.onRemember) {
          return {
            content: [
              {
                type: 'text',
                text: 'Memory not available — noted in session only.',
              },
            ],
            details: {},
          };
        }
        await callbacks.onRemember({
          type: typedParams.type as string,
          title: typedParams.title as string,
          content: typedParams.content as string,
          shared: (typedParams.shared ?? false) as boolean,
          links: typedParams.links as string[] | undefined,
        });
        return {
          content: [{ type: 'text', text: `Remembered: ${typedParams.title}` }],
          details: {},
        };
      },
    },
    // recall tool (upgraded with profiles)
    {
      name: 'recall',
      description:
        'Search your personal memory vault with graph-aware retrieval. Combines semantic search + wiki-link traversal. Use profiles to optimize for different tasks.',
      label: 'recall',
      parameters: RecallParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as RecallParams;
        if (!callbacks.onRecall) {
          return {
            content: [{ type: 'text', text: 'Memory not available.' }],
            details: {},
          };
        }
        const results = await callbacks.onRecall(
          typedParams.query as string,
          (typedParams.scope ?? 'all') as string,
          (typedParams.profile ?? 'default') as string,
          (typedParams.budget ?? 2000) as number
        );
        return {
          content: [{ type: 'text', text: results }],
          details: {},
        };
      },
    },
    // graph_query tool (new)
    {
      name: 'graph_query',
      description:
        'Query your knowledge graph directly. IMPORTANT: By default this only searches your PERSONAL graph. To search project/team knowledge, you MUST pass scope="shared" or scope="all". Use scope="shared" for the shared team vault, scope="all" for both personal and shared, scope="personal" (default) for your own graph only.',
      label: 'graph_query',
      parameters: GraphQueryParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GraphQueryParams;
        if (!callbacks.onGraphQuery) {
          return {
            content: [{ type: 'text', text: 'Graph query not available.' }],
            details: {},
          };
        }
        const result = await callbacks.onGraphQuery(
          typedParams.action,
          typedParams.nodeId,
          typedParams.query,
          typedParams.maxHops,
          typedParams.scope
        );
        return {
          content: [{ type: 'text', text: result }],
          details: {},
        };
      },
    },
    // link_memory tool (new)
    {
      name: 'link_memory',
      description:
        'Create an explicit typed relationship between two memories. Useful for building structured knowledge: related (similar topics), depends_on (prerequisite), blocks (prevents progress).',
      label: 'link_memory',
      parameters: LinkMemoryParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as LinkMemoryParams;
        if (!callbacks.onLinkMemory) {
          return {
            content: [{ type: 'text', text: 'Memory linking not available.' }],
            details: {},
          };
        }
        await callbacks.onLinkMemory(
          typedParams.fromId,
          typedParams.toId,
          typedParams.relationType
        );
        return {
          content: [{ type: 'text', text: `Linked ${typedParams.fromId} → ${typedParams.toId} (${typedParams.relationType})` }],
          details: {},
        };
      },
    },
    // checkpoint tool (new)
    {
      name: 'checkpoint',
      description:
        'Save a quick progress checkpoint to your inbox. Use this during long-running steps to capture decisions and progress so you can resume if interrupted.',
      label: 'checkpoint',
      parameters: CheckpointParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as CheckpointParams;
        if (!callbacks.onCheckpoint) {
          return {
            content: [{ type: 'text', text: 'Checkpoint not available.' }],
            details: {},
          };
        }
        await callbacks.onCheckpoint(
          typedParams.workingOn,
          typedParams.focus,
          typedParams.decisions
        );
        return {
          content: [{ type: 'text', text: 'Checkpoint saved to inbox.' }],
          details: {},
        };
      },
    },
    // message_agent tool (new)
    {
      name: 'message_agent',
      description:
        'Send a message to another agent for collaboration, help, or code review. Use this to: request code review from another agent, ask for help when stuck, share important information or discoveries, or unblock yourself by asking for dependencies. Message types: info (general info), review_request (code/design review), help_request (ask for help), unblock (request something blocked).',
      label: 'message_agent',
      parameters: MessageAgentParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as MessageAgentParams;
        if (!callbacks.onMessageAgent) {
          return {
            content: [{ type: 'text', text: 'Messaging not available.' }],
            details: {},
          };
        }
        const messageId = await callbacks.onMessageAgent(
          typedParams.to,
          typedParams.message,
          (typedParams.priority ?? 'normal') as string,
          (typedParams.type ?? 'info') as string
        );
        return {
          content: [{ type: 'text', text: `Message sent to ${typedParams.to} (ID: ${messageId}). They'll see it when they wake up for their next step.` }],
          details: {},
        };
      },
    },
    // slack_dm tool - message the user directly via Slack
    {
      name: 'slack_dm',
      description:
        'Send a direct message to the user (the human) via Slack. Use this for: urgent findings needing human attention, questions requiring human input, status updates on important work, or blockers you cannot resolve. Do NOT use for routine updates - only when human attention is needed.',
      label: 'slack_dm',
      parameters: SlackDmParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as SlackDmParams;
        if (!callbacks.onSlackDm) {
          return {
            content: [{ type: 'text', text: 'Slack DM not available. The user may not have configured their Slack ID in Settings.' }],
            details: {},
          };
        }
        const result = await callbacks.onSlackDm(
          typedParams.message,
          typedParams.urgent ?? false
        );
        return {
          content: [{ type: 'text', text: result }],
          details: {},
        };
      },
    },
    // research tool — Perplexity via OpenRouter
    {
      name: 'research',
      description:
        'Research a topic using Perplexity AI via OpenRouter. Returns synthesized, cited answers from live web sources. Use for market research, competitive analysis, industry trends, technical documentation, pricing data, news, and any topic requiring up-to-date external knowledge.',
      label: 'research',
      parameters: ResearchParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as ResearchParams;
        if (!callbacks.onResearch) {
          return {
            content: [{ type: 'text', text: 'Research not available in this execution context.' }],
            details: {},
          };
        }
        const result = await callbacks.onResearch(
          typedParams.query,
          (typedParams.focus ?? 'general') as string,
          (typedParams.model ?? 'perplexity/sonar-pro') as string,
        );
        return {
          content: [{ type: 'text', text: result }],
          details: {},
        };
      },
    },
    // ── Code Knowledge Graph Tools ──────────────────────────────────────
    // code_graph_query — hybrid search across the project's knowledge graph
    {
      name: 'code_graph_query',
      description:
        'Search the project codebase knowledge graph. Returns functions, classes, and execution flows matching your query. Use this to understand how code works together before making changes. Only available for projects with a git workspace.',
      label: 'code_graph_query',
      parameters: CodeGraphQueryParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as CodeGraphQueryParams;
        if (!callbacks.onCodeGraphQuery) {
          return {
            content: [{ type: 'text', text: 'Code knowledge graph not available for this project.' }],
            details: {},
          };
        }
        const result = await callbacks.onCodeGraphQuery(
          typedParams.query,
          typedParams.task_context,
          typedParams.limit ?? 10,
        );
        return {
          content: [{ type: 'text', text: result }],
          details: {},
        };
      },
    },
    // code_graph_context — 360-degree view of a code symbol
    {
      name: 'code_graph_context',
      description:
        'Get complete context for a code symbol: who calls it, what it calls, which execution flows it participates in, and which functional cluster it belongs to. Use after code_graph_query to deeply understand a specific symbol.',
      label: 'code_graph_context',
      parameters: CodeGraphContextParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as CodeGraphContextParams;
        if (!callbacks.onCodeGraphContext) {
          return {
            content: [{ type: 'text', text: 'Code knowledge graph not available for this project.' }],
            details: {},
          };
        }
        const result = await callbacks.onCodeGraphContext(
          typedParams.symbol_name,
          typedParams.file_path,
        );
        return {
          content: [{ type: 'text', text: result }],
          details: {},
        };
      },
    },
    // code_graph_impact — blast radius analysis
    {
      name: 'code_graph_impact',
      description:
        'Analyze what would break if you change a code symbol. Returns affected symbols grouped by depth (d=1: WILL BREAK, d=2: LIKELY AFFECTED) plus affected execution flows. Use BEFORE making changes to understand risk.',
      label: 'code_graph_impact',
      parameters: CodeGraphImpactParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as CodeGraphImpactParams;
        if (!callbacks.onCodeGraphImpact) {
          return {
            content: [{ type: 'text', text: 'Code knowledge graph not available for this project.' }],
            details: {},
          };
        }
        const result = await callbacks.onCodeGraphImpact(
          typedParams.target,
          typedParams.direction,
          typedParams.max_depth ?? 3,
          typedParams.min_confidence ?? 0.7,
        );
        return {
          content: [{ type: 'text', text: result }],
          details: {},
        };
      },
    },
    // code_graph_changes — map git changes to affected symbols
    {
      name: 'code_graph_changes',
      description:
        'Map your current uncommitted git changes to affected code symbols and execution flows. Use as a pre-commit safety check to understand what your changes affect.',
      label: 'code_graph_changes',
      parameters: CodeGraphChangesParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        if (!callbacks.onCodeGraphChanges) {
          return {
            content: [{ type: 'text', text: 'Code knowledge graph not available for this project.' }],
            details: {},
          };
        }
        const result = await callbacks.onCodeGraphChanges();
        return {
          content: [{ type: 'text', text: result }],
          details: {},
        };
      },
    },
    // read_document tool — lazy PDF content retrieval
    {
      name: 'read_document',
      description:
        'Access uploaded PDF documents efficiently. Instead of having the full document in context, use this to: (1) "list" all available documents, (2) "toc" to see a document\'s table of contents, (3) "section" to read a specific section by heading or page number, (4) "search" to find content within a document. Start with "list" mode to see what\'s available.',
      label: 'read_document',
      parameters: ReadDocumentParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as ReadDocumentParams;
        if (!callbacks.onReadDocument) {
          return {
            content: [{ type: 'text', text: 'Document reading not available.' }],
            details: {},
          };
        }
        const result = await callbacks.onReadDocument(
          typedParams.mode,
          typedParams.document_id,
          typedParams.heading,
          typedParams.page,
          typedParams.chunk_index,
          typedParams.query,
        );
        return {
          content: [{ type: 'text', text: result }],
          details: {},
        };
      },
    },
    // onboarding_handoff tool (only active in onboarding sessions — safe to include always,
    // will be a no-op if the callback isn't wired)
    ...(callbacks.onOnboardingHandoff ? [{
      name: 'onboarding_handoff',
      description:
        'Hand off the onboarding conversation to the next specialist agent. Call this when you have gathered enough context for your phase and the user is ready to continue with the next agent. This ends your turn and starts the next agent\'s container.',
      label: 'onboarding_handoff',
      parameters: OnboardingHandoffParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as OnboardingHandoffParams;
        const result = await callbacks.onOnboardingHandoff!(
          typedParams.next_agent,
          typedParams.summary,
          typedParams.context as Record<string, unknown> | undefined,
        );
        return {
          content: [{ type: 'text', text: result }],
          details: {},
        };
      },
    }] : []),
  ];
}
