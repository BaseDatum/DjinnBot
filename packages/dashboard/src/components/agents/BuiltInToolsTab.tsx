/**
 * BuiltInToolsTab — displays the static set of built-in tools every agent has,
 * with per-agent enable/disable toggles persisted to the database.
 *
 * These tools come from two sources in the agent-runtime:
 *   - Container tools   (createContainerTools)  : read, write, edit, bash, grep, find, ls, multiedit
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
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Terminal, FileText, FilePen, FileInput,
  CheckCircle, XCircle, Brain, Search, Share2, ThumbsUp, Compass,
  MessageSquare, BellRing, Save, Zap,
  Globe, BookOpen, PlusSquare, Download,
  GitBranch, FolderOpen, ClipboardList, ClipboardCheck, ListTree, Workflow,
  GitPullRequest, ArrowRightLeft, Play, GitCompareArrows, Eye,
  UserCheck, Handshake, PanelTop,
  Network, Link,
  KeyRound,
  Wrench,
  AlertTriangle,
  Send, Hash, SearchCode,
  Lock, Unlock, Activity,
  Bot, Layers, Swords, Microscope,
  Code2, MapPin, Bomb, FileDiff,
  History,
  GlobeLock, MousePointer, Type, Navigation, ScrollText,
  Camera, X, List, Cookie, ArrowLeft, ArrowRight, Captions,
  Plus, Trash2, Shield, Asterisk, ChevronDown, ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchToolOverrides,
  setToolOverrides,
  fetchMessagingPermissions,
  createMessagingPermission,
  deleteMessagingPermission,
} from '@/lib/api';
import type { MessagingChannel, MessagingPermission } from '@/lib/api';

interface BuiltInTool {
  name: string;
  description: string;
  category: string;
  icon: LucideIcon;
  /** Tools that must always stay enabled; the toggle is locked */
  required?: boolean;
}

const TOOL_CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: 'file',        label: 'File System',       color: 'text-blue-500 border-blue-500/30'      },
  { key: 'control',     label: 'Step Control',      color: 'text-green-500 border-green-500/30'    },
  { key: 'memory',      label: 'Memory',            color: 'text-purple-500 border-purple-500/30'  },
  { key: 'graph',       label: 'Memory Graph',      color: 'text-violet-500 border-violet-500/30'  },
  { key: 'messaging',   label: 'Messaging',         color: 'text-orange-500 border-orange-500/30'  },
  { key: 'research',    label: 'Research',          color: 'text-cyan-500 border-cyan-500/30'      },
  { key: 'execution',   label: 'Execution',         color: 'text-rose-500 border-rose-500/30'      },
  { key: 'codegraph',   label: 'Code Graph',        color: 'text-sky-500 border-sky-500/30'        },
  { key: 'projects',    label: 'Projects',          color: 'text-indigo-500 border-indigo-500/30'  },
  { key: 'tasks',       label: 'Tasks',             color: 'text-pink-500 border-pink-500/30'      },
  { key: 'workledger',  label: 'Work Ledger',       color: 'text-amber-500 border-amber-500/30'    },
  { key: 'runhistory',  label: 'Run History',       color: 'text-stone-500 border-stone-500/30'    },
  { key: 'skills',      label: 'Skills',            color: 'text-yellow-500 border-yellow-500/30'  },
  { key: 'github',      label: 'GitHub',            color: 'text-foreground border-border'         },
  { key: 'secrets',     label: 'Secrets',           color: 'text-red-500 border-red-500/30'        },
  { key: 'slack',       label: 'Slack',             color: 'text-emerald-500 border-emerald-500/30'},
  { key: 'discord',     label: 'Discord',           color: 'text-indigo-400 border-indigo-400/30'  },
  { key: 'telegram',    label: 'Telegram',          color: 'text-sky-400 border-sky-400/30'        },
  { key: 'whatsapp',    label: 'WhatsApp',          color: 'text-green-400 border-green-400/30'    },
  { key: 'signal',      label: 'Signal',            color: 'text-blue-400 border-blue-400/30'      },
  { key: 'browser',     label: 'Browser (Camofox)', color: 'text-lime-500 border-lime-500/30'      },
  { key: 'onboarding',  label: 'Onboarding',        color: 'text-teal-500 border-teal-500/30'      },
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
    description: 'Execute shell commands with stdout/stderr streaming to the UI. Supports timeouts and abort signals. Output auto-truncated at 2000 lines / 50KB.',
    category: 'file',
    icon: Terminal,
  },
  {
    name: 'grep',
    description: 'Search file contents for a regex or literal pattern using ripgrep. Returns matching lines with paths and line numbers. Respects .gitignore. Supports glob filtering and context lines.',
    category: 'file',
    icon: SearchCode,
  },
  {
    name: 'find',
    description: 'Search for files by glob pattern using fd. Returns matching file paths relative to the search directory. Respects .gitignore.',
    category: 'file',
    icon: FolderOpen,
  },
  {
    name: 'ls',
    description: 'List directory contents sorted alphabetically with directory indicators. Includes dotfiles. Output capped at 500 entries.',
    category: 'file',
    icon: List,
  },
  {
    name: 'multiedit',
    description: 'Apply multiple edits to a single file in one call. Reads once, applies edits sequentially with fuzzy matching, writes once. More efficient than multiple separate edit calls.',
    category: 'file',
    icon: FileDiff,
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
    description: 'Store a memory (fact, decision, lesson, etc.) in the personal or shared vault. Supports wiki-links and 8 memory types.',
    category: 'memory',
    icon: Brain,
  },
  {
    name: 'recall',
    description: 'Full-text content search across memories (BM25 keyword + semantic matching). Scope can be personal, shared, or all.',
    category: 'memory',
    icon: Search,
  },
  {
    name: 'context_query',
    description: 'Build intelligent, task-relevant context from the memory vault. Combines semantic search, knowledge graph traversal, profile-based ranking, and token budgeting.',
    category: 'memory',
    icon: Compass,
  },
  {
    name: 'rate_memories',
    description: 'Rate recalled memories as useful or not useful. Feeds into adaptive memory scoring to improve future retrieval.',
    category: 'memory',
    icon: ThumbsUp,
  },
  {
    name: 'share_knowledge',
    description: 'Share a pattern, decision, or issue with the entire team by writing to the shared vault.',
    category: 'memory',
    icon: Share2,
  },

  // ── Memory graph tools ────────────────────────────────────────────────────
  {
    name: 'graph_query',
    description: 'Navigate the knowledge graph structure. Get a summary, find neighbors of a node, or search by title/tag. For content search use recall instead.',
    category: 'graph',
    icon: Network,
  },
  {
    name: 'link_memory',
    description: 'Create a typed link between two memories in the knowledge graph. Build connections between related decisions, lessons, and facts.',
    category: 'graph',
    icon: Link,
  },

  // ── Messaging tools ───────────────────────────────────────────────────────
  {
    name: 'message_agent',
    description: 'Send a message to another agent\'s inbox. They will see it on their next scheduled pulse.',
    category: 'messaging',
    icon: MessageSquare,
  },
  {
    name: 'wake_agent',
    description: 'Immediately wake another agent for urgent matters (user requests, blockers, critical findings). Rate-limited to 3 per session.',
    category: 'messaging',
    icon: Zap,
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

  // ── Execution tools ───────────────────────────────────────────────────────
  {
    name: 'spawn_executor',
    description: 'Spawn a fresh agent instance to execute a task with a clean context window. The executor runs in a separate container with the task\'s git workspace. Blocks until complete.',
    category: 'execution',
    icon: Bot,
  },
  {
    name: 'swarm_execute',
    description: 'Execute multiple tasks in parallel as a dependency-aware swarm (DAG). Root tasks start immediately, dependent tasks auto-start when dependencies complete.',
    category: 'execution',
    icon: Layers,
  },
  {
    name: 'try_approaches',
    description: 'Execute competing approaches to a task in parallel and auto-select the best one. Each approach runs in an isolated container with its own git branch.',
    category: 'execution',
    icon: Swords,
  },
  {
    name: 'focused_analysis',
    description: 'Delegate a focused analytical question to a fast sub-model without consuming your context window. Completes in 3-30 seconds.',
    category: 'execution',
    icon: Microscope,
  },

  // ── Code graph tools ──────────────────────────────────────────────────────
  {
    name: 'code_graph_query',
    description: 'Search a project\'s codebase knowledge graph. Returns functions, classes, and execution flows matching your query.',
    category: 'codegraph',
    icon: Code2,
  },
  {
    name: 'code_graph_context',
    description: 'Get complete context for a code symbol: callers, callees, execution flows, and functional cluster membership.',
    category: 'codegraph',
    icon: MapPin,
  },
  {
    name: 'code_graph_impact',
    description: 'Analyze what would break if you change a code symbol. Returns affected symbols grouped by depth and affected execution flows.',
    category: 'codegraph',
    icon: Bomb,
  },
  {
    name: 'code_graph_changes',
    description: 'Map current uncommitted git changes to affected code symbols and execution flows. Pre-commit safety check.',
    category: 'codegraph',
    icon: FileDiff,
  },

  // ── Project tools ─────────────────────────────────────────────────────────
  {
    name: 'create_project',
    description: 'Create a new project in DjinnBot from a template or default columns. Optionally link a git repository. Auto-assigns the agent as a member.',
    category: 'projects',
    icon: PlusSquare,
  },
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
    icon: Eye,
  },

  // ── Task tools ────────────────────────────────────────────────────────────
  {
    name: 'create_task',
    description: 'Create a new task in a project kanban board. Placed in Ready column (or Backlog if it has dependencies).',
    category: 'tasks',
    icon: PlusSquare,
  },
  {
    name: 'create_subtask',
    description: 'Create a subtask under an existing parent task. Subtasks represent bite-sized work (1-4 hours).',
    category: 'tasks',
    icon: ListTree,
  },
  {
    name: 'add_dependency',
    description: 'Add a dependency between two tasks. The dependent task cannot start until the blocker completes. Validates against circular dependencies.',
    category: 'tasks',
    icon: Workflow,
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
    name: 'get_task_pr_status',
    description: 'Check the current PR status: state, reviews, CI checks, and whether the PR is ready to merge.',
    category: 'tasks',
    icon: GitCompareArrows,
  },
  {
    name: 'transition_task',
    description: 'Move a task to a new kanban status (e.g. in_progress → review → done). Cascades dependency unblocking.',
    category: 'tasks',
    icon: ArrowRightLeft,
  },
  {
    name: 'get_task_workflow',
    description: 'Get the required workflow stages for a task based on its work type. Shows which stages are required, optional, skipped, and what the next valid transition is.',
    category: 'tasks',
    icon: Workflow,
  },
  {
    name: 'execute_task',
    description: 'Trigger a task\'s pipeline to start executing it autonomously.',
    category: 'tasks',
    icon: Play,
  },

  // ── Work ledger tools ─────────────────────────────────────────────────────
  {
    name: 'acquire_work_lock',
    description: 'Lock a work item to prevent duplicate work across concurrent sessions. Auto-expires on crash.',
    category: 'workledger',
    icon: Lock,
  },
  {
    name: 'release_work_lock',
    description: 'Release a work lock when finished with a task, making it available for other sessions.',
    category: 'workledger',
    icon: Unlock,
  },
  {
    name: 'get_active_work',
    description: 'List all active work locks held by this agent across all sessions.',
    category: 'workledger',
    icon: Activity,
  },

  // ── Run history tools ─────────────────────────────────────────────────────
  {
    name: 'get_run_history',
    description: 'Query past pipeline runs, executor results, and task attempts. Filter by project, task, status, or time range. Procedural memory for learning from past work.',
    category: 'runhistory',
    icon: History,
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
    description: 'Post a message to a Slack channel by ID or name. Supports mrkdwn formatting and thread replies.',
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

  // ── Discord tools ─────────────────────────────────────────────────────────
  {
    name: 'discord_send_message',
    description: 'Send a message to a Discord channel or DM a user. Supports Discord markdown and thread replies.',
    category: 'discord',
    icon: Send,
  },
  {
    name: 'discord_list_channels',
    description: 'List the Discord channels the agent\'s bot has access to, including IDs, names, types, and guild info.',
    category: 'discord',
    icon: Hash,
  },
  {
    name: 'discord_lookup_user',
    description: 'Look up a Discord user by their user ID. Returns username, display name, and bot status.',
    category: 'discord',
    icon: SearchCode,
  },

  // ── Telegram tools ──────────────────────────────────────────────────────
  {
    name: 'send_telegram_message',
    description: 'Send a Telegram message to a user or chat for escalation or notification. Supports markdown formatting and urgent flags.',
    category: 'telegram',
    icon: Send,
  },
  {
    name: 'telegram_list_targets',
    description: 'List the Telegram chat IDs and usernames this agent is allowed to send messages to.',
    category: 'telegram',
    icon: SearchCode,
  },

  // ── WhatsApp tools ─────────────────────────────────────────────────────
  {
    name: 'send_whatsapp_message',
    description: 'Send a WhatsApp message to a phone number or group. Messages sent from the shared WhatsApp linked device.',
    category: 'whatsapp',
    icon: Send,
  },
  {
    name: 'whatsapp_list_targets',
    description: 'List the phone numbers and groups this agent is allowed to send WhatsApp messages to.',
    category: 'whatsapp',
    icon: SearchCode,
  },

  // ── Signal tools ───────────────────────────────────────────────────────
  {
    name: 'send_signal_message',
    description: 'Send a Signal message to a phone number or group. Messages sent from the shared Signal linked device.',
    category: 'signal',
    icon: Send,
  },
  {
    name: 'signal_list_targets',
    description: 'List the phone numbers and groups this agent is allowed to send Signal messages to.',
    category: 'signal',
    icon: SearchCode,
  },

  // ── Browser tools (Camofox) ───────────────────────────────────────────────
  {
    name: 'camofox_create_tab',
    description: 'Create a new browser tab using the Camoufox anti-detection browser. Bypasses bot detection on Google, Amazon, LinkedIn, etc.',
    category: 'browser',
    icon: GlobeLock,
  },
  {
    name: 'camofox_snapshot',
    description: 'Get accessibility snapshot of a page with element refs (e1, e2, etc.) for interaction. Supports pagination for large pages.',
    category: 'browser',
    icon: Camera,
  },
  {
    name: 'camofox_click',
    description: 'Click an element in a browser tab by ref (e.g. e1) or CSS selector.',
    category: 'browser',
    icon: MousePointer,
  },
  {
    name: 'camofox_type',
    description: 'Type text into an element in a browser tab. Optionally press Enter after typing.',
    category: 'browser',
    icon: Type,
  },
  {
    name: 'camofox_navigate',
    description: 'Navigate a tab to a URL or use a search macro (@google_search, @youtube_search, @amazon_search, etc.).',
    category: 'browser',
    icon: Navigation,
  },
  {
    name: 'camofox_scroll',
    description: 'Scroll a browser page in any direction (up, down, left, right).',
    category: 'browser',
    icon: ScrollText,
  },
  {
    name: 'camofox_screenshot',
    description: 'Take a screenshot of a browser page. Returns base64 PNG.',
    category: 'browser',
    icon: Camera,
  },
  {
    name: 'camofox_close_tab',
    description: 'Close a browser tab.',
    category: 'browser',
    icon: X,
  },
  {
    name: 'camofox_list_tabs',
    description: 'List all open browser tabs.',
    category: 'browser',
    icon: List,
  },
  {
    name: 'camofox_import_cookies',
    description: 'Import cookies from a Netscape-format file to authenticate to sites like LinkedIn, GitHub, etc. without interactive login.',
    category: 'browser',
    icon: Cookie,
  },
  {
    name: 'camofox_back',
    description: 'Navigate back in browser history.',
    category: 'browser',
    icon: ArrowLeft,
  },
  {
    name: 'camofox_forward',
    description: 'Navigate forward in browser history.',
    category: 'browser',
    icon: ArrowRight,
  },
  {
    name: 'camofox_youtube_transcript',
    description: 'Extract captions/transcript from a YouTube video using yt-dlp.',
    category: 'browser',
    icon: Captions,
  },

  // ── Onboarding tools ──────────────────────────────────────────────────────
  {
    name: 'update_onboarding_context',
    description: 'Update the live onboarding project profile with structured information extracted during the interview.',
    category: 'onboarding',
    icon: UserCheck,
  },
  {
    name: 'update_onboarding_landing_page',
    description: 'Update the live landing page preview during onboarding with new HTML content.',
    category: 'onboarding',
    icon: PanelTop,
  },
  {
    name: 'onboarding_handoff',
    description: 'Hand off the onboarding session to the next specialist agent, or signal "done" to create the project.',
    category: 'onboarding',
    icon: Handshake,
  },
];

// ── Categories that have messaging permission controls ──────────────────────
const MESSAGING_CATEGORIES = new Set<string>(['telegram', 'whatsapp', 'signal']);

const CHANNEL_TARGET_LABELS: Record<string, { placeholder: string; hint: string }> = {
  telegram: {
    placeholder: 'Chat ID or @username',
    hint: 'e.g. 12345678, @mychannel, or * for any',
  },
  whatsapp: {
    placeholder: 'Phone number (+E.164) or group JID',
    hint: 'e.g. +14155551234, or * for any',
  },
  signal: {
    placeholder: 'Phone number (+E.164) or group ID',
    hint: 'e.g. +14155551234, or * for any',
  },
};


// ── MessagingPermissionsPanel ───────────────────────────────────────────────

function MessagingPermissionsPanel({
  agentId,
  channel,
}: {
  agentId: string;
  channel: MessagingChannel;
}) {
  const [permissions, setPermissions] = useState<MessagingPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [newTarget, setNewTarget] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Set<number>>(new Set());

  useEffect(() => {
    fetchMessagingPermissions(agentId, channel)
      .then(setPermissions)
      .catch(() => {/* silent — empty list */})
      .finally(() => setLoading(false));
  }, [agentId, channel]);

  const hasWildcard = permissions.some((p) => p.target === '*');
  const permCount = permissions.length;

  const handleAdd = useCallback(async () => {
    const target = newTarget.trim();
    if (!target) return;
    setAdding(true);
    try {
      const perm = await createMessagingPermission(agentId, channel, target, newLabel.trim() || undefined);
      setPermissions((prev) => [...prev, perm]);
      setNewTarget('');
      setNewLabel('');
      toast.success(`Added ${channel} target: ${target}`);
    } catch (err: any) {
      toast.error(err?.message || `Failed to add ${channel} permission`);
    } finally {
      setAdding(false);
    }
  }, [agentId, channel, newTarget, newLabel]);

  const handleDelete = useCallback(async (id: number) => {
    setDeleting((prev) => new Set(prev).add(id));
    try {
      await deleteMessagingPermission(agentId, id);
      setPermissions((prev) => prev.filter((p) => p.id !== id));
      toast.success('Permission removed');
    } catch {
      toast.error('Failed to remove permission');
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [agentId]);

  const handleAddWildcard = useCallback(async () => {
    setAdding(true);
    try {
      const perm = await createMessagingPermission(agentId, channel, '*', 'Wildcard — any target');
      setPermissions((prev) => [...prev, perm]);
      toast.success(`${channel} wildcard access granted`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to add wildcard');
    } finally {
      setAdding(false);
    }
  }, [agentId, channel]);

  const meta = CHANNEL_TARGET_LABELS[channel] || CHANNEL_TARGET_LABELS.telegram;

  return (
    <div className="mt-2 ml-1 border-l-2 border-muted pl-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Shield className="h-3 w-3" />
        <span>
          Allowed targets
          {loading ? '' : permCount === 0
            ? ' (none — agent cannot send)'
            : hasWildcard
              ? ' (wildcard — any target)'
              : ` (${permCount} target${permCount !== 1 ? 's' : ''})`
          }
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {loading ? (
            <Skeleton height={32} />
          ) : (
            <>
              {/* Existing permissions */}
              {permissions.length > 0 ? (
                <div className="space-y-1">
                  {permissions.map((perm) => (
                    <div
                      key={perm.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/20 border text-xs"
                    >
                      {perm.target === '*' ? (
                        <Asterisk className="h-3 w-3 text-yellow-500 shrink-0" />
                      ) : (
                        <Shield className="h-3 w-3 text-muted-foreground shrink-0" />
                      )}
                      <code className="font-mono flex-1 truncate">
                        {perm.target}
                      </code>
                      {perm.label && (
                        <span className="text-muted-foreground truncate max-w-[120px]">
                          {perm.label}
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                        disabled={deleting.has(perm.id)}
                        onClick={() => handleDelete(perm.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic px-2">
                  No targets configured. The agent cannot send {channel} messages until targets are added.
                </p>
              )}

              {/* Add new target */}
              <div className="flex items-end gap-2 pt-1">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex gap-2">
                    <Input
                      value={newTarget}
                      onChange={(e) => setNewTarget(e.target.value)}
                      placeholder={meta.placeholder}
                      className="h-7 text-xs font-mono flex-1"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAdd();
                      }}
                    />
                    <Input
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder="Label (optional)"
                      className="h-7 text-xs w-32"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAdd();
                      }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">{meta.hint}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs px-2"
                    disabled={adding || !newTarget.trim()}
                    onClick={handleAdd}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                  {!hasWildcard && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs px-2 text-yellow-500 hover:text-yellow-600"
                      disabled={adding}
                      onClick={handleAddWildcard}
                      title="Grant access to send to any target"
                    >
                      <Asterisk className="h-3 w-3 mr-1" />
                      Allow all
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}


// ── Main component ──────────────────────────────────────────────────────────

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

          {/* Messaging permissions panel for Telegram, WhatsApp, Signal */}
          {MESSAGING_CATEGORIES.has(key) && (
            <MessagingPermissionsPanel
              agentId={agentId}
              channel={key as MessagingChannel}
            />
          )}
        </div>
      ))}
    </div>
  );
}
