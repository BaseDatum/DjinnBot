/**
 * DiscordUserResolver — maps Discord user IDs to DjinnBot user IDs via the API.
 *
 * When a Discord message arrives, this resolver:
 *   1. Queries the DjinnBot API for a user matching the Discord user ID
 *   2. If found, returns the DjinnBot user ID (used for per-user key resolution)
 *   3. If not found, returns null + an error message to send back to the user
 *
 * Results are cached in memory for 5 minutes.
 */

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  djinnbotUserId: string | null;
  fetchedAt: number;
}

export interface DiscordUserResolveResult {
  /** The DjinnBot user ID, or null if not found */
  userId: string | null;
  /** If userId is null, a human-readable message to send back via Discord */
  errorMessage?: string;
}

export class DiscordUserResolver {
  private cache = new Map<string, CacheEntry>();
  private apiBaseUrl: string;

  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl;
  }

  /**
   * Resolve a Discord user ID to a DjinnBot user ID.
   *
   * @param discordUserId - The Discord user ID (snowflake string)
   * @returns Resolve result with userId or errorMessage
   */
  async resolve(discordUserId: string): Promise<DiscordUserResolveResult> {
    // Check cache
    const cached = this.cache.get(discordUserId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      if (cached.djinnbotUserId) {
        return { userId: cached.djinnbotUserId };
      }
      return {
        userId: null,
        errorMessage: this.buildNotLinkedMessage(discordUserId),
      };
    }

    // Query the DjinnBot API
    try {
      const res = await fetch(
        `${this.apiBaseUrl}/v1/users/by-discord-id/${encodeURIComponent(discordUserId)}`,
      );

      if (res.ok) {
        const data = (await res.json()) as { userId: string };
        this.cache.set(discordUserId, { djinnbotUserId: data.userId, fetchedAt: Date.now() });
        return { userId: data.userId };
      }

      if (res.status === 404) {
        // Discord ID not linked to any DjinnBot user
        this.cache.set(discordUserId, { djinnbotUserId: null, fetchedAt: Date.now() });
        return {
          userId: null,
          errorMessage: this.buildNotLinkedMessage(discordUserId),
        };
      }

      // Other error — don't cache, return null silently
      console.warn(`[DiscordUserResolver] API error resolving ${discordUserId}: ${res.status}`);
      return { userId: null };
    } catch (err) {
      console.warn(`[DiscordUserResolver] Failed to resolve ${discordUserId}:`, err);
      return { userId: null };
    }
  }

  /**
   * Check whether a user has the right provider key for a given model.
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
      if (data.keys[provider]) return null; // Has the key

      return (
        `You don't have an API key configured for the **${provider}** provider in DjinnBot. ` +
        `Please add one in your DjinnBot **Profile > Model Providers** section, ` +
        `or ask an admin to share their key with you.`
      );
    } catch {
      return null; // Network error — don't block
    }
  }

  private buildNotLinkedMessage(discordUserId: string): string {
    return (
      `Your Discord ID (\`${discordUserId}\`) isn't linked to a DjinnBot account.\n\n` +
      `To use DjinnBot from Discord:\n` +
      `1. Navigate to **Profile > Discord** in your DjinnBot dashboard\n` +
      `2. Enter your Discord user ID: \`${discordUserId}\`\n` +
      `   _(Find it: User Settings > Advanced > Enable Developer Mode, then right-click your name > Copy User ID)_\n` +
      `3. Save — then try your message again.`
    );
  }

  /** Clear the cache */
  clearCache(): void {
    this.cache.clear();
  }
}
