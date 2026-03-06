import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { authFetch } from '../../api/auth-fetch.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const GetGithubTokenParamsSchema = Type.Object({
  repo: Type.String({
    description: 'Repository path or full URL. Accepts: "owner/repo", ' +
      '"https://github.com/owner/repo", "https://github.com/owner/repo.git". ' +
      'The API resolves which GitHub App installation covers this repo automatically.',
  }),
});
type GetGithubTokenParams = Static<typeof GetGithubTokenParamsSchema>;

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

export interface GitHubToolsConfig {
  apiBaseUrl?: string;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createGitHubTools(config: GitHubToolsConfig): AgentTool[] {
  const getApiBase = () =>
    config.apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';

  return [
    // get_github_token — get a short-lived token for a specific repo, auto-configure git credential helper
    {
      name: 'get_github_token',
      description: 'Get a GitHub App access token for a specific repository. ' +
        'Pass the repo URL or "owner/repo" path — the API automatically resolves which ' +
        'installation covers that repo (no installation ID needed). ' +
        'If the GitHub App is not installed on the repo, returns a clear message with ' +
        'instructions for the user to install it. ' +
        'This tool also configures the git credential helper so subsequent ' +
        'git clone/pull/push commands work without any extra auth.',
      label: 'get_github_token',
      parameters: GetGithubTokenParamsSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const { repo } = params as GetGithubTokenParams;
        const apiBase = getApiBase();
        try {
          const url = new URL(`${apiBase}/v1/github/repo-token`);
          url.searchParams.set('repo', repo);
          const response = await authFetch(url.toString(), { signal: signal ?? undefined });

          if (!response.ok) {
            const body = await response.json().catch(() => ({ detail: response.statusText })) as { detail?: string };
            const detail = body.detail ?? response.statusText;
            if (response.status === 404) {
              return { content: [{ type: 'text', text: detail }], details: {} };
            }
            if (response.status === 503) {
              return { content: [{ type: 'text', text: 'GitHub App is not configured on this DjinnBot instance. Use a Personal Access Token instead (Settings → Secrets → add GITHUB_TOKEN → grant to Stas).' }], details: {} };
            }
            return { content: [{ type: 'text', text: `Failed to get GitHub token: ${response.status} — ${detail}` }], details: {} };
          }

          const data = await response.json() as {
            token: string;
            expires_at: number;
            installation_id: number;
            owner: string;
            repo: string;
            clone_url: string;
          };
          const { token, clone_url, owner, repo: repoName } = data;

          // Configure git credential helper so all subsequent git operations authenticate automatically.
          const { execSync } = await import('child_process');
          try {
            execSync('git config --global credential.helper store', { stdio: 'ignore' });
            const fs = await import('fs');
            const credLine = `https://x-access-token:${token}@github.com\n`;
            fs.appendFileSync(`${process.env.HOME ?? '/root'}/.git-credentials`, credLine, 'utf8');
            execSync(
              `git config --global url."https://x-access-token:${token}@github.com/".insteadOf "https://github.com/"`,
              { stdio: 'ignore' },
            );
          } catch {
            // Credential helper config is best-effort — token is still returned
          }

          const expiresIn = Math.round((data.expires_at - Date.now()) / 60000);
          return {
            content: [{
              type: 'text',
              text: [
                `GitHub App token obtained for ${owner}/${repoName} (installation ${data.installation_id}).`,
                `Expires in ~${expiresIn} minutes.`,
                `Git credential helper configured — \`git clone https://github.com/${owner}/${repoName}.git\` will work directly.`,
                `Authenticated clone URL: ${clone_url}`,
              ].join('\n'),
            }],
            details: {},
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to get GitHub token: ${err}` }], details: {} };
        }
      },
    },
  ];
}
