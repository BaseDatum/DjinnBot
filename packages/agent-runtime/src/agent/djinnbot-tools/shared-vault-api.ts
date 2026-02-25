/**
 * Shared vault API client.
 *
 * Agent containers do NOT mount the shared vault filesystem. Instead, they
 * interact with shared knowledge through the DjinnBot API. The engine
 * maintains the shared vault (indexing, embeddings, graph rebuilds) and the
 * API exposes read/write operations.
 *
 * This provides true security isolation: an agent cannot read or tamper with
 * the shared vault outside of validated API calls.
 */

import { authFetch } from '../../api/auth-fetch.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SharedSearchResult {
  filename: string;
  snippet: string;
  score: number;
  title?: string;
  category?: string;
}

export interface SharedGraphData {
  nodes: Array<{ id: string; title: string; type: string; degree?: number; tags?: string[] }>;
  edges: Array<{ source: string; target: string; type: string }>;
  stats: Record<string, unknown>;
}

export interface SharedStoreRequest {
  category: string;
  title: string;
  content: string;
  frontmatter?: Record<string, unknown>;
  agent_id: string;
}

export interface SharedContextResult {
  context: string;
  entries: number;
  profile: string;
}

// ── Client ─────────────────────────────────────────────────────────────────

export class SharedVaultClient {
  constructor(private apiBaseUrl: string) {}

  /**
   * Search the shared vault via the API (BM25 keyword search).
   */
  async search(query: string, limit: number = 10): Promise<SharedSearchResult[]> {
    const url = `${this.apiBaseUrl}/v1/memory/vaults/shared/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    const resp = await authFetch(url);
    if (!resp.ok) {
      throw new Error(`Shared vault search failed: ${resp.status} ${resp.statusText}`);
    }
    return await resp.json() as SharedSearchResult[];
  }

  /**
   * Store a memory in the shared vault via the API.
   */
  async store(req: SharedStoreRequest): Promise<{ filename: string }> {
    const url = `${this.apiBaseUrl}/v1/memory/vaults/shared/store`;
    const resp = await authFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!resp.ok) {
      throw new Error(`Shared vault store failed: ${resp.status} ${resp.statusText}`);
    }
    return await resp.json() as { filename: string };
  }

  /**
   * Get the shared vault knowledge graph.
   */
  async getGraph(): Promise<SharedGraphData> {
    const url = `${this.apiBaseUrl}/v1/memory/vaults/shared/graph`;
    const resp = await authFetch(url);
    if (!resp.ok) {
      throw new Error(`Shared vault graph failed: ${resp.status} ${resp.statusText}`);
    }
    return await resp.json() as SharedGraphData;
  }

  /**
   * Get neighbors of a node in the shared knowledge graph.
   */
  async getNeighbors(nodeId: string, maxHops: number = 1): Promise<SharedGraphData> {
    const url = `${this.apiBaseUrl}/v1/memory/vaults/shared/graph/neighbors/${encodeURIComponent(nodeId)}?max_hops=${maxHops}`;
    const resp = await authFetch(url);
    if (!resp.ok) {
      throw new Error(`Shared vault neighbors failed: ${resp.status} ${resp.statusText}`);
    }
    return await resp.json() as SharedGraphData;
  }

  /**
   * Build context from the shared vault for a task description.
   */
  async buildContext(task: string, options?: {
    limit?: number;
    budget?: number;
    profile?: string;
    maxHops?: number;
  }): Promise<SharedContextResult> {
    const url = `${this.apiBaseUrl}/v1/memory/vaults/shared/context`;
    const resp = await authFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, ...options }),
    });
    if (!resp.ok) {
      throw new Error(`Shared vault context failed: ${resp.status} ${resp.statusText}`);
    }
    return await resp.json() as SharedContextResult;
  }
}
