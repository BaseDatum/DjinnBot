/**
 * AgentDiscordRuntime — One instance per agent persona.
 *
 * Each agent runs its own Discord bot (discord.js Client), receives its own
 * DMs and @mentions, maintains context about its current work, and uses the
 * session pool for persistent container sessions.
 *
 * Mirrors AgentSlackRuntime but for the Discord platform.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  type Message,
  type TextChannel,
  type DMChannel,
  type ThreadChannel,
} from 'discord.js';
import type { AgentRegistryEntry } from '@djinnbot/core';
import { parseModelString, authFetch } from '@djinnbot/core';
import { DiscordStreamer } from './discord-streamer.js';
import { DiscordAllowlist, type DiscordAllowlistConfig } from './allowlist.js';
import type { DiscordSessionPool } from './discord-session-pool.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActiveStep {
  runId: string;
  stepId: string;
  pipelineId: string;
  status: 'working' | 'waiting_review' | 'paused';
  threadId: string;
  channelId: string;
  startedAt: number;
  taskSummary: string;
}

export interface DiscordMessageData {
  agentId: string;
  agentName: string;
  agentEmoji: string;
  userId?: string;
  userName?: string;
  message: string;
  isAgent: boolean;
  channelId: string;
  messageId: string;
}

export interface AgentDiscordRuntimeConfig {
  agent: AgentRegistryEntry;
  /** Called when agent needs to make an LLM decision about a Discord event */
  onDecisionNeeded: (
    agentId: string,
    systemPrompt: string,
    userPrompt: string,
    model: string,
  ) => Promise<string>;
  /** Called when human guidance should be injected into the pipeline */
  onHumanGuidance?: (
    agentId: string,
    runId: string,
    stepId: string,
    guidance: string,
  ) => Promise<void>;
  /** Called when a Discord message is sent or received in a run thread */
  onDiscordMessage?: (runId: string, message: DiscordMessageData) => Promise<void>;
  /** Session pool for persistent container sessions */
  sessionPool?: DiscordSessionPool;
  /** Called to load the full agent persona with environment context */
  onLoadPersona?: (
    agentId: string,
    sessionContext: { sessionType: 'discord' | 'pulse' | 'pipeline'; channelContext?: string; installedTools?: string[] }
  ) => Promise<{ systemPrompt: string; identity: string; soul: string; agents: string; decision: string }>;
  /** Check if a thread is a pipeline work thread */
  isPipelineThread?: (channelId: string, threadId: string) => boolean;
  /** Default channel for run threads */
  defaultChannelId?: string;
  /** Default model for Discord decisions */
  defaultDiscordDecisionModel?: string;
  /** Called when a user gives feedback on an agent response */
  onFeedback?: (
    agentId: string,
    feedback: 'positive' | 'negative',
    responseText: string,
    userName: string,
  ) => Promise<void>;
}

// ─── Runtime ──────────────────────────────────────────────────────────────────

export class AgentDiscordRuntime {
  readonly agentId: string;
  private client: Client;
  private config: AgentDiscordRuntimeConfig;
  private agent: AgentRegistryEntry;
  private botUserId: string | undefined;
  private allowlist: DiscordAllowlist;
  private running = false;

  // Work context
  private activeSteps: ActiveStep[] = [];

  /** Active streamers: keyed by `${runId}:${stepId}` or `conv:${sessionId}` */
  private streamers = new Map<string, DiscordStreamer>();

  constructor(config: AgentDiscordRuntimeConfig) {
    this.config = config;
    this.agent = config.agent;
    this.agentId = config.agent.id;

    const discordCreds = config.agent.channels.discord;
    if (!discordCreds) {
      throw new Error(`Agent ${config.agent.id} has no Discord channel credentials`);
    }

    // Build allowlist from extra config
    const allowlistConfig: DiscordAllowlistConfig = {
      allowFrom: discordCreds.extra?.allow_from,
      dmPolicy: (discordCreds.extra?.dm_policy as 'allowlist' | 'open') ?? 'allowlist',
    };
    this.allowlist = new DiscordAllowlist(allowlistConfig);

    // Create discord.js client with required intents
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [
        Partials.Message,
        Partials.Channel, // Required for DM events
        Partials.Reaction,
      ],
    });

    this.setupEventHandlers();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const discordCreds = this.agent.channels.discord;
    if (!discordCreds?.primaryToken) {
      throw new Error(`Agent ${this.agentId} has no Discord bot token`);
    }

    console.log(`[${this.agentId}] Connecting to Discord...`);

    try {
      await this.client.login(discordCreds.primaryToken);
      this.running = true;

      // Wait for ready event
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Discord login timeout')), 30000);
        this.client.once(Events.ClientReady, (readyClient) => {
          clearTimeout(timeout);
          this.botUserId = readyClient.user.id;
          console.log(
            `[${this.agentId}] Discord connected — ${this.agent.identity.name} ${this.agent.identity.emoji} ` +
            `(${readyClient.user.tag}) is online`,
          );
          resolve();
        });
        // If already ready (rare), resolve immediately
        if (this.client.isReady()) {
          clearTimeout(timeout);
          this.botUserId = this.client.user?.id;
          resolve();
        }
      });
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.error(
        `[${this.agentId}] Discord login FAILED — this usually means the bot token is invalid ` +
        `or the Message Content Intent is not enabled. Error: ${errMsg}`,
      );
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.client.destroy();
    this.running = false;
    console.log(`[${this.agentId}] Discord disconnected`);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Get the discord.js Client */
  getClient(): Client {
    return this.client;
  }

  // ─── Work Context ──────────────────────────────────────────────────────────

  addActiveStep(step: Omit<ActiveStep, 'startedAt'>): void {
    this.activeSteps = this.activeSteps.filter(
      (s) => !(s.runId === step.runId && s.stepId === step.stepId),
    );
    this.activeSteps.push({ ...step, startedAt: Date.now() });
  }

  removeActiveStep(runId: string, stepId: string): void {
    this.activeSteps = this.activeSteps.filter(
      (s) => !(s.runId === runId && s.stepId === stepId),
    );
  }

  getActiveSteps(): ActiveStep[] {
    return [...this.activeSteps];
  }

  // ─── Streamer Management ───────────────────────────────────────────────────

  /**
   * Create and start a DiscordStreamer for a pipeline step.
   */
  async startStepStream(
    runId: string,
    stepId: string,
    channelId: string,
    threadId: string,
  ): Promise<DiscordStreamer> {
    const key = `${runId}:${stepId}`;
    const existing = this.streamers.get(key);
    if (existing && existing.currentState === 'streaming') {
      await existing.stopWithError('Interrupted by new step');
    }

    const channel = await this.client.channels.fetch(threadId) as ThreadChannel;
    const streamer = new DiscordStreamer({ channel });

    this.streamers.set(key, streamer);
    return streamer;
  }

  getStepStreamer(runId: string, stepId: string): DiscordStreamer | undefined {
    return this.streamers.get(`${runId}:${stepId}`);
  }

  removeStepStreamer(runId: string, stepId: string): void {
    this.streamers.delete(`${runId}:${stepId}`);
  }

  /** Get conversation streamer by session ID */
  getConvStreamer(sessionId: string): DiscordStreamer | undefined {
    return this.streamers.get(`conv:${sessionId}`);
  }

  removeConvStreamer(sessionId: string): void {
    this.streamers.delete(`conv:${sessionId}`);
  }

  // ─── Message Posting ──────────────────────────────────────────────────────

  /**
   * Post a message to a Discord channel.
   */
  async postToChannel(
    channelId: string,
    text: string,
    runId?: string,
  ): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        console.error(`[${this.agentId}] Channel ${channelId} not found or not sendable`);
        return undefined;
      }

      const textChannel = channel as TextChannel;
      // Discord message content limit: 2000 chars
      const content = text.length > 2000
        ? text.slice(0, 1997) + '...'
        : text;
      const result = await textChannel.send({ content });

      if (runId && this.config.onDiscordMessage) {
        await this.config.onDiscordMessage(runId, {
          agentId: this.agentId,
          agentName: this.agent.identity.name,
          agentEmoji: this.agent.identity.emoji,
          message: text,
          isAgent: true,
          channelId,
          messageId: result.id,
        });
      }

      return result.id;
    } catch (err) {
      console.error(`[${this.agentId}] Failed to post to channel:`, err);
      return undefined;
    }
  }

  // ─── Model Resolution ─────────────────────────────────────────────────────

  /**
   * Resolve the model string to use for Discord sessions.
   */
  private resolveDiscordModel(): string {
    const candidates = [
      this.agent.config?.model,
      this.agent.config?.thinkingModel,
      this.config.defaultDiscordDecisionModel,
    ].filter(Boolean) as string[];

    for (const modelString of candidates) {
      try {
        parseModelString(modelString);
        return modelString;
      } catch {
        console.debug(`[${this.agentId}] resolveDiscordModel: skipping "${modelString}"`);
      }
    }

    return 'openrouter/moonshotai/kimi-k2.5';
  }

  // ─── Persona Loading ──────────────────────────────────────────────────────

  private async buildFullSystemPrompt(channelContext?: string): Promise<string> {
    if (this.config.onLoadPersona) {
      try {
        const persona = await this.config.onLoadPersona(this.agentId, {
          sessionType: 'discord',
          channelContext,
        });
        return persona.systemPrompt;
      } catch (err) {
        console.error(`[${this.agentId}] Failed to load persona, using fallback:`, err);
      }
    }

    // Fallback minimal prompt
    const sections: string[] = [
      `# IDENTITY`,
      `You are ${this.agent.identity.name} ${this.agent.identity.emoji}, ${this.agent.identity.role}.`,
    ];

    if (this.agent.soul) {
      sections.push('', '# SOUL', this.agent.soul);
    }

    sections.push(
      '',
      '# YOUR ENVIRONMENT',
      '',
      '## Session Context',
      '- **Session Type**: Discord conversation',
      channelContext ? `- **Channel Context**: ${channelContext}` : '',
      '',
      'You are responding in a Discord conversation. Keep responses concise and natural.',
      'You have full access to your workspace and tools to help with complex requests.',
      'Format with Discord markdown: **bold**, *italic*, `code`, ```code blocks```.',
    );

    return sections.join('\n');
  }

  // ─── Event Handlers ───────────────────────────────────────────────────────

  private setupEventHandlers(): void {
    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore own messages
      if (message.author.id === this.botUserId) return;
      // Ignore other bots
      if (message.author.bot) return;

      const isDM = message.channel.type === ChannelType.DM;
      const authorTag = `${message.author.username}#${message.author.discriminator}`;
      const locationDesc = isDM
        ? 'DM'
        : `guild=${message.guildId} channel=${message.channelId}`;

      console.log(
        `[${this.agentId}] Discord message received — from=${authorTag} (${message.author.id}) ${locationDesc}: "${message.content.slice(0, 80)}"`,
      );

      // ── Allowlist check ──────────────────────────────────────────────
      const member = message.member ?? null;

      const match = this.allowlist.isAllowed(message.author.id, member, isDM);
      if (!match.allowed) {
        const reason = this.allowlist.isEmpty
          ? 'allowlist is empty (no users permitted — set allow_from in Discord channel config)'
          : `user ${message.author.id} not in allowlist`;
        console.warn(
          `[${this.agentId}] Message BLOCKED — ${reason}`,
        );
        return;
      }

      // ── Guild restrictions ────────────────────────────────────────────
      const guildId = this.agent.channels.discord?.extra?.guild_id;
      if (guildId && message.guildId && message.guildId !== guildId) {
        console.log(
          `[${this.agentId}] Message ignored — guild ${message.guildId} does not match configured guild ${guildId}`,
        );
        return;
      }

      // ── Route to handler ──────────────────────────────────────────────
      if (isDM) {
        console.log(`[${this.agentId}] Routing to DM handler`);
        await this.handleDirectMessage(message);
      } else if (message.channel.isThread()) {
        // Thread reply in a guild channel
        const isPipelineWorkThread = this.config.isPipelineThread?.(
          message.channel.parentId ?? '',
          message.channel.id,
        ) ?? false;

        if (isPipelineWorkThread) {
          // Only respond if @mentioned
          const mentionsMe = this.botUserId && message.mentions.has(this.botUserId);
          if (mentionsMe) {
            console.log(`[${this.agentId}] Routing to pipeline thread handler (mentioned)`);
            await this.handleThreadReply(message);
          }
          return;
        }

        // Regular thread — respond if mentioned or has participated
        if (this.botUserId && message.mentions.has(this.botUserId)) {
          console.log(`[${this.agentId}] Routing to thread handler (mentioned)`);
          await this.handleThreadReply(message);
        }
      } else {
        // Channel message — only respond if @mentioned
        if (this.botUserId && message.mentions.has(this.botUserId)) {
          console.log(`[${this.agentId}] Routing to mention handler`);
          await this.handleMention(message);
        }
      }
    });

    // ─── Feedback Reactions ─────────────────────────────────────────────
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      // Ignore own reactions
      if (user.id === this.botUserId) return;
      // Ignore bot reactions
      if (user.bot) return;

      // Only handle 👍/👎 on messages from this bot
      const emoji = reaction.emoji.name;
      if (emoji !== '👍' && emoji !== '👎') return;

      // Fetch the message if partial
      const message = reaction.message.partial
        ? await reaction.message.fetch()
        : reaction.message;

      if (message.author?.id !== this.botUserId) return;

      if (!this.config.onFeedback) return;

      const feedback: 'positive' | 'negative' = emoji === '👍' ? 'positive' : 'negative';
      const userName = user.username ?? 'User';
      const responseText = message.content || message.embeds[0]?.description || '(response not available)';

      try {
        await this.config.onFeedback(this.agentId, feedback, responseText, userName);
        // React to confirm
        const confirmEmoji = feedback === 'positive' ? '✅' : '📝';
        await message.react(confirmEmoji).catch(() => {});
      } catch (err) {
        console.warn(`[${this.agentId}] Failed to process feedback:`, (err as Error).message);
      }
    });
  }

  // ─── Message Handlers ──────────────────────────────────────────────────────

  /**
   * Handle a direct message to this agent.
   */
  private async handleDirectMessage(message: Message): Promise<void> {
    console.log(
      `[${this.agentId}] DM from ${message.author.username}: ${message.content.slice(0, 100)}`,
    );

    const userName = message.author.displayName ?? message.author.username;
    const messageText = message.content;

    // Pool path: persistent container session with streaming response
    if (this.config.sessionPool) {
      console.log(`[${this.agentId}] DM — using session pool`);
      await this.respondViaPool(
        message.channel as DMChannel,
        messageText,
        message.author.id,
        userName,
        'dm',
        undefined,
        message,
      );
      return;
    }

    // Lightweight fallback — simple LLM response
    await this.respondLightweight(message, userName);
  }

  /**
   * Handle an @mention in a guild channel.
   */
  private async handleMention(message: Message): Promise<void> {
    console.log(
      `[${this.agentId}] @mentioned by ${message.author.username}: ${message.content.slice(0, 100)}`,
    );

    const userName = message.member?.displayName ?? message.author.displayName ?? message.author.username;

    // Strip mention from text
    const cleanText = message.content
      .replace(/<@!?\d+>/g, '')
      .trim();

    // Create a thread for the response
    let replyThread: ThreadChannel | undefined;
    try {
      if ('threads' in message.channel && message.channel.type === ChannelType.GuildText) {
        replyThread = await message.startThread({
          name: `${this.agent.identity.name}: ${cleanText.slice(0, 80) || 'Response'}`,
          autoArchiveDuration: 60, // 1 hour
        });
      }
    } catch {
      // Thread creation failed — reply directly
    }

    if (this.config.sessionPool) {
      const targetChannel = replyThread ?? message.channel;
      const threadId = replyThread?.id;

      let messageWithContext = `${userName}: ${cleanText}`;

      // Fetch recent channel context if not in a thread
      if (!message.channel.isThread()) {
        const channelContext = await this.fetchRecentChannelContext(message.channel as TextChannel, message.id);
        if (channelContext) {
          messageWithContext = `[Recent channel messages for context]\n${channelContext}\n\n[New message — respond to this]\n${userName}: ${cleanText}`;
        }
      }

      console.log(`[${this.agentId}] @mention — using session pool`);
      await this.respondViaPool(
        targetChannel as TextChannel | DMChannel | ThreadChannel,
        messageWithContext,
        message.author.id,
        userName,
        'guild_thread',
        threadId,
        message,
      );
      return;
    }

    // Lightweight fallback
    await this.respondLightweight(message, userName, replyThread);
  }

  /**
   * Handle a thread reply.
   */
  private async handleThreadReply(message: Message): Promise<void> {
    console.log(
      `[${this.agentId}] Thread reply from ${message.author.username}: ${message.content.slice(0, 100)}`,
    );

    const userName = message.member?.displayName ?? message.author.displayName ?? message.author.username;
    const cleanText = message.content
      .replace(/<@!?\d+>/g, '')
      .trim();

    if (this.config.sessionPool) {
      console.log(`[${this.agentId}] Thread reply — using session pool`);
      await this.respondViaPool(
        message.channel as ThreadChannel,
        cleanText,
        message.author.id,
        userName,
        'guild_thread',
        message.channel.id,
        message,
      );
      return;
    }

    await this.respondLightweight(message, userName);
  }

  // ─── Response Paths ────────────────────────────────────────────────────────

  /**
   * Respond via the session pool (persistent container with streaming).
   */
  private async respondViaPool(
    channel: TextChannel | DMChannel | ThreadChannel,
    messageText: string,
    userId: string,
    userName: string,
    source: 'dm' | 'guild_thread',
    threadId?: string,
    originalMessage?: Message,
  ): Promise<void> {
    const pool = this.config.sessionPool;
    if (!pool) return;

    // Create streamer for this response
    const streamer = new DiscordStreamer({
      channel: channel as any,
      replyToMessageId: originalMessage?.id,
    });

    // Download and re-upload attachments
    let attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number; isImage: boolean }> | undefined;
    if (originalMessage?.attachments.size) {
      const apiBaseUrl = process.env.DJINNBOT_API_URL || 'http://api:8000';
      attachments = [];
      for (const [, attachment] of originalMessage.attachments) {
        try {
          const dlRes = await fetch(attachment.url);
          if (!dlRes.ok) continue;
          const buffer = Buffer.from(await dlRes.arrayBuffer());

          const formData = new FormData();
          formData.append('file', new Blob([buffer]), attachment.name ?? 'file');
          const sessionIdForUpload = `discord_${this.agentId}_${channel.id}`;
          const mimeType = attachment.contentType ?? 'application/octet-stream';
          const uploadRes = await authFetch(
            `${apiBaseUrl}/v1/internal/chat/attachments/upload-bytes?session_id=${encodeURIComponent(sessionIdForUpload)}&filename=${encodeURIComponent(attachment.name ?? 'file')}&mime_type=${encodeURIComponent(mimeType)}`,
            { method: 'POST', body: formData },
          );
          if (uploadRes.ok) {
            const result = await uploadRes.json() as { id: string; filename: string; mimeType: string; sizeBytes: number };
            attachments.push({
              id: result.id,
              filename: result.filename,
              mimeType: result.mimeType,
              sizeBytes: result.sizeBytes,
              isImage: result.mimeType.startsWith('image/'),
            });
          }
        } catch (err) {
          console.warn(`[${this.agentId}] Failed to process attachment ${attachment.name}:`, err);
        }
      }
      if (attachments.length === 0) attachments = undefined;
    }

    // Send to session pool — pre-registers sessionId synchronously
    const sessionId = await pool.sendMessage({
      agentId: this.agentId,
      channelId: channel.id,
      threadId,
      source,
      message: messageText,
      userId,
      userName,
      client: this.client,
      botUserId: this.botUserId,
      model: this.resolveDiscordModel(),
      attachments,
    });

    // Register streamer by sessionId
    this.streamers.set(`conv:${sessionId}`, streamer);

    // Start stream + typing indicator
    try {
      await streamer.start(`${this.agent.identity.name} is thinking...`);
    } catch (err) {
      console.warn(`[${this.agentId}] Stream start failed:`, err);
    }
  }

  /**
   * Lightweight fallback — one-shot LLM response (no container, no tools).
   */
  private async respondLightweight(
    message: Message,
    userName: string,
    replyThread?: ThreadChannel,
  ): Promise<void> {
    const cleanText = message.content.replace(/<@!?\d+>/g, '').trim();
    const channel = replyThread ?? message.channel;

    try {
      // Start typing
      if ('sendTyping' in channel) {
        await (channel as any).sendTyping();
      }

      const systemPrompt = await this.buildFullSystemPrompt(
        `Message from ${userName} in Discord`,
      );

      const modelString = this.resolveDiscordModel();

      const response = await this.config.onDecisionNeeded(
        this.agentId,
        systemPrompt,
        `${userName} said: ${cleanText}`,
        modelString,
      );

      if (response.trim()) {
        const content = response.length > 2000
          ? response.slice(0, 1997) + '...'
          : response;
        await (channel as any).send({ content });
      }
    } catch (err) {
      console.error(`[${this.agentId}] Lightweight response failed:`, err);
      try {
        await (channel as any).send({
          embeds: [{
            description: 'Something went wrong. Please try again.',
            color: 0xED4245,
          }],
        });
      } catch { /* ignore */ }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Fetch recent channel messages for context.
   */
  private async fetchRecentChannelContext(
    channel: TextChannel,
    beforeMessageId: string,
  ): Promise<string | null> {
    try {
      const messages = await channel.messages.fetch({ limit: 10, before: beforeMessageId });
      if (messages.size === 0) return null;

      const sorted = [...messages.values()].reverse();
      const lines = sorted.map((msg) => {
        const name = msg.member?.displayName ?? msg.author.displayName ?? msg.author.username;
        const isBot = msg.author.id === this.botUserId;
        const prefix = isBot ? `${this.agent.identity.name}` : name;
        return `${prefix}: ${msg.content.slice(0, 200)}`;
      });

      return lines.join('\n');
    } catch {
      return null;
    }
  }
}
