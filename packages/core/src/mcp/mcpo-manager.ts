/**
 * MCP Manager — Engine-side orchestration for the mcpo proxy container.
 *
 * Responsibilities:
 *  1. Write /data/mcp/config.json from the API server's MCP registry
 *  2. Stream mcpo container logs to the Redis stream djinnbot:mcp:logs
 *  3. Poll mcpo health after a config write and update server statuses
 *  4. Listen for MCP_RESTART_REQUESTED global events and act on them
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import type { Redis as RedisType } from 'ioredis';

const MCP_LOG_STREAM = 'djinnbot:mcp:logs';
const LOG_STREAM_MAXLEN = 2000; // rolling window

export interface McpoManagerOptions {
  redis: RedisType;
  apiBaseUrl: string;
  dataDir: string;
  mcpoApiKey: string;
  /** e.g. "djinnbot-mcpo" */
  mcpoContainerName: string;
  mcpoBaseUrl: string;
}

export class McpoManager {
  private redis: RedisType;
  private apiBaseUrl: string;
  private configPath: string;
  private mcpoApiKey: string;
  private mcpoContainerName: string;
  private mcpoBaseUrl: string;

  private docker: Docker;
  private logStream: NodeJS.ReadableStream | null = null;
  private fileWatcher: ReturnType<typeof watch> | null = null;
  private fileWatchDebounce: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private restartInProgress = false;

  constructor(opts: McpoManagerOptions) {
    this.redis = opts.redis;
    this.apiBaseUrl = opts.apiBaseUrl;
    this.configPath = join(opts.dataDir, 'mcp', 'config.json');
    this.mcpoApiKey = opts.mcpoApiKey;
    this.mcpoContainerName = opts.mcpoContainerName;
    this.mcpoBaseUrl = opts.mcpoBaseUrl;
    this.docker = new Docker();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    console.log('[McpoManager] Starting');
    // Ensure the mcp directory exists
    await mkdir(join(this.configPath, '..'), { recursive: true });

    // Do an initial config write + health poll on startup
    await this.writeConfigAndReload();

    // Watch config.json for direct edits — sync any new/changed servers into DB
    this.startFileWatcher();

    // Start streaming mcpo logs
    this.startLogTail();
  }

  stop(): void {
    this.stopping = true;
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (this.fileWatchDebounce) {
      clearTimeout(this.fileWatchDebounce);
    }
    if (this.logStream) {
      (this.logStream as any).destroy?.();
      this.logStream = null;
    }
    // Close dedicated Redis connection
    this.redis.disconnect();
  }

  /** Called when the engine receives MCP_RESTART_REQUESTED global event. */
  async handleRestartRequest(): Promise<void> {
    if (this.restartInProgress) {
      console.log('[McpoManager] Restart already in progress, skipping duplicate request');
      return;
    }
    console.log('[McpoManager] Handling MCP restart request');
    await this.writeConfigAndReload();
  }

  // ─── Config write ──────────────────────────────────────────────────────────

  private async fetchMcpConfig(): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(`${this.apiBaseUrl}/v1/mcp/config.json`);
      if (!res.ok) {
        console.warn(`[McpoManager] Could not fetch MCP config (${res.status})`);
        return { mcpServers: {} };
      }
      return await res.json() as Record<string, unknown>;
    } catch (err) {
      console.warn('[McpoManager] Failed to fetch MCP config:', err);
      return { mcpServers: {} };
    }
  }

  private async writeConfigAndReload(): Promise<void> {
    this.restartInProgress = true;
    try {
      // 1. Fetch config from API
      const config = await this.fetchMcpConfig();
      const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};
      const serverCount = Object.keys(mcpServers).length;

      // Only write the file when the DB actually has servers to configure.
      // If the DB is empty (e.g. on first boot before anything is registered),
      // leave the existing config.json untouched so hand-crafted or previously
      // written configs are preserved.
      if (serverCount === 0) {
        console.log('[McpoManager] DB has no MCP servers — leaving existing config.json untouched');
        // Still poll health so we reflect whatever mcpo already has running.
        await this.pollHealthFromExistingConfig();
        return;
      }

      const configJson = JSON.stringify(config, null, 2);
      await writeFile(this.configPath, configJson, 'utf8');
      console.log(
        `[McpoManager] Wrote config.json with ${serverCount} server(s) to ${this.configPath}`
      );

      await this.publishLog(
        `Config updated: ${serverCount} server(s). mcpo hot-reload in progress...`,
        'info'
      );

      // 2. Poll health and update per-server status in DB.
      await this.pollHealthAndUpdateStatuses(mcpServers);
    } finally {
      this.restartInProgress = false;
    }
  }

  /**
   * Called on startup when the DB has no servers.
   * Reads the existing config.json from disk, imports any servers it finds into
   * the DB, then polls health so statuses and discovered tools are up to date.
   */
  private async pollHealthFromExistingConfig(): Promise<void> {
    if (!existsSync(this.configPath)) {
      console.log('[McpoManager] No existing config.json found, nothing to import');
      return;
    }
    try {
      const raw = await readFile(this.configPath, 'utf8');
      const config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const mcpServers = config.mcpServers ?? {};
      const serverCount = Object.keys(mcpServers).length;
      if (serverCount === 0) {
        console.log('[McpoManager] Existing config.json has no servers, nothing to import');
        return;
      }
      console.log(`[McpoManager] Importing ${serverCount} server(s) from config.json into DB`);
      await this.importConfigFileToDB(mcpServers);
      await this.pollHealthAndUpdateStatuses(mcpServers);
    } catch (err) {
      console.warn('[McpoManager] Failed to read existing config.json:', err);
    }
  }

  /**
   * Import mcpServers entries from config.json into the DB.
   * Uses upsert semantics: creates missing servers, updates config of existing ones.
   */
  private async importConfigFileToDB(
    mcpServers: Record<string, unknown>
  ): Promise<void> {
    for (const [serverId, serverConfig] of Object.entries(mcpServers)) {
      try {
        // Try to GET first — if it exists, update the config; if not, create it.
        const getRes = await fetch(`${this.apiBaseUrl}/v1/mcp/${serverId}`);
        if (getRes.ok) {
          // Server already in DB — update config in case it drifted
          await fetch(`${this.apiBaseUrl}/v1/mcp/${serverId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: serverConfig }),
          });
          console.log(`[McpoManager] Updated existing server in DB: ${serverId}`);
        } else if (getRes.status === 404) {
          // Not in DB yet — create it
          const name = serverId
            .split('-')
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
          await fetch(`${this.apiBaseUrl}/v1/mcp/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name,
              description: `Imported from config.json`,
              config: serverConfig,
              enabled: true,
            }),
          });
          console.log(`[McpoManager] Imported server into DB: ${serverId}`);
        }
      } catch (err) {
        console.warn(`[McpoManager] Failed to import server '${serverId}':`, err);
      }
    }
  }

  /**
   * Watch config.json for direct edits.
   * When the file changes externally (user edits it), sync the new server list
   * into the DB and poll health.
   * Debounced to avoid reacting to rapid inotify bursts from mcpo's own watcher.
   */
  private startFileWatcher(): void {
    if (!existsSync(this.configPath)) {
      // File doesn't exist yet — watch the directory instead and retry when it appears
      const dir = join(this.configPath, '..');
      try {
        const dirWatcher = watch(dir, (event, filename) => {
          if (filename === 'config.json' && existsSync(this.configPath)) {
            dirWatcher.close();
            this.startFileWatcher();
          }
        });
      } catch {
        // Directory doesn't exist either — not a problem
      }
      return;
    }

    try {
      this.fileWatcher = watch(this.configPath, () => {
        // Debounce: mcpo + the OS fire multiple events per save
        if (this.fileWatchDebounce) clearTimeout(this.fileWatchDebounce);
        this.fileWatchDebounce = setTimeout(() => {
          this.handleConfigFileChanged().catch(err =>
            console.warn('[McpoManager] Error handling config.json change:', err)
          );
        }, 1500);
      });
      console.log(`[McpoManager] Watching config.json for changes: ${this.configPath}`);
    } catch (err) {
      console.warn('[McpoManager] Could not watch config.json:', err);
    }
  }

  /**
   * Called when config.json changes on disk.
   * Only syncs servers that are new or have changed config — does not delete
   * DB records for servers removed from the file (that's a UI action).
   */
  private async handleConfigFileChanged(): Promise<void> {
    if (this.restartInProgress || this.stopping) return;

    try {
      const raw = await readFile(this.configPath, 'utf8');
      const config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const mcpServers = config.mcpServers ?? {};
      const serverCount = Object.keys(mcpServers).length;

      if (serverCount === 0) return;

      console.log(`[McpoManager] config.json changed — syncing ${serverCount} server(s) to DB`);
      await this.publishLog(`config.json changed: syncing ${serverCount} server(s)...`, 'info');
      await this.importConfigFileToDB(mcpServers);
      await this.pollHealthAndUpdateStatuses(mcpServers);
    } catch (err) {
      console.warn('[McpoManager] Failed to process config.json change:', err);
    }
  }

  // ─── Health polling ────────────────────────────────────────────────────────

  private async pollHealthAndUpdateStatuses(
    mcpServers: Record<string, unknown>
  ): Promise<void> {
    const maxWaitMs = 30_000;
    const intervalMs = 2_000;
    const deadline = Date.now() + maxWaitMs;

    console.log('[McpoManager] Polling mcpo health...');
    await this.publishLog('Polling mcpo health...', 'info');

    // Wait for mcpo to respond on any known server endpoint
    let mcpoUp = false;
    while (Date.now() < deadline) {
      mcpoUp = await this.checkMcpoRoot(mcpServers);
      if (mcpoUp) break;
      await sleep(intervalMs);
    }

    if (!mcpoUp) {
      console.warn('[McpoManager] mcpo did not become healthy within timeout');
      await this.publishLog('mcpo health check timed out', 'warn');
      // Mark all as error
      for (const serverId of Object.keys(mcpServers)) {
        await this.patchServerStatus(serverId, 'error');
      }
      return;
    }

    await this.publishLog('mcpo is up. Checking individual servers...', 'info');

    // Check each server's sub-path and discover tools
    for (const serverId of Object.keys(mcpServers)) {
      await this.checkServerAndDiscoverTools(serverId);
    }
  }

  private async checkMcpoRoot(mcpServers?: Record<string, unknown>): Promise<boolean> {
    // mcpo has no root route (returns 404) — probe the first configured server's
    // openapi.json instead, or fall back to checking the /docs route.
    const probePaths: string[] = [];
    if (mcpServers) {
      const firstId = Object.keys(mcpServers)[0];
      if (firstId) probePaths.push(`/${firstId}/openapi.json`);
    }
    probePaths.push('/docs');

    for (const path of probePaths) {
      try {
        const res = await fetch(`${this.mcpoBaseUrl}${path}`, {
          headers: { Authorization: `Bearer ${this.mcpoApiKey}` },
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok || res.status === 401 || res.status === 403) return true;
      } catch {
        // try next
      }
    }
    return false;
  }

  private async checkServerAndDiscoverTools(serverId: string): Promise<void> {
    const serverUrl = `${this.mcpoBaseUrl}/${serverId}`;
    try {
      // Try the OpenAPI schema endpoint
      const res = await fetch(`${serverUrl}/openapi.json`, {
        headers: { Authorization: `Bearer ${this.mcpoApiKey}` },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        console.warn(`[McpoManager] Server '${serverId}' returned ${res.status}`);
        await this.publishLog(`Server '${serverId}': HTTP ${res.status}`, 'warn');
        await this.patchServerStatus(serverId, 'error');
        return;
      }

      const schema = await res.json() as {
        paths?: Record<string, unknown>;
      };

      // Extract tool names from paths — each POST path is a tool call
      const tools: string[] = [];
      for (const path of Object.keys(schema.paths ?? {})) {
        // Strip leading slash and server prefix to get tool name
        const clean = path.replace(/^\//, '');
        if (clean && clean !== '') tools.push(clean);
      }

      await this.patchServerStatus(serverId, 'running');
      await this.patchServerTools(serverId, tools);
      await this.publishLog(
        `Server '${serverId}': running (${tools.length} tools)`,
        'info'
      );
      console.log(
        `[McpoManager] Server '${serverId}': running, tools: [${tools.join(', ')}]`
      );
    } catch (err: unknown) {
      console.warn(`[McpoManager] Server '${serverId}' check failed:`, err);
      await this.publishLog(`Server '${serverId}': ${String(err)}`, 'error');
      await this.patchServerStatus(serverId, 'error');
    }
  }

  // ─── API calls back to the server ─────────────────────────────────────────

  private async patchServerStatus(
    serverId: string,
    status: 'configuring' | 'running' | 'error' | 'stopped'
  ): Promise<void> {
    try {
      await fetch(`${this.apiBaseUrl}/v1/mcp/${serverId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch (err) {
      console.warn(`[McpoManager] Failed to patch status for '${serverId}':`, err);
    }
  }

  private async patchServerTools(serverId: string, tools: string[]): Promise<void> {
    try {
      await fetch(`${this.apiBaseUrl}/v1/mcp/${serverId}/tools`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools }),
      });
    } catch (err) {
      console.warn(`[McpoManager] Failed to patch tools for '${serverId}':`, err);
    }
  }

  // ─── Log streaming via dockerode ──────────────────────────────────────────

  private startLogTail(): void {
    if (this.stopping) return;

    const container = this.docker.getContainer(this.mcpoContainerName);

    // Use Promise-based API to avoid unhandled-rejection noise from the callback form.
    container.logs({ follow: true, stdout: true, stderr: true, timestamps: true, tail: 50 })
      .then((stream: NodeJS.ReadableStream) => {
        this.logStream = stream;
        console.log(`[McpoManager] Tailing logs for container: ${this.mcpoContainerName}`);

        // Docker multiplexes stdout/stderr in an 8-byte framed format.
        // dockerode's modem.demuxStream splits them cleanly.
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        this.docker.modem.demuxStream(stream, stdout, stderr);

        const onChunk = (chunk: Buffer) => this.handleLogChunk(chunk.toString(), 'info');
        stdout.on('data', onChunk);
        stderr.on('data', onChunk);

        stream.on('end', () => {
          if (!this.stopping) {
            console.log('[McpoManager] Log stream ended, restarting in 5s');
            setTimeout(() => this.startLogTail(), 5_000);
          }
        });

        stream.on('error', (e: Error) => {
          console.warn('[McpoManager] Log stream error:', e.message);
          if (!this.stopping) setTimeout(() => this.startLogTail(), 10_000);
        });
      })
      .catch((err: Error) => {
        // Container not running yet or not found — retry silently
        console.warn(`[McpoManager] Could not attach to logs (${err.message}), retrying in 10s`);
        if (!this.stopping) setTimeout(() => this.startLogTail(), 10_000);
      });
  }

  private logBuffer = '';

  private handleLogChunk(chunk: string, level: string): void {
    this.logBuffer += chunk;
    const lines = this.logBuffer.split('\n');
    this.logBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      // Detect error-level lines from mcpo output
      const effectiveLevel =
        /error|exception|traceback|critical/i.test(line) ? 'error'
        : /warn/i.test(line) ? 'warn'
        : level;
      this.publishLog(line, effectiveLevel).catch(() => {});
    }
  }

  private async publishLog(line: string, level: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.xadd(
        MCP_LOG_STREAM,
        'MAXLEN',
        '~',
        String(LOG_STREAM_MAXLEN),
        '*',
        'line', line,
        'level', level,
        'ts', new Date().toISOString(),
      );
    } catch {
      // Non-fatal
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
