/**
 * Discord Channel for NanoClaw
 * Connects to Discord via discord.js and handles message I/O
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';
  prefixAssistantName = false;

  private client: Client;
  private connected = false;
  private token: string;
  private opts: DiscordChannelOpts;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(opts: DiscordChannelOpts) {
    this.token = opts.token;
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (readyClient) => {
        this.connected = true;
        logger.info(
          {
            tag: readyClient.user.tag,
            guilds: readyClient.guilds.cache.size,
          },
          'Discord bot connected',
        );
        resolve();
      });

      this.client.on(Events.Error, (err) => {
        logger.error({ err }, 'Discord client error');
      });

      this.client.on(Events.MessageCreate, (message: Message) => {
        this.handleMessage(message);
      });

      this.client.login(this.token).catch(reject);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(jid);
      if (!channel?.isTextBased()) return;

      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await (channel as TextChannel).send(text);
        return;
      }

      // Split long messages, preferring newline boundaries
      let remaining = text;
      while (remaining.length > 0) {
        if (remaining.length <= MAX_LENGTH) {
          await (channel as TextChannel).send(remaining);
          break;
        }
        let splitIndex = remaining.lastIndexOf('\n', MAX_LENGTH);
        if (splitIndex < MAX_LENGTH / 2) splitIndex = MAX_LENGTH;
        const chunk = remaining.substring(0, splitIndex);
        remaining = remaining.substring(splitIndex).trimStart();
        await (channel as TextChannel).send(chunk);
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Discord channel IDs are pure numeric snowflake strings
    // WhatsApp JIDs always contain '@'
    return /^\d+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    this.connected = false;
    this.client.destroy();
    logger.info('Discord bot disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) {
      const interval = this.typingIntervals.get(jid);
      if (interval) {
        clearInterval(interval);
        this.typingIntervals.delete(jid);
      }
      return;
    }

    const sendTyping = async () => {
      try {
        const channel = await this.client.channels.fetch(jid);
        if (channel?.isTextBased()) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    await sendTyping();
    // Refresh every 9 seconds (Discord typing expires after 10)
    const interval = setInterval(sendTyping, 9000);
    this.typingIntervals.set(jid, interval);
  }

  private handleMessage(message: Message): void {
    if (message.author.bot) return;
    if (!message.guild) return; // Ignore DMs for now

    const channelId = message.channelId;
    const timestamp = message.createdAt.toISOString();
    const channelName =
      'name' in message.channel ? (message.channel as TextChannel).name : channelId;

    this.opts.onChatMetadata(channelId, timestamp, channelName);

    const groups = this.opts.registeredGroups();
    if (!groups[channelId]) return;

    // Replace Discord bot mention with @ASSISTANT_NAME so TRIGGER_PATTERN matches
    let content = message.content;
    const botMentionPattern = new RegExp(
      `<@!?${this.client.user!.id}>`,
      'g',
    );
    const isMentioned = botMentionPattern.test(content);
    if (isMentioned) {
      content = content
        .replace(botMentionPattern, `@${ASSISTANT_NAME}`)
        .trim();
    }

    this.opts.onMessage(channelId, {
      id: message.id,
      chat_jid: channelId,
      sender: message.author.id,
      sender_name:
        message.member?.displayName || message.author.username,
      content,
      timestamp,
      is_from_me: false,
    });
  }
}
