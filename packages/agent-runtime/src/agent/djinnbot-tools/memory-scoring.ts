/**
 * MemoryRetrievalTracker — tracks which memories were surfaced during
 * recall/wake calls within a step, then flushes the batch to the API
 * with the step outcome (success/failure) after the step completes.
 *
 * Also provides score-blending: fetches adaptive scores from the API
 * and merges them with raw BM25/vector scores at recall time.
 *
 * Architecture:
 *   - Shared instance between memory tools and the runner
 *   - Tools call track() for each surfaced memory
 *   - Runner calls flush() after step completes with the outcome
 *   - Tools call getAdaptiveScores() to blend scores at recall time
 */

import { authFetch } from '../../api/auth-fetch.js';

export interface TrackedRetrieval {
  memoryId: string;
  memoryTitle?: string;
  query?: string;
  retrievalSource: string; // bm25, vector, shared_bm25, shared_vector, wake_bm25, wake_vector
  rawScore: number;
}

export interface AdaptiveScore {
  memoryId: string;
  accessCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  adaptiveScore: number;
  lastAccessed: number;
}

export class MemoryRetrievalTracker {
  private retrievals: TrackedRetrieval[] = [];
  private apiBaseUrl: string;
  private agentId: string;
  private scoreCache: Map<string, AdaptiveScore> = new Map();
  private scoreCacheAge = 0;
  private static readonly SCORE_CACHE_TTL_MS = 60_000; // 1 minute

  // Blend factors from the server (configurable via admin dashboard)
  private blendBaseFactor = 0.70;
  private blendBoostFactor = 0.30;

  constructor(agentId: string, apiBaseUrl?: string) {
    this.agentId = agentId;
    this.apiBaseUrl = apiBaseUrl || process.env.DJINNBOT_API_URL || 'http://api:8000';
  }

  /**
   * Track a memory retrieval. Called by recall/wake tools for each result.
   */
  track(retrieval: TrackedRetrieval): void {
    this.retrievals.push(retrieval);
  }

  /**
   * Get the number of tracked retrievals in the current step.
   */
  get count(): number {
    return this.retrievals.length;
  }

  /**
   * Flush all tracked retrievals to the API with the step outcome.
   * Called by the runner after each step completes.
   * Fire-and-forget — errors are logged but don't block.
   */
  async flush(stepSuccess: boolean | null): Promise<void> {
    if (this.retrievals.length === 0) return;

    const batch = this.retrievals.splice(0);

    const sessionId = process.env.SESSION_ID || process.env.CHAT_SESSION_ID || undefined;
    const runId = process.env.RUN_ID || undefined;

    const payload = {
      agent_id: this.agentId,
      session_id: sessionId,
      run_id: runId,
      request_id: undefined, // Could be wired from requestIdRef if needed
      step_success: stepSuccess,
      retrievals: batch.map(r => ({
        memory_id: r.memoryId,
        memory_title: r.memoryTitle,
        query: r.query,
        retrieval_source: r.retrievalSource,
        raw_score: r.rawScore,
      })),
    };

    try {
      await authFetch(`${this.apiBaseUrl}/v1/internal/memory-retrievals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.warn('[MemoryRetrievalTracker] Failed to flush retrievals:', err);
    }
  }

  /**
   * Clear tracked retrievals without flushing (e.g., on step reset).
   */
  clear(): void {
    this.retrievals.length = 0;
  }

  /**
   * Fetch adaptive scores for a set of memory IDs from the API.
   * Results are cached for SCORE_CACHE_TTL_MS to avoid excessive API calls
   * during a single step with multiple recall invocations.
   */
  async getAdaptiveScores(memoryIds: string[]): Promise<Map<string, AdaptiveScore>> {
    if (memoryIds.length === 0) return new Map();

    const now = Date.now();
    const cacheValid = (now - this.scoreCacheAge) < MemoryRetrievalTracker.SCORE_CACHE_TTL_MS;

    // Check if all requested IDs are in cache
    if (cacheValid) {
      const allCached = memoryIds.every(id => this.scoreCache.has(id));
      if (allCached) {
        const result = new Map<string, AdaptiveScore>();
        for (const id of memoryIds) {
          const cached = this.scoreCache.get(id);
          if (cached) result.set(id, cached);
        }
        return result;
      }
    }

    // Fetch from API
    try {
      const idsParam = memoryIds.join(',');
      const resp = await authFetch(
        `${this.apiBaseUrl}/v1/internal/memory-scores/${encodeURIComponent(this.agentId)}?memory_ids=${encodeURIComponent(idsParam)}`,
      );

      if (!resp.ok) {
        console.warn(`[MemoryRetrievalTracker] Score fetch failed: ${resp.status}`);
        return new Map();
      }

      const data = await resp.json() as {
        scores: Array<{
          memory_id: string;
          access_count: number;
          success_count: number;
          failure_count: number;
          success_rate: number;
          adaptive_score: number;
          last_accessed: number;
        }>;
        blend_base_factor?: number;
        blend_boost_factor?: number;
      };

      // Update blend factors from server config
      if (data.blend_base_factor !== undefined) this.blendBaseFactor = data.blend_base_factor;
      if (data.blend_boost_factor !== undefined) this.blendBoostFactor = data.blend_boost_factor;

      // Update cache
      this.scoreCacheAge = now;
      const result = new Map<string, AdaptiveScore>();

      for (const s of data.scores) {
        const score: AdaptiveScore = {
          memoryId: s.memory_id,
          accessCount: s.access_count,
          successCount: s.success_count,
          failureCount: s.failure_count,
          successRate: s.success_rate,
          adaptiveScore: s.adaptive_score,
          lastAccessed: s.last_accessed,
        };
        this.scoreCache.set(s.memory_id, score);
        result.set(s.memory_id, score);
      }

      return result;
    } catch (err) {
      console.warn('[MemoryRetrievalTracker] Failed to fetch adaptive scores:', err);
      return new Map();
    }
  }

  /**
   * Blend raw search scores with adaptive scores.
   * 
   * Formula: blended = rawScore * (baseFactor + boostFactor * adaptiveScore)
   * 
   * The base and boost factors are configurable via the admin dashboard.
   * Defaults: base=0.70, boost=0.30. The server guarantees
   * adaptive_score >= floor (default 0.35), so no memory can be
   * permanently suppressed.
   */
  blendScore(rawScore: number, adaptiveScore: number | undefined): number {
    if (adaptiveScore === undefined) return rawScore;
    return rawScore * (this.blendBaseFactor + this.blendBoostFactor * adaptiveScore);
  }

  /**
   * Static version with explicit factors (for use without a tracker instance).
   */
  static blendScoreStatic(rawScore: number, adaptiveScore: number | undefined, baseFactor = 0.70, boostFactor = 0.30): number {
    if (adaptiveScore === undefined) return rawScore;
    return rawScore * (baseFactor + boostFactor * adaptiveScore);
  }
}
