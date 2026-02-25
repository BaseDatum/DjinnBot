/**
 * ContainerLogStreamer — Streams Docker container logs to Redis streams.
 *
 * Attaches to all containers on the djinnbot network and publishes their
 * stdout/stderr to per-container Redis streams and a merged stream.
 *
 * Design goals:
 *  - Completely isolated from the engine's main Redis connections
 *  - Errors never propagate to container management or run execution
 *  - Auto-discovers new containers (agent-runtime spawns) via Docker events
 *  - Handles container lifecycle (start/stop/die) gracefully
 */

import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { Redis } from 'ioredis';

// Redis stream names
const LOG_STREAM_PREFIX = 'djinnbot:logs:';
const MERGED_LOG_STREAM = 'djinnbot:logs:merged';
const CONTAINER_LIST_KEY = 'djinnbot:logs:containers';

// Stream caps — keep memory bounded
const PER_CONTAINER_MAXLEN = 5000;
const MERGED_MAXLEN = 10000;

// How often to refresh the container list key in Redis (seconds)
const CONTAINER_LIST_TTL = 120;

/** Service type inferred from container name */
type ServiceType = 'api' | 'engine' | 'dashboard' | 'mcpo' | 'postgres' | 'redis' | 'juicefs' | 'rustfs' | 'agent-runtime' | 'unknown';

interface TrackedContainer {
  containerId: string;
  containerName: string;
  serviceType: ServiceType;
  stream: NodeJS.ReadableStream | null;
  logBuffer: string;
  startedAt: number;
}

export interface ContainerLogStreamerConfig {
  redisUrl: string;
  /** Docker network name to filter containers (default: djinnbot_djinnbot_default) */
  networkName?: string;
}

export class ContainerLogStreamer {
  private redis: Redis;
  private docker: Docker;
  private networkName: string;
  private containers = new Map<string, TrackedContainer>();
  private dockerEventStream: NodeJS.ReadableStream | null = null;
  private stopping = false;
  private containerListInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: ContainerLogStreamerConfig) {
    // Dedicated Redis connection — completely independent from engine
    this.redis = new Redis(config.redisUrl, {
      retryStrategy: (times) => Math.min(times * 1000, 30000),
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    this.redis.on('error', (err) => {
      // Non-fatal: log and continue
      if (!this.stopping) {
        console.warn('[LogStreamer] Redis error:', err.message);
      }
    });

    this.docker = new Docker();
    this.networkName = config.networkName ?? 'djinnbot_djinnbot_default';
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    console.log('[LogStreamer] Starting container log streamer');

    await this.redis.connect();

    // Discover existing running containers
    await this.discoverContainers();

    // Monitor Docker events for new/stopped containers
    this.startDockerEventMonitor();

    // Periodically publish container list to Redis
    await this.publishContainerList();
    this.containerListInterval = setInterval(() => {
      this.publishContainerList().catch(() => {});
    }, CONTAINER_LIST_TTL * 1000);

    console.log(`[LogStreamer] Tracking ${this.containers.size} container(s)`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    console.log('[LogStreamer] Stopping');

    if (this.containerListInterval) {
      clearInterval(this.containerListInterval);
      this.containerListInterval = null;
    }

    // Destroy all log streams
    for (const [, tracked] of this.containers) {
      if (tracked.stream) {
        try {
          (tracked.stream as any).destroy?.();
        } catch {
          // Ignore
        }
      }
    }
    this.containers.clear();

    // Close Docker event stream
    if (this.dockerEventStream) {
      try {
        (this.dockerEventStream as any).destroy?.();
      } catch {
        // Ignore
      }
      this.dockerEventStream = null;
    }

    // Close Redis
    await this.redis.quit().catch(() => {});
    console.log('[LogStreamer] Stopped');
  }

  // ─── Container discovery ──────────────────────────────────────────────────

  private async discoverContainers(): Promise<void> {
    try {
      const containers = await this.docker.listContainers({ all: false });

      for (const info of containers) {
        const name = (info.Names?.[0] ?? '').replace(/^\//, '');
        if (!name) continue;

        // Check if this container is on our network
        const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
        const onOurNetwork = networks.some(n => n === this.networkName);

        // Also include djinn-run-* containers (agent-runtime) which are always ours
        const isAgentRuntime = name.startsWith('djinn-run-');

        if (!onOurNetwork && !isAgentRuntime) continue;

        // Skip if already tracked
        if (this.containers.has(name)) continue;

        this.attachToContainer(name, info.Id);
      }
    } catch (err) {
      console.warn('[LogStreamer] Container discovery failed:', (err as Error).message);
    }
  }

  // ─── Docker event monitoring ──────────────────────────────────────────────

  private startDockerEventMonitor(): void {
    this.docker.getEvents({ filters: { type: ['container'] } }, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err) {
        console.warn('[LogStreamer] Docker events unavailable:', err.message);
        // Retry after a delay
        if (!this.stopping) {
          setTimeout(() => this.startDockerEventMonitor(), 15_000);
        }
        return;
      }

      if (!stream) return;
      this.dockerEventStream = stream;

      let buffer = '';

      stream.on('data', (chunk: Buffer) => {
        if (this.stopping) return;
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          this.handleDockerEvent(event);
        }
      });

      stream.on('error', (e: Error) => {
        if (!this.stopping) {
          console.warn('[LogStreamer] Docker event stream error:', e.message);
          setTimeout(() => this.startDockerEventMonitor(), 10_000);
        }
      });

      stream.on('end', () => {
        if (!this.stopping) {
          console.warn('[LogStreamer] Docker event stream ended, reconnecting');
          setTimeout(() => this.startDockerEventMonitor(), 5_000);
        }
      });
    });
  }

  private handleDockerEvent(event: any): void {
    if (event.Type !== 'container') return;
    const name = event.Actor?.Attributes?.name;
    if (!name) return;

    if (event.Action === 'start') {
      // New container started — check if it's one of ours
      const isOurs = name.startsWith('djinnbot-') || name.startsWith('djinn-run-');
      if (isOurs && !this.containers.has(name)) {
        const containerId = event.Actor?.ID || event.id;
        // Small delay to let the container fully start
        setTimeout(() => {
          if (!this.stopping && !this.containers.has(name)) {
            this.attachToContainer(name, containerId);
            this.publishContainerList().catch(() => {});
          }
        }, 1000);
      }
    } else if (['die', 'stop', 'kill'].includes(event.Action)) {
      // Container stopped
      const tracked = this.containers.get(name);
      if (tracked) {
        this.detachFromContainer(name);
        this.publishContainerList().catch(() => {});
      }
    }
  }

  // ─── Log attachment ───────────────────────────────────────────────────────

  private attachToContainer(containerName: string, containerId: string): void {
    const serviceType = this.inferServiceType(containerName);
    const tracked: TrackedContainer = {
      containerId,
      containerName,
      serviceType,
      stream: null,
      logBuffer: '',
      startedAt: Date.now(),
    };
    this.containers.set(containerName, tracked);

    const container = this.docker.getContainer(containerId);

    container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: 100,
    })
      .then((stream: NodeJS.ReadableStream) => {
        if (this.stopping || !this.containers.has(containerName)) {
          (stream as any).destroy?.();
          return;
        }

        tracked.stream = stream;

        // Docker multiplexes stdout/stderr in 8-byte framed format
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        this.docker.modem.demuxStream(stream, stdout, stderr);

        const onChunk = (chunk: Buffer, level: string) => {
          this.handleLogChunk(tracked, chunk.toString(), level);
        };

        stdout.on('data', (chunk: Buffer) => onChunk(chunk, 'info'));
        stderr.on('data', (chunk: Buffer) => onChunk(chunk, 'error'));

        stream.on('end', () => {
          if (!this.stopping && this.containers.has(containerName)) {
            // Container might still be running, retry
            tracked.stream = null;
            setTimeout(() => {
              if (!this.stopping && this.containers.has(containerName)) {
                this.reattachToContainer(containerName);
              }
            }, 5_000);
          }
        });

        stream.on('error', (e: Error) => {
          if (!this.stopping) {
            tracked.stream = null;
          }
        });
      })
      .catch((err: Error) => {
        // Container not ready yet or gone
        if (!this.stopping) {
          // Retry once after a delay
          setTimeout(() => {
            if (!this.stopping && this.containers.has(containerName)) {
              this.reattachToContainer(containerName);
            }
          }, 5_000);
        }
      });
  }

  private reattachToContainer(containerName: string): void {
    const tracked = this.containers.get(containerName);
    if (!tracked) return;

    // Destroy existing stream
    if (tracked.stream) {
      try {
        (tracked.stream as any).destroy?.();
      } catch {
        // Ignore
      }
      tracked.stream = null;
    }

    this.attachToContainer(containerName, tracked.containerId);
  }

  private detachFromContainer(containerName: string): void {
    const tracked = this.containers.get(containerName);
    if (!tracked) return;

    if (tracked.stream) {
      try {
        (tracked.stream as any).destroy?.();
      } catch {
        // Ignore
      }
    }

    this.containers.delete(containerName);
  }

  // ─── Log processing ───────────────────────────────────────────────────────

  private handleLogChunk(tracked: TrackedContainer, chunk: string, defaultLevel: string): void {
    tracked.logBuffer += chunk;
    const lines = tracked.logBuffer.split('\n');
    tracked.logBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      // Detect log level from content
      const level = this.detectLevel(line, defaultLevel);

      this.publishLog(tracked.containerName, tracked.serviceType, line, level).catch(() => {});
    }
  }

  private detectLevel(line: string, defaultLevel: string): string {
    if (/\b(error|exception|traceback|critical|fatal)\b/i.test(line)) return 'error';
    if (/\b(warn|warning)\b/i.test(line)) return 'warn';
    if (/\b(debug)\b/i.test(line)) return 'debug';
    return defaultLevel;
  }

  private async publishLog(
    containerName: string,
    serviceType: string,
    line: string,
    level: string,
  ): Promise<void> {
    if (this.stopping) return;

    const ts = new Date().toISOString();
    const fields = ['line', line, 'level', level, 'ts', ts, 'container', containerName, 'service', serviceType];

    try {
      // Publish to per-container stream
      const containerStream = `${LOG_STREAM_PREFIX}${containerName}`;
      await this.redis.xadd(
        containerStream,
        'MAXLEN', '~', String(PER_CONTAINER_MAXLEN),
        '*',
        ...fields,
      );

      // Publish to merged stream
      await this.redis.xadd(
        MERGED_LOG_STREAM,
        'MAXLEN', '~', String(MERGED_MAXLEN),
        '*',
        ...fields,
      );
    } catch {
      // Non-fatal — Redis might be temporarily unavailable
    }
  }

  // ─── Container list management ────────────────────────────────────────────

  private async publishContainerList(): Promise<void> {
    if (this.stopping) return;

    try {
      const containerInfos = Array.from(this.containers.values()).map(c => ({
        name: c.containerName,
        serviceType: c.serviceType,
        streaming: c.stream !== null,
        startedAt: c.startedAt,
      }));

      await this.redis.setex(
        CONTAINER_LIST_KEY,
        CONTAINER_LIST_TTL + 30, // Extra TTL margin
        JSON.stringify(containerInfos),
      );
    } catch {
      // Non-fatal
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private inferServiceType(name: string): ServiceType {
    if (name.includes('api') && name.startsWith('djinnbot-')) return 'api';
    if (name.includes('engine') && name.startsWith('djinnbot-')) return 'engine';
    if (name.includes('dashboard') && name.startsWith('djinnbot-')) return 'dashboard';
    if (name.includes('mcpo') && name.startsWith('djinnbot-')) return 'mcpo';
    if (name.includes('postgres') && name.startsWith('djinnbot-')) return 'postgres';
    if (name.includes('redis') && name.startsWith('djinnbot-')) return 'redis';
    if (name.includes('juicefs') && name.startsWith('djinnbot-')) return 'juicefs';
    if (name.includes('rustfs') && name.startsWith('djinnbot-')) return 'rustfs';
    if (name.startsWith('djinn-run-')) return 'agent-runtime';
    return 'unknown';
  }
}
