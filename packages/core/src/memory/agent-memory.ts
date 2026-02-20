/**
 * AgentMemory - Deep ClawVault integration for persistent memory vaults.
 * 
 * Each agent has its own ClawVault with knowledge graph support:
 * - Wiki-link traversal for context building
 * - Semantic search + BM25 via qmd
 * - Typed memory categories (8 types from ClawVault)
 * - Graph-aware recall with profiles
 * - Handoff system for session continuity
 */

import { 
  ClawVault, 
  createVault, 
  buildContext, 
  getMemoryGraph, 
  type MemoryType, 
  type SearchResult, 
  type ContextResult, 
  type ContextEntry, 
  type MemoryGraph 
} from 'clawvault';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

export interface WakeContext {
  runId: string;
  stepId: string;
  taskDescription: string;
}

export interface HandoffData {
  runId: string;
  stepId: string;
  workingOn: string[];
  decisions: string[];
  nextSteps: string[];
  outputs: Record<string, string>;
}

export interface RecallOptions {
  limit?: number;
  personalOnly?: boolean;
  profile?: 'default' | 'planning' | 'incident' | 'handoff' | 'auto';
  budget?: number;
  maxHops?: number;
}

export interface RecallResult {
  id: string;
  category: string;
  title: string;
  content: string;
  score: number;
  snippet?: string;
  source?: string;
  graphConnections?: string[];
}

export interface GraphQueryResult {
  nodes: Array<{
    id: string;
    title: string;
    type: string;
    category: string;
    degree: number;
    tags: string[];
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
    label?: string;
  }>;
  stats: {
    nodeCount: number;
    edgeCount: number;
    nodeTypeCounts: Record<string, number>;
    edgeTypeCounts: Record<string, number>;
  };
}

/**
 * AgentMemory wraps a ClawVault instance for typed, graph-aware memory operations.
 */
export class AgentMemory {
  private vault: ClawVault | null = null;
  private sharedVault: ClawVault | null = null;
  private agentId: string;
  private vaultPath: string;
  private sharedVaultPath: string | null;

  constructor(agentId: string, vaultPath: string, sharedVaultPath?: string) {
    this.agentId = agentId;
    this.vaultPath = vaultPath;
    this.sharedVaultPath = sharedVaultPath || null;
  }

  async initialize(): Promise<void> {
    // Check if vault already exists
    const configPath = join(this.vaultPath, '.clawvault.json');
    if (existsSync(configPath)) {
      this.vault = new ClawVault(this.vaultPath);
      await this.vault.load();
    } else {
      this.vault = await createVault(this.vaultPath, {
        name: this.agentId,
        qmdCollection: `djinnbot-${this.agentId}`,
      }, {
        skipBases: true, // No Obsidian bases needed
        skipTasks: true,  // DjinnBot has its own task system
      });
    }

    // Ensure qmd collection exists (may not have been created if vault was
    // first created when qmd/sqlite-vec wasn't working, e.g. Alpine builds)
    this.ensureQmdCollection();

    // Generate/update vector embeddings in background (non-blocking)
    this.runQmdEmbed();

    // Build/update the graph index so it's available for the dashboard API
    try {
      await getMemoryGraph(this.vaultPath);
    } catch (err) {
      console.warn(`[AgentMemory:${this.agentId}] Graph index build failed (non-fatal):`, err);
    }

    // Load shared vault if path provided
    if (this.sharedVaultPath) {
      const sharedConfigPath = join(this.sharedVaultPath, '.clawvault.json');
      if (existsSync(sharedConfigPath)) {
        this.sharedVault = new ClawVault(this.sharedVaultPath);
        await this.sharedVault.load();
        // Ensure shared qmd collection exists too
        try {
          execFileSync('qmd', ['collection', 'add', this.sharedVaultPath, '--name', 'djinnbot-shared', '--mask', '**/*.md'], {
            stdio: 'ignore',
            env: { ...process.env, PATH: `/root/.bun/bin:${process.env.PATH}` },
          });
        } catch { /* already exists or qmd unavailable */ }
      }
      // Don't create shared vault here — AgentMemoryManager handles that
    }
  }

  /**
   * Ensure qmd collection exists for this agent's vault.
   * Non-fatal — if qmd isn't available or fails, agent still works (without vector search).
   */
  private ensureQmdCollection(): void {
    const collection = `djinnbot-${this.agentId}`;
    try {
      execFileSync('qmd', ['collection', 'add', this.vaultPath, '--name', collection, '--mask', '**/*.md'], {
        stdio: 'ignore',
        env: { ...process.env, PATH: `/root/.bun/bin:${process.env.PATH}` },
      });
      console.log(`[AgentMemory:${this.agentId}] qmd collection ready: ${collection}`);
    } catch {
      // Collection may already exist, or qmd not available — both are fine
    }
  }

  /**
   * Run qmd embed to generate vector embeddings.
   * Non-blocking — failures are logged but don't affect agent operation.
   */
  private runQmdEmbed(): void {
    const proc = spawn('qmd', ['embed'], {
      stdio: 'ignore',
      env: { ...process.env, PATH: `/root/.bun/bin:${process.env.PATH}` },
      detached: true,
    });
    proc.unref();
  }

  /**
   * Store a typed memory with wiki-link support.
   * Content can include [[wiki-links]] which auto-build graph edges.
   */
  async remember(
    type: MemoryType,
    title: string,
    content: string,
    metadata?: Record<string, unknown> & { shared?: boolean }
  ): Promise<void> {
    if (!this.vault) throw new Error('Vault not initialized');

    const shared = metadata?.shared;
    const cleanMeta = metadata ? { ...metadata } : {};
    delete cleanMeta.shared;
    cleanMeta.agent = this.agentId;
    cleanMeta.timestamp = Date.now();

    // Store in personal vault
    await this.vault.remember(type, title, content, cleanMeta);
    console.log(`[AgentMemory:${this.agentId}] remember(${type}, "${title}", shared=${!!shared}) → personal vault OK`);

    // Incrementally update graph index (only re-parses changed files)
    getMemoryGraph(this.vaultPath).catch(() => {});

    // Schedule embedding update for the new memory
    this.runQmdEmbed();

    // Also store in shared vault if requested
    if (shared) {
      if (!this.sharedVault) {
        console.warn(`[AgentMemory:${this.agentId}] remember("${title}") — shared:true requested but sharedVault is NOT initialized. Memory will only exist in personal vault!`);
      } else {
        try {
          await this.sharedVault.remember(type, title, content, {
            ...cleanMeta,
            sharedBy: this.agentId,
          });
          console.log(`[AgentMemory:${this.agentId}] remember("${title}") → shared vault OK`);
        } catch (err) {
          console.error(`[AgentMemory:${this.agentId}] Failed to write to shared vault:`, err);
        }
      }
    }
  }

  /**
   * Hybrid context retrieval: BM25 keyword search + qmd vector search.
   * Uses qmd CLI for semantic search.
   */
  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult[]> {
    if (!this.vault) return [];

    const { limit = 5, personalOnly = false } = options;
    const results: RecallResult[] = [];

    // 1. BM25 keyword search (fast, reliable)
    try {
      const bm25Results = await this.vault.find(query, { limit });
      for (const r of bm25Results) {
        results.push({
          id: r.document.id,
          category: r.document.category,
          title: r.document.title,
          content: r.document.content,
          score: r.score,
          snippet: r.snippet,
          source: 'personal',
        });
      }
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.includes('non-JSON')) {
        console.warn(`[AgentMemory:${this.agentId}] BM25 search failed:`, msg);
      }
    }

    // 2. Vector search via qmd CLI
    try {
      const collection = `djinnbot-${this.agentId}`;
      const result = execFileSync('qmd', ['vsearch', query, '-c', collection, '-n', String(limit), '--json'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `/root/.bun/bin:${process.env.PATH}` },
        timeout: 30000,
      });
      const trimmed = result.trim();
      const vecResults = (trimmed && trimmed.startsWith('[')) ? JSON.parse(trimmed) : [];
      for (const r of vecResults) {
        // Avoid duplicates
        if (!results.some(existing => existing.id === r.hash)) {
          results.push({
            id: r.hash,
            category: 'memory',
            title: r.title,
            content: r.snippet,
            score: r.score,
            snippet: r.snippet,
            source: 'personal',
          });
        }
      }
    } catch (err) {
      console.warn(`[AgentMemory:${this.agentId}] Vector search failed:`, (err as Error).message);
    }

    // 3. Search shared vault if not personalOnly
    if (!personalOnly && this.sharedVault) {
      try {
        const sharedBm25 = await this.sharedVault.find(query, { limit: Math.ceil(limit / 2) });
        for (const r of sharedBm25) {
          results.push({
            id: `shared/${r.document.id}`,
            category: `shared/${r.document.category}`,
            title: r.document.title,
            content: r.document.content,
            score: r.score * 0.8, // Slight penalty for shared memories
            snippet: r.snippet,
            source: 'shared',
          });
        }
      } catch { /* shared vault may not be available */ }

      // Also try vector search on shared collection
      try {
        const sharedResult = execFileSync('qmd', ['vsearch', query, '-c', 'djinnbot-shared', '-n', String(Math.ceil(limit / 2)), '--json'], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `/root/.bun/bin:${process.env.PATH}` },
          timeout: 30000,
        });
        const sharedTrimmed = sharedResult.trim();
        const sharedVecResults = (sharedTrimmed && sharedTrimmed.startsWith('[')) ? JSON.parse(sharedTrimmed) : [];
        for (const r of sharedVecResults) {
          if (!results.some(existing => existing.id === `shared/${r.hash}`)) {
            results.push({
              id: `shared/${r.hash}`,
              category: 'shared/memory',
              title: r.title,
              content: r.snippet,
              score: r.score * 0.8,
              snippet: r.snippet,
              source: 'shared',
            });
          }
        }
      } catch { /* shared vault may not have vector index */ }
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Query the knowledge graph directly.
   * Returns nodes, edges, stats for visualization or agent graph traversal.
   */
  async queryGraph(options?: { refresh?: boolean }): Promise<GraphQueryResult> {
    if (!this.vault) {
      return { 
        nodes: [], 
        edges: [], 
        stats: { nodeCount: 0, edgeCount: 0, nodeTypeCounts: {}, edgeTypeCounts: {} } 
      };
    }

    try {
      const graph: MemoryGraph = await getMemoryGraph(this.vaultPath, options);
      return {
        nodes: graph.nodes.map(n => ({
          id: n.id,
          title: n.title,
          type: n.type,
          category: n.category,
          degree: n.degree,
          tags: n.tags,
        })),
        edges: graph.edges.map(e => ({
          source: e.source,
          target: e.target,
          type: e.type,
          label: e.label,
        })),
        stats: graph.stats,
      };
    } catch (err) {
      console.error(`[AgentMemory:${this.agentId}] Graph query failed:`, err);
      return { 
        nodes: [], 
        edges: [], 
        stats: { nodeCount: 0, edgeCount: 0, nodeTypeCounts: {}, edgeTypeCounts: {} } 
      };
    }
  }

  /**
   * Get neighbors of a specific node in the graph (1-2 hops).
   */
  async getNeighbors(nodeId: string, maxHops: number = 1): Promise<GraphQueryResult> {
    const fullGraph = await this.queryGraph();
    if (fullGraph.nodes.length === 0) return fullGraph;

    // BFS from nodeId
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];
    visited.add(nodeId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxHops) continue;

      for (const edge of fullGraph.edges) {
        const neighbor = edge.source === current.id ? edge.target : edge.target === current.id ? edge.source : null;
        if (neighbor && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ id: neighbor, depth: current.depth + 1 });
        }
      }
    }

    return {
      nodes: fullGraph.nodes.filter(n => visited.has(n.id)),
      edges: fullGraph.edges.filter(e => visited.has(e.source) && visited.has(e.target)),
      stats: fullGraph.stats,
    };
  }

  /**
   * Fast keyword-only search for lightweight triage (no semantic search).
   * Used for Slack decision pre-fetch where speed matters.
   */
  async quickSearch(query: string, limit: number = 5): Promise<Array<{ title: string; snippet: string; category: string }>> {
    if (!this.vault) return [];

    try {
      const results = await this.vault.find(query, { limit });
      return results.map((r: SearchResult) => ({
        title: r.document.title,
        snippet: r.snippet || r.document.content?.slice(0, 200) || '',
        category: r.document.category,
      }));
    } catch (err) {
      // qmd returns "No results found." as plain text (not JSON) when the
      // collection has no matching documents. ClawVault's parser throws
      // "qmd returned non-JSON output" in that case. This is normal — just
      // means no memories match — so suppress the noise.
      const msg = (err as Error).message ?? '';
      if (!msg.includes('non-JSON')) {
        console.warn(`[AgentMemory:${this.agentId}] quickSearch failed:`, msg);
      }
      return [];
    }
  }

  /**
   * Called when an agent step starts — BM25 + qmd vector search context retrieval.
   * Uses qmd CLI for semantic search.
   */
  async wake(context: WakeContext): Promise<string> {
    if (!this.vault) return '';

    const timeoutMs = 10_000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Agent memory wake() timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    const workPromise = (async () => {
      const vault = this.vault!;
      const sections: string[] = [];

      // 1. BM25 keyword search (fast, reliable)
      try {
        const bm25Results = await vault.find(context.taskDescription, { limit: 5 });
        if (bm25Results.length > 0) {
          sections.push('### Relevant Memories (keyword match)');
          for (const r of bm25Results) {
            sections.push(`- **[${r.document.category}] ${r.document.title}**: ${r.snippet || r.document.content.slice(0, 200)}`);
          }
        }
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (!msg.includes('non-JSON')) {
          console.warn(`[AgentMemory:${this.agentId}] BM25 search failed:`, msg);
        }
      }

      // 2. Vector search via qmd CLI
      try {
        const collection = `djinnbot-${this.agentId}`;
        const result = execFileSync('qmd', ['vsearch', context.taskDescription, '-c', collection, '-n', '5', '--json'], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `/root/.bun/bin:${process.env.PATH}` },
          timeout: 30000,
        });
        const wakeVecTrimmed = result.trim();
        const vecResults = (wakeVecTrimmed && wakeVecTrimmed.startsWith('[')) ? JSON.parse(wakeVecTrimmed) : [];
        if (vecResults.length > 0) {
          sections.push('### Relevant Memories (semantic match)');
          for (const r of vecResults) {
            sections.push(`- **${r.title}** (score: ${r.score.toFixed(2)}): ${r.snippet}`);
          }
        }
      } catch (err) {
        console.warn(`[AgentMemory:${this.agentId}] Vector search failed:`, (err as Error).message);
      }

      // 3. Graph context (non-fatal)
      try {
        const graph = await getMemoryGraph(this.vaultPath);
        if (graph.stats.nodeCount > 0) {
          sections.push(`### Knowledge Graph: ${graph.stats.nodeCount} nodes, ${graph.stats.edgeCount} edges`);
        }
      } catch {}

      if (sections.length === 0) return '';
      return sections.join('\n');
    })();

    return Promise.race([workPromise, timeoutPromise]);
  }

  /**
   * Called when an agent step completes — stores handoff using ClawVault's handoff system.
   */
  async sleep(handoff: HandoffData): Promise<void> {
    if (!this.vault) return;

    try {
      await this.vault.createHandoff({
        sessionKey: `${handoff.runId}/${handoff.stepId}`,
        workingOn: handoff.workingOn,
        blocked: [],
        nextSteps: handoff.nextSteps,
        decisions: handoff.decisions,
        feeling: undefined,
        openQuestions: [],
      });
    } catch (err) {
      console.error(`[AgentMemory:${this.agentId}] Sleep handoff failed:`, err);
    }
  }

  /**
   * Store a quick capture to inbox for later processing.
   */
  async capture(note: string): Promise<void> {
    if (!this.vault) return;
    await this.vault.capture(note);
  }

  /**
   * Link two memories with a typed relationship via frontmatter.
   */
  async linkMemories(fromId: string, toId: string, relationType: 'related' | 'depends_on' | 'blocks'): Promise<void> {
    if (!this.vault) return;

    try {
      const doc = await this.vault.get(fromId);
      if (!doc) return;

      // Update frontmatter to add the link
      const existing = (doc.frontmatter[relationType] as string[] | undefined) || [];
      if (!existing.includes(toId)) {
        existing.push(toId);
        await this.vault.store({
          category: doc.category,
          title: doc.title,
          content: doc.content,
          frontmatter: { ...doc.frontmatter, [relationType]: existing },
          overwrite: true,
        });
      }
    } catch (err) {
      console.error(`[AgentMemory:${this.agentId}] Link failed:`, err);
    }
  }

  /**
   * Get vault stats.
   */
  async getStats(): Promise<{ documents: number; categories: Record<string, number>; links: number; tags: string[] }> {
    if (!this.vault) return { documents: 0, categories: {}, links: 0, tags: [] };
    return this.vault.stats();
  }

  getVaultPath(): string {
    return this.vaultPath;
  }
}

/**
 * AgentMemoryManager manages ClawVault vaults for all agents + shared vault.
 */
export class AgentMemoryManager {
  private vaultsDir: string;
  private memories: Map<string, AgentMemory> = new Map();
  private sharedVault: ClawVault | null = null;

  constructor(vaultsDir: string) {
    this.vaultsDir = vaultsDir;
  }

  async initialize(agentIds: string[]): Promise<void> {
    // Create and initialize shared vault
    const sharedPath = join(this.vaultsDir, 'shared');
    const sharedConfigPath = join(sharedPath, '.clawvault.json');

    if (existsSync(sharedConfigPath)) {
      this.sharedVault = new ClawVault(sharedPath);
      await this.sharedVault.load();
    } else {
      this.sharedVault = await createVault(sharedPath, {
        name: 'shared',
        qmdCollection: 'djinnbot-shared',
      }, { skipBases: true, skipTasks: true });
    }
    console.log(`[AgentMemoryManager] Shared ClawVault initialized at ${sharedPath}`);

    // Initialize per-agent vaults
    for (const agentId of agentIds) {
      const memory = new AgentMemory(agentId, join(this.vaultsDir, agentId), sharedPath);
      await memory.initialize();
      this.memories.set(agentId, memory);
      console.log(`[AgentMemoryManager] Agent vault initialized: ${agentId}`);
    }
  }

  async get(agentId: string): Promise<AgentMemory> {
    let memory = this.memories.get(agentId);
    if (!memory) {
      const sharedPath = join(this.vaultsDir, 'shared');
      memory = new AgentMemory(agentId, join(this.vaultsDir, agentId), sharedPath);
      await memory.initialize();
      this.memories.set(agentId, memory);
    }
    return memory;
  }

  getIds(): string[] {
    return Array.from(this.memories.keys());
  }

  getSharedVaultPath(): string {
    return join(this.vaultsDir, 'shared');
  }

  getVaultsDir(): string {
    return this.vaultsDir;
  }
}
