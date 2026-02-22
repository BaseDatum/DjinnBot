/**
 * BuiltInToolsTab — displays the static set of built-in tools every agent has,
 * with per-agent enable/disable toggles persisted to the database.
 *
 * These tools come from two sources in the agent-runtime:
 *   - Container tools   (createContainerTools)  : read, write, edit, bash
 *   - DjinnBot tools    (createDjinnBotTools)    : all domain-specific tools
 *
 * The tool manifest is static — it never varies per agent.
 * The enabled/disabled state is stored in agent_tool_overrides (DB) and
 * fetched via GET /v1/agents/:id/tools/overrides.
 */
import { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Terminal, FileText, FilePen, FileInput,
  CheckCircle, XCircle, Brain, Search, Share2,
  MessageSquare, BellRing, Save,
  Globe, BookOpen, PlusSquare, Download,
  GitBranch, FolderOpen, ClipboardList, ClipboardCheck,
  GitPullRequest, ArrowRightLeft, Play,
  UserCheck, Handshake,
  Network, Link,
  KeyRound,
  Wrench,
  AlertTriangle,
  Send, Hash, SearchCode,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { fetchToolOverrides, setToolOverrides } from '@/lib/api';

interface BuiltInTool {
  name: string;
  description: string;
  category: string;
  icon: LucideIcon;
  /** Tools that must always stay enabled; the toggle is locked */
  required?: boolean;
}

const TOOL_CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: 'file',        label: 'File System',    color: 'text-blue-500 border-blue-500/30'     },
  { key: 'control',    label: 'Step Control',   color: 'text-green-500 border-green-500/30'   },
  { key: 'memory',     label: 'Memory',          color: 'text-purple-500 border-purple-500/30' },
  { key: 'messaging',  label: 'Messaging',       color: 'text-orange-500 border-orange-500/30' },
  { key: 'research',   label: 'Research',        color: 'text-cyan-500 border-cyan-500/30'     },
  { key: 'skills',     label: 'Skills',          color: 'text-yellow-500 border-yellow-500/30' },
  { key: 'github',     label: 'GitHub',          color: 'text-foreground border-border'        },
  { key: 'projects',   label: 'Projects',        color: 'text-indigo-500 border-indigo-500/30' },
  { key: 'tasks',      label: 'Tasks',           color: 'text-pink-500 border-pink-500/30'     },
  { key: 'onboarding', label: 'Onboarding',      color: 'text-teal-500 border-teal-500/30'     },
  { key: 'graph',      label: 'Memory Graph',    color: 'text-violet-500 border-violet-500/30' },
  { key: 'secrets',    label: 'Secrets',         color: 'text-red-500 border-red-500/30'       },
  { key: 'slack',      label: 'Slack',           color: 'text-emerald-500 border-emerald-500/30' },
];

const BUILT_IN_TOOLS: BuiltInTool[] = [
  // ── Container tools ──────────────────────────────────────────────────────
  {
    name: 'read',
    description: 'Read files from the workspace. Supports line offsets, limits, and binary detection.',
    category: 'file',
    icon: FileInput,
  },
  {
    name: 'write',
    description: 'Write or create files in the workspace. Auto-creates parent directories.',
    category: 'file',
    icon: FileText,
  },
  {
    name: 'edit',
    description: 'Perform exact string replacements in existing files.',
    category: 'file',
    icon: FilePen,
  },
  {
    name: 'bash',
    description: 'Execute shell commands with stdout/stderr streaming to the UI. Supports timeouts and abort signals.',
    category: 'file',
    icon: Terminal,
  },

  // ── Step control ─────────────────────────────────────────────────────────
  {
    name: 'complete',
    description: 'Signal that the current pipeline step finished successfully, returning key-value outputs.',
    category: 'control',
    icon: CheckCircle,
    required: true,
  },
  {
    name: 'fail',
    description: 'Signal that the current pipeline step could not be completed, reporting an error.',
    category: 'control',
    icon: XCircle,
    required: true,
  },

  // ── Memory tools ──────────────────────────────────────────────────────────
  {
    name: 'remember',
    description: 'Store a memory (fact, decision, lesson, etc.) in the personal or shared vault. Supports wiki-links.',
    category: 'memory',
    icon: Brain,
  },
  {
    name: 'recall',
    description: 'Semantic search across personal or shared memories. Scope can be personal, shared, or all.',
    category: 'memory',
    icon: Search,
  },
  {
    name: 'share_knowledge',
    description: 'Share a pattern, decision, or issue with the entire team by writing to the shared vault.',
    category: 'memory',
    icon: Share2,
  },

  // ── Messaging tools ───────────────────────────────────────────────────────
  {
    name: 'message_agent',
    description: 'Send an asynchronous message to another agent via Redis.',
    category: 'messaging',
    icon: MessageSquare,
  },
  {
    name: 'slack_dm',
    description: 'Send a direct message to the user via Slack. Use for blockers, urgent findings, or questions requiring human input.',
    category: 'messaging',
    icon: BellRing,
  },
  {
    name: 'checkpoint',
    description: 'Persist the current working state (task, focus, decisions) for crash recovery.',
    category: 'messaging',
    icon: Save,
  },

  // ── Research tools ────────────────────────────────────────────────────────
  {
    name: 'research',
    description: 'Research any topic using Perplexity AI via OpenRouter. Returns synthesized, cited answers from live web sources.',
    category: 'research',
    icon: Globe,
  },

  // ── Skills tools ──────────────────────────────────────────────────────────
  {
    name: 'load_skill',
    description: 'Load a skill\'s instructions or companion files from the skills library.',
    category: 'skills',
    icon: BookOpen,
  },
  {
    name: 'create_skill',
    description: 'Create a new skill and add it to the library. Scope can be global or agent-private.',
    category: 'skills',
    icon: PlusSquare,
  },
  {
    name: 'fetch_skill_from_web',
    description: 'Research a topic via Perplexity and automatically save the findings as a new reusable skill.',
    category: 'skills',
    icon: Download,
  },

  // ── GitHub tools ──────────────────────────────────────────────────────────
  {
    name: 'get_github_token',
    description: 'Obtain a short-lived GitHub App token for a repository and configure the git credential helper automatically.',
    category: 'github',
    icon: GitBranch,
  },

  // ── Project tools ─────────────────────────────────────────────────────────
  {
    name: 'get_my_projects',
    description: 'List all projects the agent is assigned to as owner or member.',
    category: 'projects',
    icon: FolderOpen,
  },
  {
    name: 'get_ready_tasks',
    description: 'Get tasks ready to execute in a project, sorted by priority. Also returns in-progress tasks and dependency info.',
    category: 'projects',
    icon: ClipboardList,
  },
  {
    name: 'get_project_vision',
    description: 'Fetch the project vision document describing goals, architecture, constraints, and priorities.',
    category: 'projects',
    icon: FolderOpen,
  },

  // ── Task tools ────────────────────────────────────────────────────────────
  {
    name: 'create_task',
    description: 'Create a new task in a project kanban board.',
    category: 'tasks',
    icon: PlusSquare,
  },
  {
    name: 'claim_task',
    description: 'Atomically claim an unassigned task and provision a git workspace for it.',
    category: 'tasks',
    icon: UserCheck,
  },
  {
    name: 'get_task_context',
    description: 'Get full details of a task: description, status, priority, assigned agent, branch, PR info.',
    category: 'tasks',
    icon: ClipboardCheck,
  },
  {
    name: 'open_pull_request',
    description: 'Open a GitHub pull request for a task branch targeting main.',
    category: 'tasks',
    icon: GitPullRequest,
  },
  {
    name: 'transition_task',
    description: 'Move a task to a new kanban status (e.g. in_progress → review → done).',
    category: 'tasks',
    icon: ArrowRightLeft,
  },
  {
    name: 'execute_task',
    description: 'Trigger a task\'s pipeline to start executing it autonomously.',
    category: 'tasks',
    icon: Play,
  },

  // ── Onboarding tools ──────────────────────────────────────────────────────
  {
    name: 'update_onboarding_context',
    description: 'Update the live onboarding project profile with structured information extracted during the interview.',
    category: 'onboarding',
    icon: UserCheck,
  },
  {
    name: 'onboarding_handoff',
    description: 'Hand off the onboarding session to the next specialist agent.',
    category: 'onboarding',
    icon: Handshake,
  },

  // ── Memory graph tools ────────────────────────────────────────────────────
  {
    name: 'graph_query',
    description: 'Query the knowledge graph: get a summary, find neighbors of a node, or search by keyword.',
    category: 'graph',
    icon: Network,
  },
  {
    name: 'link_memory',
    description: 'Create a typed link (related, depends_on, blocks) between two memories in the knowledge graph.',
    category: 'graph',
    icon: Link,
  },

  // ── Secrets tools ─────────────────────────────────────────────────────────
  {
    name: 'get_secret',
    description: 'Retrieve secrets granted to the agent by the user (API keys, tokens, credentials).',
    category: 'secrets',
    icon: KeyRound,
  },

  // ── Slack tools ───────────────────────────────────────────────────────────
  {
    name: 'slack_send_message',
    description: 'Post a message to a Slack channel by ID or name. Supports mrkdwn formatting and thread replies. Requires the agent\'s Slack bot token to be configured.',
    category: 'slack',
    icon: Send,
  },
  {
    name: 'slack_list_channels',
    description: 'List all Slack channels the agent\'s bot is a member of, including their IDs, names, and topics.',
    category: 'slack',
    icon: Hash,
  },
  {
    name: 'slack_lookup_channel',
    description: 'Resolve a Slack channel name to its channel ID. Use before slack_send_message when only the name is known.',
    category: 'slack',
    icon: SearchCode,
  },
];

interface BuiltInToolsTabProps {
  agentId: string;
}

export function BuiltInToolsTab({ agentId }: BuiltInToolsTabProps) {
  // Map from tool_name → enabled (true = enabled, false = disabled)
  const [enabledMap, setEnabledMap] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(true);
  // Track which tools are mid-save so we can show a spinner / disable toggle
  const [saving, setSaving] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchToolOverrides(agentId)
      .then((overrides) => {
        const map = new Map<string, boolean>();
        for (const o of overrides) {
          map.set(o.tool_name, o.enabled);
        }
        setEnabledMap(map);
      })
      .catch(() => toast.error('Failed to load tool overrides'))
      .finally(() => setLoading(false));
  }, [agentId]);

  /** Returns the effective enabled state (true unless explicitly set to false). */
  const isEnabled = useCallback(
    (toolName: string) => {
      const override = enabledMap.get(toolName);
      return override !== false; // absent = enabled; false = disabled
    },
    [enabledMap],
  );

  const handleToggle = useCallback(
    async (toolName: string, nowEnabled: boolean) => {
      // Optimistic update
      setEnabledMap((prev) => {
        const next = new Map(prev);
        next.set(toolName, nowEnabled);
        return next;
      });
      setSaving((prev) => new Set(prev).add(toolName));

      try {
        await setToolOverrides(agentId, [{ tool_name: toolName, enabled: nowEnabled }]);
        // Update local map from API response (single source of truth)
        setEnabledMap((prev) => {
          const next = new Map(prev);
          next.set(toolName, nowEnabled);
          return next;
        });
        toast.success(`${toolName} ${nowEnabled ? 'enabled' : 'disabled'}`);
      } catch {
        // Roll back optimistic update
        setEnabledMap((prev) => {
          const next = new Map(prev);
          next.set(toolName, !nowEnabled);
          return next;
        });
        toast.error(`Failed to ${nowEnabled ? 'enable' : 'disable'} ${toolName}`);
      } finally {
        setSaving((prev) => {
          const next = new Set(prev);
          next.delete(toolName);
          return next;
        });
      }
    },
    [agentId],
  );

  const grouped = TOOL_CATEGORIES.map((cat) => ({
    ...cat,
    tools: BUILT_IN_TOOLS.filter((t) => t.category === cat.key),
  })).filter((g) => g.tools.length > 0);

  const disabledCount = BUILT_IN_TOOLS.filter((t) => !t.required && !isEnabled(t.name)).length;

  if (loading) {
    return (
      <div className="space-y-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton height={20} width={120} />
            <Skeleton height={52} />
            <Skeleton height={52} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Wrench className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-muted-foreground">
            Every agent has these built-in tools available at runtime. Disable individual tools
            to restrict what this agent can do. Changes take effect on the agent's next turn.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {BUILT_IN_TOOLS.length} built-in tools &middot; {grouped.length} categories
            {disabledCount > 0 && (
              <span className="ml-2 text-yellow-500 inline-flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {disabledCount} disabled
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Tool groups */}
      {grouped.map(({ key, label, color, tools }) => (
        <div key={key} className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-xs ${color}`}>
              {label}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {tools.length} tool{tools.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {tools.map((tool) => {
              const Icon = tool.icon;
              const enabled = isEnabled(tool.name);
              const isSaving = saving.has(tool.name);

              return (
                <div
                  key={tool.name}
                  className={`flex items-start gap-3 px-3 py-2.5 rounded-md border transition-colors ${
                    enabled ? 'bg-muted/20 hover:bg-muted/40' : 'bg-muted/5 opacity-60'
                  }`}
                >
                  <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <code className="text-sm font-mono font-medium">{tool.name}</code>
                    {tool.required && (
                      <Badge variant="outline" className="ml-2 text-[10px] text-muted-foreground border-muted-foreground/30">
                        required
                      </Badge>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                      {tool.description}
                    </p>
                  </div>
                  <div className="shrink-0 mt-0.5">
                    <Switch
                      checked={enabled}
                      disabled={tool.required || isSaving}
                      onCheckedChange={(checked) => handleToggle(tool.name, checked)}
                      aria-label={`${enabled ? 'Disable' : 'Enable'} ${tool.name}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
