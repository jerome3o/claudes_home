import {
  Client,
  GatewayIntentBits,
  TextChannel,
  Message,
  Events,
  AttachmentBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { ChannelType } from '../types.js';
import { EventEmitter } from 'events';

const DISCORD_MAX_LENGTH = 2000;

export class DiscordClient extends EventEmitter {
  private client: Client;
  private channels: Map<ChannelType, TextChannel> = new Map();
  private ready = false;

  constructor() {
    super();
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, async (readyClient) => {
      console.log(`Discord bot logged in as ${readyClient.user.tag}`);
      await this.fetchChannels();
      this.ready = true;
      this.emit('ready');
    });

    this.client.on(Events.MessageCreate, (message) => {
      this.handleMessage(message);
    });

    this.client.on(Events.Error, (error) => {
      console.error('Discord client error:', error);
      this.emit('error', error);
    });
  }

  private async fetchChannels(): Promise<void> {
    const channelIds: [ChannelType, string][] = [
      ['chat', config.discordChannelChat],
      ['verbose', config.discordChannelVerbose],
      ['text', config.discordChannelText],
      ['screenshots', config.discordChannelScreenshots],
    ];

    for (const [type, id] of channelIds) {
      try {
        const channel = await this.client.channels.fetch(id);
        if (channel instanceof TextChannel) {
          this.channels.set(type, channel);
          console.log(`Fetched channel ${type}: #${channel.name}`);
        } else {
          console.error(`Channel ${id} (${type}) is not a text channel`);
        }
      } catch (error) {
        console.error(`Failed to fetch channel ${id} (${type}):`, error);
      }
    }
  }

  private handleMessage(message: Message): void {
    // Ignore bot messages
    if (message.author.bot) return;

    // Only respond to owner
    if (message.author.id !== config.discordOwnerId) {
      console.log(`Ignoring message from non-owner: ${message.author.tag}`);
      return;
    }

    // Only respond in chat channel
    const chatChannel = this.channels.get('chat');
    if (!chatChannel || message.channel.id !== chatChannel.id) {
      return;
    }

    // Emit message event for orchestrator to handle
    this.emit('message', message.content, message);
  }

  async connect(): Promise<void> {
    await this.client.login(config.discordBotToken);
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * React to a message with an emoji
   */
  async react(message: Message, emoji: string): Promise<void> {
    try {
      await message.react(emoji);
    } catch (error) {
      console.error(`Failed to react with ${emoji}:`, error);
    }
  }

  /**
   * Send a message to a specific channel type, handling chunking for long messages
   */
  async send(channelType: ChannelType, content: string): Promise<void> {
    const channel = this.channels.get(channelType);
    if (!channel) {
      console.error(`Channel ${channelType} not available`);
      return;
    }

    const chunks = this.chunkMessage(content);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }

  /**
   * Send a code block to a channel
   */
  async sendCode(
    channelType: ChannelType,
    content: string,
    language = ''
  ): Promise<void> {
    const codeBlock = `\`\`\`${language}\n${content}\n\`\`\``;
    await this.send(channelType, codeBlock);
  }

  /**
   * Send JSON-formatted content to verbose channel
   */
  async sendVerbose(label: string, data: unknown): Promise<void> {
    const json = JSON.stringify(data, null, 2);
    const content = `**${label}**\n\`\`\`json\n${json}\n\`\`\``;
    await this.send('verbose', content);
  }

  /**
   * Send an image (from base64 or buffer) to a specific channel
   */
  async sendImage(
    channelType: ChannelType,
    imageData: Buffer | string,
    filename = 'screenshot.png',
    message?: string
  ): Promise<void> {
    const channel = this.channels.get(channelType);
    if (!channel) {
      console.error(`Channel ${channelType} not available`);
      return;
    }

    try {
      let buffer: Buffer;
      if (typeof imageData === 'string') {
        // Assume base64
        buffer = Buffer.from(imageData, 'base64');
      } else {
        buffer = imageData;
      }

      const attachment = new AttachmentBuilder(buffer, { name: filename });
      await channel.send({
        content: message || '',
        files: [attachment],
      });
    } catch (error) {
      console.error(`Failed to send image to ${channelType}:`, error);
    }
  }

  /**
   * Chunk a message into parts that fit Discord's limit
   */
  private chunkMessage(content: string): string[] {
    if (content.length <= DISCORD_MAX_LENGTH) {
      return [content];
    }

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= DISCORD_MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Try to break at a newline
      let breakPoint = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
      if (breakPoint === -1 || breakPoint < DISCORD_MAX_LENGTH / 2) {
        // No good newline, try space
        breakPoint = remaining.lastIndexOf(' ', DISCORD_MAX_LENGTH);
      }
      if (breakPoint === -1 || breakPoint < DISCORD_MAX_LENGTH / 2) {
        // No good break point, just cut
        breakPoint = DISCORD_MAX_LENGTH;
      }

      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }

    return chunks;
  }
}
