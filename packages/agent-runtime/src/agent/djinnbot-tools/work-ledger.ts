import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { RedisClient } from '../../redis/client.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const AcquireWorkLockSchema = Type.Object({
  key: Type.String({
    description:
      'Unique identifier for the work item. Use task IDs (e.g., "task:T-42"), ' +
      'topic strings (e.g., "research:auth-libs"), or any freeform key. ' +
      'Must be unique across all instances of this agent.',
  }),
  description: Type.String({
    description: 'Human-readable description of what you are working on',
  }),
  ttlSeconds: Type.Optional(
    Type.Number({
      description: 'Lock TTL in seconds (default 3600 = 1 hour). Lock auto-expires if session crashes.',
      default: 3600,
    })
  ),
});
type AcquireWorkLockParams = Static<typeof AcquireWorkLockSchema>;

const ReleaseWorkLockSchema = Type.Object({
  key: Type.String({ description: 'Work lock key to release (same key used in acquire_work_lock)' }),
});
type ReleaseWorkLockParams = Static<typeof ReleaseWorkLockSchema>;

const GetActiveWorkSchema = Type.Object({});

// ── Types ──────────────────────────────────────────────────────────────────

interface VoidDetails {}

interface WorkLockEntry {
  sessionId: string;
  agentId: string;
  description: string;
  acquiredAt: number;
  ttlSeconds: number;
}

export interface WorkLedgerToolsConfig {
  redis: RedisClient;
  agentId: string;
  sessionId: string;
}

// ── Redis key helpers ──────────────────────────────────────────────────────

function lockKey(agentId: string, key: string): string {
  return `djinnbot:agent:${agentId}:work_lock:${key}`;
}

function ledgerSetKey(agentId: string): string {
  return `djinnbot:agent:${agentId}:work_ledger`;
}

// ── Tool factories ─────────────────────────────────────────────────────────

export function createWorkLedgerTools(config: WorkLedgerToolsConfig): AgentTool[] {
  const { redis, agentId, sessionId } = config;

  return [
    {
      name: 'acquire_work_lock',
      description:
        'Acquire an exclusive lock on a work item so no other instance of yourself picks it up. ' +
        'Call this BEFORE starting work on any task. If the lock is already held by another instance, ' +
        'you will be told who holds it and what they are doing — pick something else instead. ' +
        'Locks auto-expire after TTL seconds (default 1 hour) to prevent orphans from crashed sessions.',
      label: 'acquire_work_lock',
      parameters: AcquireWorkLockSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as AcquireWorkLockParams;
        const ttl = p.ttlSeconds ?? 3600;
        const lk = lockKey(agentId, p.key);
        const ledger = ledgerSetKey(agentId);

        const entry: WorkLockEntry = {
          sessionId,
          agentId,
          description: p.description,
          acquiredAt: Date.now(),
          ttlSeconds: ttl,
        };

        // Atomic SET NX EX — only succeeds if key doesn't exist
        const result = await redis.set(lk, JSON.stringify(entry), 'EX', ttl, 'NX');

        if (result === 'OK') {
          // Also track in the ledger set (for get_active_work queries)
          await redis.sadd(ledger, p.key);
          return {
            content: [{
              type: 'text',
              text: `Work lock acquired: "${p.key}" — you have exclusive ownership for ${ttl}s.\n\nDescription: ${p.description}`,
            }],
            details: {},
          };
        }

        // Lock held by someone else — read who
        const existingRaw = await redis.get(lk);
        let holderInfo = 'another instance';
        if (existingRaw) {
          try {
            const existing: WorkLockEntry = JSON.parse(existingRaw);
            const ageMinutes = Math.round((Date.now() - existing.acquiredAt) / 60000);
            const remainingMinutes = Math.round(existing.ttlSeconds / 60 - ageMinutes);
            holderInfo =
              `session ${existing.sessionId} — "${existing.description}" ` +
              `(locked ${ageMinutes}m ago, expires in ~${Math.max(0, remainingMinutes)}m)`;
          } catch { /* fallback to generic */ }
        }

        return {
          content: [{
            type: 'text',
            text:
              `Work lock DENIED: "${p.key}" is already held by ${holderInfo}.\n\n` +
              `Pick a different task or wait for the lock to expire.`,
          }],
          details: {},
        };
      },
    },

    {
      name: 'release_work_lock',
      description:
        'Release a work lock you previously acquired. Call this when you finish a task ' +
        'or decide not to proceed. Only the session that acquired the lock can release it.',
      label: 'release_work_lock',
      parameters: ReleaseWorkLockSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const p = params as ReleaseWorkLockParams;
        const lk = lockKey(agentId, p.key);
        const ledger = ledgerSetKey(agentId);

        // Verify we own the lock before deleting
        const existingRaw = await redis.get(lk);
        if (!existingRaw) {
          await redis.srem(ledger, p.key);
          return {
            content: [{ type: 'text', text: `Lock "${p.key}" was already expired or released.` }],
            details: {},
          };
        }

        try {
          const existing: WorkLockEntry = JSON.parse(existingRaw);
          if (existing.sessionId !== sessionId) {
            return {
              content: [{
                type: 'text',
                text: `Cannot release lock "${p.key}" — it is held by session ${existing.sessionId}, not yours.`,
              }],
              details: {},
            };
          }
        } catch { /* proceed with delete if parse fails */ }

        await redis.del(lk);
        await redis.srem(ledger, p.key);

        return {
          content: [{ type: 'text', text: `Work lock released: "${p.key}"` }],
          details: {},
        };
      },
    },

    {
      name: 'get_active_work',
      description:
        'See what all parallel instances of yourself are currently working on. ' +
        'Call this at the START of every pulse session before picking up new work, ' +
        'so you avoid duplicating effort with your other running instances.',
      label: 'get_active_work',
      parameters: GetActiveWorkSchema,
      execute: async (
        _toolCallId: string,
        _params: unknown,
        _signal?: AbortSignal,
        _onUpdate?: AgentToolUpdateCallback<VoidDetails>
      ): Promise<AgentToolResult<VoidDetails>> => {
        const ledger = ledgerSetKey(agentId);
        const keys = await redis.smembers(ledger);

        if (keys.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No active work locks. You are free to pick up any available task.',
            }],
            details: {},
          };
        }

        // Fetch all lock entries in parallel
        const pipeline = redis.pipeline();
        for (const key of keys) {
          pipeline.get(lockKey(agentId, key));
        }
        const results = await pipeline.exec();

        const lines: string[] = ['**Active work across all your instances:**\n'];
        let activeCount = 0;
        const expiredKeys: string[] = [];

        for (let i = 0; i < keys.length; i++) {
          const raw = results?.[i]?.[1] as string | null;
          if (!raw) {
            // Lock expired but key still in set — clean up
            expiredKeys.push(keys[i]);
            continue;
          }

          try {
            const entry: WorkLockEntry = JSON.parse(raw);
            const ageMinutes = Math.round((Date.now() - entry.acquiredAt) / 60000);
            const isMe = entry.sessionId === sessionId;
            activeCount++;
            lines.push(
              `- **${keys[i]}**${isMe ? ' (this session)' : ''}\n` +
              `  Session: ${entry.sessionId}\n` +
              `  Task: ${entry.description}\n` +
              `  Locked: ${ageMinutes}m ago`
            );
          } catch {
            expiredKeys.push(keys[i]);
          }
        }

        // Clean up expired entries
        if (expiredKeys.length > 0) {
          await redis.srem(ledger, ...expiredKeys);
        }

        if (activeCount === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No active work locks. You are free to pick up any available task.',
            }],
            details: {},
          };
        }

        lines.push(`\n**${activeCount} active lock(s).** Avoid working on the same items.`);

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: {},
        };
      },
    },
  ];
}
