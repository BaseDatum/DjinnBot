/**
 * SlackUserResolver — maps Slack user IDs to DjinnBot user IDs via the API.
 *
 * When a Slack message arrives, this resolver:
 *   1. Queries the DjinnBot API for a user matching the Slack member ID
 *   2. If found, returns the DjinnBot user ID (used for per-user key resolution)
 *   3. If not found, returns null + an error message to send back to the user
 *
 * The API endpoint used is GET /v1/users/by-slack-id/{slackId} which is
 * added by this change.  Results are cached in memory for 5 minutes.
 */

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  djinnbotUserId: string | null;
  fetchedAt: number;
}

export interface SlackUserResolveResult {
  /** The DjinnBot user ID, or null if not found */
  userId: string | null;
  /** If userId is null, a human-readable message to send back via Slack */
  errorMessage?: string;
}

export class SlackUserResolver {
  private cache = new Map<string, CacheEntry>();
  private apiBaseUrl: string;

  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl;
  }

  /**
   * Resolve a Slack user ID to a DjinnBot user ID.
   *
   * @param slackUserId - The Slack member ID (e.g. "U0123456789")
   * @returns Resolve result with userId or errorMessage
   */
  async resolve(slackUserId: string): Promise<SlackUserResolveResult> {
    // Check cache
    const cached = this.cache.get(slackUserId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      if (cached.djinnbotUserId) {
        return { userId: cached.djinnbotUserId };
      }
      return {
        userId: null,
        errorMessage: this.buildNotLinkedMessage(slackUserId),
      };
    }

    // Query the DjinnBot API
    try {
      const res = await fetch(
        `${this.apiBaseUrl}/v1/users/by-slack-id/${encodeURIComponent(slackUserId)}`,
      );

      if (res.ok) {
        const data = (await res.json()) as { userId: string };
        this.cache.set(slackUserId, { djinnbotUserId: data.userId, fetchedAt: Date.now() });
        return { userId: data.userId };
      }

      if (res.status === 404) {
        // Slack ID not linked to any DjinnBot user
        this.cache.set(slackUserId, { djinnbotUserId: null, fetchedAt: Date.now() });
        return {
          userId: null,
          errorMessage: this.buildNotLinkedMessage(slackUserId),
        };
      }

      // Other error — don't cache, return null silently
      console.warn(`[SlackUserResolver] API error resolving ${slackUserId}: ${res.status}`);
      return { userId: null };
    } catch (err) {
      console.warn(`[SlackUserResolver] Failed to resolve ${slackUserId}:`, err);
      return { userId: null };
    }
  }

  /**
   * Check whether a user has the right provider key for a given model.
   * If the user has no key for the model's provider, returns an error message.
   *
   * @param userId - DjinnBot user ID
   * @param model  - Model string like "openrouter/anthropic/claude-sonnet-4"
   */
  async checkUserHasProviderKey(userId: string, model: string): Promise<string | null> {
    try {
      const res = await fetch(
        `${this.apiBaseUrl}/v1/settings/providers/keys/all?user_id=${encodeURIComponent(userId)}`,
      );
      if (!res.ok) return null;

      const data = (await res.json()) as { keys: Record<string, string> };
      const provider = model.split('/')[0];

      if (!provider) return null;

      // Check if the user has the key for this provider
      if (data.keys[provider]) return null; // Has the key — all good

      return (
        `You don't have an API key configured for the *${provider}* provider in DjinnBot. ` +
        `Please add one in your DjinnBot *Profile > Model Providers* section, ` +
        `or ask an admin to share their key with you.`
      );
    } catch {
      return null; // Network error — don't block, let the session try anyway
    }
  }

  private buildNotLinkedMessage(slackUserId: string): string {
    return (
      `Your Slack ID (\`${slackUserId}\`) isn't linked to a DjinnBot account. ` +
      `To use DjinnBot from Slack, go to your DjinnBot instance and:\n\n` +
      `1. Navigate to *Profile > Slack*\n` +
      `2. Enter your Slack member ID: \`${slackUserId}\`\n` +
      `   _(Find it in Slack: click your profile photo > Profile > ⋮ > Copy member ID)_\n` +
      `3. Save — then try your message again.`
    );
  }

  /** Clear the cache (e.g. when a user updates their profile) */
  clearCache(): void {
    this.cache.clear();
  }
}
