/**
 * Chat session command listener.
 * 
 * Listens to Redis stream for chat session lifecycle commands
 * and delegates to ChatSessionManager.
 */
import { Redis } from 'ioredis';
import { ChatSessionManager } from './chat-session-manager.js';
import { DEFAULT_CHAT_MODEL } from '../constants.js';

const CHAT_STREAM = 'djinnbot:events:chat_sessions';
const CONSUMER_GROUP = 'djinnbot-chat';
const CONSUMER_NAME = `chat-worker-${process.pid}`;

export interface ChatListenerConfig {
  redis: Redis;
  sessionManager: ChatSessionManager;
}

export class ChatListener {
  private redis: Redis;
  private sessionManager: ChatSessionManager;
  private running = false;

  constructor(config: ChatListenerConfig) {
    // Create a DEDICATED Redis connection — ChatListener uses a blocking
    // XREADGROUP BLOCK loop that would starve any other command (PUBLISH,
    // SETEX, etc.) on a shared connection for up to 5 seconds per cycle.
    this.redis = new Redis(config.redis.options);
    this.sessionManager = config.sessionManager;
  }

  /**
   * Initialize the consumer group (create if not exists).
   */
  async initialize(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', CHAT_STREAM, CONSUMER_GROUP, '0', 'MKSTREAM');
      console.log(`[ChatListener] Created consumer group: ${CONSUMER_GROUP}`);
    } catch (err: any) {
      if (err.message?.includes('BUSYGROUP')) {
        console.log(`[ChatListener] Consumer group already exists: ${CONSUMER_GROUP}`);
      } else {
        throw err;
      }
    }
  }

  /**
   * Start listening for chat commands.
   */
  async start(): Promise<void> {
    await this.initialize();
    this.running = true;
    
    console.log(`[ChatListener] Listening for chat commands on stream: ${CHAT_STREAM}`);
    
    while (this.running) {
      try {
        // Read from the stream using consumer group
        const messages: any = await this.redis.xreadgroup(
          'GROUP',
          CONSUMER_GROUP,
          CONSUMER_NAME,
          'COUNT',
          10,
          'BLOCK',
          5000,  // Block for 5 seconds
          'STREAMS',
          CHAT_STREAM,
          '>'  // Only new messages
        );
        
        if (!messages || messages.length === 0) {
          continue;
        }
        
        // Process messages
        for (const streamData of messages) {
          const [streamName, streamMessages] = streamData;
          
          for (const messageData of streamMessages) {
            const [id, fields] = messageData;
            
            // Convert fields array to object
            const data: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              data[fields[i]] = fields[i + 1];
            }
            
            await this.handleCommand(data);
            
            // Acknowledge the message
            await this.redis.xack(CHAT_STREAM, CONSUMER_GROUP, id);
          }
        }
      } catch (err) {
        if (!this.running) break;
        console.error('[ChatListener] Error reading from stream:', err);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log('[ChatListener] Stopped');
  }

  /**
   * Handle a chat command from the stream.
   */
  private async handleCommand(data: Record<string, string>): Promise<void> {
    const event = data.event;
    const sessionId = data.session_id;
    const agentId = data.agent_id;
    
    console.log(`[ChatListener] Received command: ${event} for session ${sessionId}`);
    
    try {
      switch (event) {
        case 'chat:start':
          await this.sessionManager.startSession({
            sessionId,
            agentId,
            model: data.model || DEFAULT_CHAT_MODEL,
            // Onboarding sessions carry extra metadata so the runtime can
            // inject the linked-memory doctrine into the system prompt.
            sessionType: data.session_type as 'chat' | 'onboarding' | undefined,
            onboardingSessionId: data.onboarding_session_id,
            // Pre-created DB message ID for the proactive greeting turn.
            greetingMessageId: data.greeting_message_id || undefined,
            // Optional supplement appended to the persona (project context chat).
            systemPromptSupplement: data.system_prompt_supplement || undefined,
            // Skill-gen sessions override the persona system prompt entirely.
            systemPromptOverride: data.system_prompt_override || undefined,
            // Extended thinking level chosen in the dashboard chat UI.
            thinkingLevel: data.thinking_level || undefined,
          });
          break;
          
        case 'chat:stop':
          await this.sessionManager.stopSession(sessionId);
          break;
          
        case 'chat:update_model':
          this.sessionManager.updateModel(sessionId, data.model);
          break;
          
        default:
          console.warn(`[ChatListener] Unknown event type: ${event}`);
      }
    } catch (err) {
      console.error(`[ChatListener] Error handling ${event} for ${sessionId}:`, err);
    }
  }

  /**
   * Stop the listener and close its dedicated Redis connection.
   */
  async stop(): Promise<void> {
    this.running = false;
    try {
      await this.redis.quit();
    } catch (err) {
      console.warn('[ChatListener] Error closing Redis connection:', err);
    }
  }
}
