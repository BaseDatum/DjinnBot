/**
 * KuzuDB Storage Adapter — persists the knowledge graph to disk.
 *
 * KuzuDB is an embedded graph database. Each project gets its own
 * database directory at {workspace}/.code-graph/
 */

import { mkdirSync } from 'node:fs';
import type { KnowledgeGraph, GraphNode, NodeLabel } from '../types/index.js';

// KuzuDB loaded dynamically
let kuzuModule: any = null;

async function ensureKuzu(): Promise<any> {
  if (!kuzuModule) {
    const mod = await import('kuzu');
    kuzuModule = (mod as any).default ?? mod;
  }
  return kuzuModule;
}

const NODE_TABLES: NodeLabel[] = [
  'File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement',
  'Community', 'Process', 'Struct', 'Enum', 'Trait', 'Impl', 'Namespace',
  'TypeAlias', 'Constructor',
];

export interface KuzuStore {
  init(): Promise<void>;
  reset(): Promise<void>;
  loadGraph(graph: KnowledgeGraph): Promise<void>;
  query(cypher: string): Promise<any[]>;
  getStats(): Promise<{ nodeCount: number; relationshipCount: number }>;
  close(): void;
}

export async function createKuzuStore(dbPath: string): Promise<KuzuStore> {
  const kuzu = await ensureKuzu();
  mkdirSync(dbPath, { recursive: true });

  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  let schemaReady = false;

  async function exec(cypher: string): Promise<any> {
    return conn.query(cypher);
  }

  async function rows(cypher: string): Promise<any[]> {
    const result = await conn.query(cypher);
    if (result.getAll) return result.getAll();
    const out: any[] = [];
    while (result.hasNext()) out.push(result.getNext());
    return out;
  }

  function nodeSQL(label: NodeLabel): string {
    if (label === 'File' || label === 'Folder') {
      return `CREATE NODE TABLE \`${label}\` (id STRING, name STRING, filePath STRING, PRIMARY KEY (id))`;
    }
    if (label === 'Community') {
      return `CREATE NODE TABLE Community (id STRING, name STRING, heuristicLabel STRING, cohesion DOUBLE, symbolCount INT32, PRIMARY KEY (id))`;
    }
    if (label === 'Process') {
      return `CREATE NODE TABLE Process (id STRING, name STRING, heuristicLabel STRING, processType STRING, stepCount INT32, communities STRING[], entryPointId STRING, terminalId STRING, PRIMARY KEY (id))`;
    }
    return `CREATE NODE TABLE \`${label}\` (id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, isExported BOOLEAN, content STRING, language STRING, PRIMARY KEY (id))`;
  }

  function relSQL(): string {
    const pairs = NODE_TABLES.flatMap(from =>
      NODE_TABLES.map(to => `FROM \`${from}\` TO \`${to}\``)
    );
    return `CREATE REL TABLE CodeRelation (${pairs.join(', ')}, type STRING, confidence DOUBLE, reason STRING, step INT32)`;
  }

  async function createSchema(): Promise<void> {
    for (const label of NODE_TABLES) {
      await exec(nodeSQL(label));
    }
    await exec(relSQL());
    schemaReady = true;
  }

  async function dropAll(): Promise<void> {
    try { await exec('DROP TABLE CodeRelation'); } catch { /* ok */ }
    for (const label of [...NODE_TABLES].reverse()) {
      try { await exec(`DROP TABLE \`${label}\``); } catch { /* ok */ }
    }
    schemaReady = false;
  }

  const store: KuzuStore = {
    async init() {
      if (schemaReady) return;
      try {
        await rows('MATCH (n:File) RETURN count(n) AS c');
        schemaReady = true;
      } catch {
        await createSchema();
      }
    },

    async reset() {
      await dropAll();
      await createSchema();
    },

    async loadGraph(graph: KnowledgeGraph) {
      await store.reset();

      // Group nodes by label
      const byLabel = new Map<NodeLabel, GraphNode[]>();
      graph.forEachNode(node => {
        const group = byLabel.get(node.label) || [];
        group.push(node);
        byLabel.set(node.label, group);
      });

      for (const [label, nodes] of byLabel) {
        for (const node of nodes) {
          const p = node.properties;
          try {
            if (label === 'File' || label === 'Folder') {
              await exec(`CREATE (:\`${label}\` {id: ${esc(node.id)}, name: ${esc(p.name)}, filePath: ${esc(p.filePath)}})`);
            } else if (label === 'Community') {
              await exec(`CREATE (:Community {id: ${esc(node.id)}, name: ${esc(p.name)}, heuristicLabel: ${esc(p.heuristicLabel ?? '')}, cohesion: ${p.cohesion ?? 0}, symbolCount: ${p.symbolCount ?? 0}})`);
            } else if (label === 'Process') {
              const comms = p.communities ? `[${p.communities.map(c => esc(c)).join(',')}]` : '[]';
              await exec(`CREATE (:Process {id: ${esc(node.id)}, name: ${esc(p.name)}, heuristicLabel: ${esc(p.heuristicLabel ?? '')}, processType: ${esc(p.processType ?? '')}, stepCount: ${p.stepCount ?? 0}, communities: ${comms}, entryPointId: ${esc(p.entryPointId ?? '')}, terminalId: ${esc(p.terminalId ?? '')}})`);
            } else {
              await exec(`CREATE (:\`${label}\` {id: ${esc(node.id)}, name: ${esc(p.name)}, filePath: ${esc(p.filePath)}, startLine: ${p.startLine ?? 0}, endLine: ${p.endLine ?? 0}, isExported: ${p.isExported ?? false}, content: ${esc((p.content ?? '').slice(0, 500))}, language: ${esc(p.language ?? '')}})`);
            }
          } catch (err) {
            // Skip nodes that fail to insert
          }
        }
      }

      // Insert relationships
      for (const rel of graph.getRelationships()) {
        const src = graph.getNode(rel.sourceId);
        const tgt = graph.getNode(rel.targetId);
        if (!src || !tgt) continue;
        try {
          await exec(`MATCH (a:\`${src.label}\` {id: ${esc(rel.sourceId)}}), (b:\`${tgt.label}\` {id: ${esc(rel.targetId)}}) CREATE (a)-[:CodeRelation {type: ${esc(rel.type)}, confidence: ${rel.confidence}, reason: ${esc(rel.reason)}, step: ${rel.step ?? 0}}]->(b)`);
        } catch {
          // Some FROM/TO combos may not exist in schema
        }
      }
    },

    async query(cypher: string) {
      return rows(cypher);
    },

    async getStats() {
      let nodeCount = 0;
      let relCount = 0;

      for (const label of NODE_TABLES) {
        try {
          const r = await rows(`MATCH (n:\`${label}\`) RETURN count(n) AS c`);
          if (r.length > 0) nodeCount += Number(r[0]?.c ?? r[0]?.[0] ?? 0);
        } catch { /* ok */ }
      }

      try {
        const r = await rows(`MATCH ()-[r:CodeRelation]->() RETURN count(r) AS c`);
        if (r.length > 0) relCount = Number(r[0]?.c ?? r[0]?.[0] ?? 0);
      } catch { /* ok */ }

      return { nodeCount, relationshipCount: relCount };
    },

    close() {
      try { conn.close?.(); db.close?.(); } catch { /* ok */ }
    },
  };

  return store;
}

function esc(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}
