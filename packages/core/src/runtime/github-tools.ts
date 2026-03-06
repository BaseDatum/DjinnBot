import { Type, type Static } from '@sinclair/typebox';
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';

// ── Type Definitions ─────────────────────────────────────────────────────

const GitHubCommentIssueParamsSchema = Type.Object({
  issue_number: Type.Number({
    description: 'Issue number (not ID)',
  }),
  body: Type.String({
    description: 'Markdown comment body',
    minLength: 1,
  }),
  project_id: Type.Optional(
    Type.String({
      description: 'Optional: override context project',
    })
  ),
});
type GitHubCommentIssueParams = Static<typeof GitHubCommentIssueParamsSchema>;

const GitHubCommentPRParamsSchema = Type.Object({
  pr_number: Type.Number({
    description: 'Pull request number',
  }),
  body: Type.String({
    description: 'Markdown comment body',
    minLength: 1,
  }),
  project_id: Type.Optional(
    Type.String({
      description: 'Optional: override context project',
    })
  ),
});
type GitHubCommentPRParams = Static<typeof GitHubCommentPRParamsSchema>;

const GitHubCreateIssueParamsSchema = Type.Object({
  title: Type.String({
    description: 'Issue title',
    minLength: 1,
    maxLength: 256,
  }),
  body: Type.String({
    description: 'Issue description (Markdown)',
  }),
  labels: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Optional labels to add',
    })
  ),
  assignees: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Optional GitHub usernames to assign',
    })
  ),
  milestone: Type.Optional(
    Type.Number({
      description: 'Optional milestone number',
    })
  ),
  project_id: Type.Optional(
    Type.String({
      description: 'Optional: override context project',
    })
  ),
});
type GitHubCreateIssueParams = Static<typeof GitHubCreateIssueParamsSchema>;

const GitHubCloseIssueParamsSchema = Type.Object({
  issue_number: Type.Number({
    description: 'Issue number to close',
  }),
  reason: Type.Optional(
    Type.Union([Type.Literal('completed'), Type.Literal('not_planned')], {
      description: 'Reason for closing (completed or not_planned)',
    })
  ),
  comment: Type.Optional(
    Type.String({
      description: 'Optional closing comment',
    })
  ),
  project_id: Type.Optional(
    Type.String({
      description: 'Optional: override context project',
    })
  ),
});
type GitHubCloseIssueParams = Static<typeof GitHubCloseIssueParamsSchema>;

const GitHubRequestChangesParamsSchema = Type.Object({
  pr_number: Type.Number({
    description: 'Pull request number',
  }),
  body: Type.String({
    description: 'Review comment body',
    minLength: 1,
  }),
  comments: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({ description: 'File path' }),
        line: Type.Number({ description: 'Line number' }),
        body: Type.String({ description: 'Comment text' }),
      }),
      {
        description: 'Optional inline comments',
      }
    )
  ),
  project_id: Type.Optional(
    Type.String({
      description: 'Optional: override context project',
    })
  ),
});
type GitHubRequestChangesParams = Static<
  typeof GitHubRequestChangesParamsSchema
>;

const GitHubApprovePRParamsSchema = Type.Object({
  pr_number: Type.Number({
    description: 'Pull request number',
  }),
  body: Type.Optional(
    Type.String({
      description: 'Optional approval comment',
    })
  ),
  project_id: Type.Optional(
    Type.String({
      description: 'Optional: override context project',
    })
  ),
});
type GitHubApprovePRParams = Static<typeof GitHubApprovePRParamsSchema>;

const GitHubMergePRParamsSchema = Type.Object({
  pr_number: Type.Number({
    description: 'Pull request number',
  }),
  method: Type.Optional(
    Type.Union(
      [
        Type.Literal('merge'),
        Type.Literal('squash'),
        Type.Literal('rebase'),
      ],
      {
        description: 'Merge method (default: merge)',
        default: 'merge',
      }
    )
  ),
  commit_title: Type.Optional(
    Type.String({
      description: 'Custom commit title',
    })
  ),
  commit_message: Type.Optional(
    Type.String({
      description: 'Custom commit message',
    })
  ),
  project_id: Type.Optional(
    Type.String({
      description: 'Optional: override context project',
    })
  ),
});
type GitHubMergePRParams = Static<typeof GitHubMergePRParamsSchema>;

const GitHubAddLabelsParamsSchema = Type.Object({
  issue_or_pr: Type.Number({
    description: 'Issue or PR number',
  }),
  labels: Type.Array(Type.String(), {
    description: 'Label names to add',
    minItems: 1,
  }),
  project_id: Type.Optional(
    Type.String({
      description: 'Optional: override context project',
    })
  ),
});
type GitHubAddLabelsParams = Static<typeof GitHubAddLabelsParamsSchema>;

const GitHubAssignParamsSchema = Type.Object({
  issue_or_pr: Type.Number({
    description: 'Issue or PR number',
  }),
  assignees: Type.Array(Type.String(), {
    description: 'GitHub usernames to assign',
    minItems: 1,
  }),
  project_id: Type.Optional(
    Type.String({
      description: 'Optional: override context project',
    })
  ),
});
type GitHubAssignParams = Static<typeof GitHubAssignParamsSchema>;

// ── Callbacks Interface ──────────────────────────────────────────────────

export interface GitHubToolCallbacks {
  commentIssue: (
    issueNumber: number,
    body: string,
    projectId?: string
  ) => Promise<{ success: boolean; comment_id?: number; url?: string; error?: string }>;
  
  commentPR: (
    prNumber: number,
    body: string,
    projectId?: string
  ) => Promise<{ success: boolean; comment_id?: number; url?: string; error?: string }>;
  
  createIssue: (
    title: string,
    body: string,
    labels?: string[],
    assignees?: string[],
    milestone?: number,
    projectId?: string
  ) => Promise<{ success: boolean; issue_number?: number; url?: string; error?: string }>;
  
  closeIssue: (
    issueNumber: number,
    reason?: 'completed' | 'not_planned',
    comment?: string,
    projectId?: string
  ) => Promise<{ success: boolean; state?: string; closed_at?: string; error?: string }>;
  
  requestChanges: (
    prNumber: number,
    body: string,
    comments?: Array<{ path: string; line: number; body: string }>,
    projectId?: string
  ) => Promise<{ success: boolean; review_id?: number; url?: string; error?: string }>;
  
  approvePR: (
    prNumber: number,
    body?: string,
    projectId?: string
  ) => Promise<{ success: boolean; review_id?: number; url?: string; error?: string }>;
  
  mergePR: (
    prNumber: number,
    method?: 'merge' | 'squash' | 'rebase',
    commitTitle?: string,
    commitMessage?: string,
    projectId?: string
  ) => Promise<{ success: boolean; merged?: boolean; sha?: string; message?: string; error?: string }>;
  
  addLabels: (
    issueOrPr: number,
    labels: string[],
    projectId?: string
  ) => Promise<{ success: boolean; labels?: string[]; error?: string }>;
  
  assign: (
    issueOrPr: number,
    assignees: string[],
    projectId?: string
  ) => Promise<{ success: boolean; assignees?: string[]; error?: string }>;
}

// ── Tool Creation ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface VoidDetails {}

/**
 * Create GitHub tools for agents to interact with issues and pull requests.
 * 
 * These tools enable agents to:
 * - Comment on issues and PRs
 * - Create, close, and label issues
 * - Approve, request changes, and merge PRs
 * - Assign users to issues/PRs
 * 
 * The actual GitHub API calls are delegated to callbacks, allowing the
 * implementation to handle authentication, rate limiting, and context injection.
 */
export function createGitHubTools(
  callbacks: GitHubToolCallbacks
): AgentTool[] {
  return [
    // ── github_comment_issue ─────────────────────────────────────────────
    {
      name: 'github_comment_issue',
      description:
        'Post a comment on a GitHub issue. Use this to respond to issue discussions, provide updates, or ask clarifying questions.',
      label: 'github_comment_issue',
      parameters: GitHubCommentIssueParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GitHubCommentIssueParams;
        
        const result = await callbacks.commentIssue(
          typedParams.issue_number,
          typedParams.body,
          typedParams.project_id
        );
        
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Comment posted on issue #${typedParams.issue_number}\n\nComment ID: ${result.comment_id}\nURL: ${result.url}`,
              },
            ],
            details: {},
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to comment on issue #${typedParams.issue_number}: ${result.error}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // ── github_comment_pr ────────────────────────────────────────────────
    {
      name: 'github_comment_pr',
      description:
        'Post a comment on a pull request. Use this to provide feedback, ask questions, or update PR status.',
      label: 'github_comment_pr',
      parameters: GitHubCommentPRParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GitHubCommentPRParams;
        
        const result = await callbacks.commentPR(
          typedParams.pr_number,
          typedParams.body,
          typedParams.project_id
        );
        
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Comment posted on PR #${typedParams.pr_number}\n\nComment ID: ${result.comment_id}\nURL: ${result.url}`,
              },
            ],
            details: {},
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to comment on PR #${typedParams.pr_number}: ${result.error}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // ── github_create_issue ──────────────────────────────────────────────
    {
      name: 'github_create_issue',
      description:
        'Create a new GitHub issue. Use this to report bugs, suggest features, or create tasks. You can optionally add labels, assignees, and link to a milestone.',
      label: 'github_create_issue',
      parameters: GitHubCreateIssueParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GitHubCreateIssueParams;
        
        const result = await callbacks.createIssue(
          typedParams.title,
          typedParams.body,
          typedParams.labels,
          typedParams.assignees,
          typedParams.milestone,
          typedParams.project_id
        );
        
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Issue created: #${result.issue_number}\n\nTitle: ${typedParams.title}\nURL: ${result.url}`,
              },
            ],
            details: {},
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to create issue: ${result.error}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // ── github_close_issue ───────────────────────────────────────────────
    {
      name: 'github_close_issue',
      description:
        'Close a GitHub issue. Optionally provide a reason (completed or not_planned) and a closing comment.',
      label: 'github_close_issue',
      parameters: GitHubCloseIssueParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GitHubCloseIssueParams;
        
        const result = await callbacks.closeIssue(
          typedParams.issue_number,
          typedParams.reason,
          typedParams.comment,
          typedParams.project_id
        );
        
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Issue #${typedParams.issue_number} closed\n\nState: ${result.state}\nClosed at: ${result.closed_at}${typedParams.reason ? `\nReason: ${typedParams.reason}` : ''}`,
              },
            ],
            details: {},
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to close issue #${typedParams.issue_number}: ${result.error}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // ── github_request_changes ───────────────────────────────────────────
    {
      name: 'github_request_changes',
      description:
        'Request changes on a pull request by creating a review. You can provide general feedback in the body and optionally add inline comments on specific files/lines.',
      label: 'github_request_changes',
      parameters: GitHubRequestChangesParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GitHubRequestChangesParams;
        
        const result = await callbacks.requestChanges(
          typedParams.pr_number,
          typedParams.body,
          typedParams.comments,
          typedParams.project_id
        );
        
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Changes requested on PR #${typedParams.pr_number}\n\nReview ID: ${result.review_id}\nURL: ${result.url}`,
              },
            ],
            details: {},
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to request changes on PR #${typedParams.pr_number}: ${result.error}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // ── github_approve_pr ────────────────────────────────────────────────
    {
      name: 'github_approve_pr',
      description:
        'Approve a pull request by creating an approval review. Optionally provide a comment explaining your approval.',
      label: 'github_approve_pr',
      parameters: GitHubApprovePRParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GitHubApprovePRParams;
        
        const result = await callbacks.approvePR(
          typedParams.pr_number,
          typedParams.body,
          typedParams.project_id
        );
        
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ PR #${typedParams.pr_number} approved\n\nReview ID: ${result.review_id}\nURL: ${result.url}`,
              },
            ],
            details: {},
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to approve PR #${typedParams.pr_number}: ${result.error}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // ── github_merge_pr ──────────────────────────────────────────────────
    {
      name: 'github_merge_pr',
      description:
        'Merge a pull request. Choose merge method (merge, squash, or rebase) and optionally customize the commit title and message.',
      label: 'github_merge_pr',
      parameters: GitHubMergePRParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GitHubMergePRParams;
        
        const result = await callbacks.mergePR(
          typedParams.pr_number,
          typedParams.method,
          typedParams.commit_title,
          typedParams.commit_message,
          typedParams.project_id
        );
        
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ PR #${typedParams.pr_number} merged\n\nMerged: ${result.merged}\nSHA: ${result.sha}\nMethod: ${typedParams.method || 'merge'}`,
              },
            ],
            details: {},
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to merge PR #${typedParams.pr_number}: ${result.error}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // ── github_add_labels ────────────────────────────────────────────────
    {
      name: 'github_add_labels',
      description:
        'Add labels to an issue or pull request. Labels help categorize and organize work.',
      label: 'github_add_labels',
      parameters: GitHubAddLabelsParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GitHubAddLabelsParams;
        
        const result = await callbacks.addLabels(
          typedParams.issue_or_pr,
          typedParams.labels,
          typedParams.project_id
        );
        
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Labels added to #${typedParams.issue_or_pr}\n\nLabels: ${result.labels?.join(', ')}`,
              },
            ],
            details: {},
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to add labels to #${typedParams.issue_or_pr}: ${result.error}`,
              },
            ],
            details: {},
          };
        }
      },
    },

    // ── github_assign ────────────────────────────────────────────────────
    {
      name: 'github_assign',
      description:
        'Assign users to an issue or pull request. Assignees are responsible for the work.',
      label: 'github_assign',
      parameters: GitHubAssignParamsSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const typedParams = params as GitHubAssignParams;
        
        const result = await callbacks.assign(
          typedParams.issue_or_pr,
          typedParams.assignees,
          typedParams.project_id
        );
        
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: `✅ Users assigned to #${typedParams.issue_or_pr}\n\nAssignees: ${result.assignees?.map(a => `@${a}`).join(', ')}`,
              },
            ],
            details: {},
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Failed to assign users to #${typedParams.issue_or_pr}: ${result.error}`,
              },
            ],
            details: {},
          };
        }
      },
    },
  ];
}
