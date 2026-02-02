#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Client, GatewayIntentBits, TextChannel, Partials } from 'discord.js';

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Store channels cache
const channelCache = new Map<string, TextChannel>();

// MCP Server setup
const server = new Server(
  {
    name: 'discord-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const tools: Tool[] = [
  {
    name: 'send_message',
    description: 'Send a message to a Discord channel. Can send text and/or images.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The Discord channel ID',
        },
        content: {
          type: 'string',
          description: 'The message content (optional if sending only an image)',
        },
        image_base64: {
          type: 'string',
          description: 'Base64 encoded image to attach (optional)',
        },
        image_filename: {
          type: 'string',
          description: 'Filename for the image attachment (default: image.png)',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'read_messages',
    description: 'Read recent messages from a Discord channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The Discord channel ID',
        },
        limit: {
          type: 'number',
          description: 'Number of messages to retrieve (default: 10, max: 100)',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'add_reaction',
    description: 'Add a reaction emoji to a message',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The Discord channel ID',
        },
        message_id: {
          type: 'string',
          description: 'The message ID to react to',
        },
        emoji: {
          type: 'string',
          description: 'The emoji to react with (unicode emoji or custom emoji name)',
        },
      },
      required: ['channel_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'list_channels',
    description: 'List all available text channels in guilds the bot has access to',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_message',
    description: 'Get a specific message by ID',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The Discord channel ID',
        },
        message_id: {
          type: 'string',
          description: 'The message ID to retrieve',
        },
      },
      required: ['channel_id', 'message_id'],
    },
  },
];

// Helper function to get or fetch channel
async function getChannel(channelId: string): Promise<TextChannel> {
  if (channelCache.has(channelId)) {
    return channelCache.get(channelId)!;
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !(channel instanceof TextChannel)) {
    throw new Error(`Channel ${channelId} not found or is not a text channel`);
  }

  channelCache.set(channelId, channel);
  return channel;
}

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'send_message': {
        const { channel_id, content, image_base64, image_filename } = args as {
          channel_id: string;
          content?: string;
          image_base64?: string;
          image_filename?: string;
        };

        const channel = await getChannel(channel_id);

        const messageOptions: any = {};
        if (content) {
          messageOptions.content = content;
        }
        if (image_base64) {
          const buffer = Buffer.from(image_base64, 'base64');
          messageOptions.files = [
            {
              attachment: buffer,
              name: image_filename || 'image.png',
            },
          ];
        }

        const message = await channel.send(messageOptions);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message_id: message.id,
                  channel: channel.name,
                  timestamp: message.createdAt.toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'read_messages': {
        const { channel_id, limit = 10 } = args as {
          channel_id: string;
          limit?: number;
        };

        const channel = await getChannel(channel_id);
        const messages = await channel.messages.fetch({
          limit: Math.min(limit, 100),
        });

        const formattedMessages = messages.map((msg) => ({
          id: msg.id,
          author: {
            id: msg.author.id,
            username: msg.author.username,
            tag: msg.author.tag,
            bot: msg.author.bot,
          },
          content: msg.content,
          timestamp: msg.createdAt.toISOString(),
          attachments: msg.attachments.map((att) => ({
            id: att.id,
            filename: att.name,
            url: att.url,
            size: att.size,
          })),
          reactions: msg.reactions.cache.map((reaction) => ({
            emoji: reaction.emoji.name,
            count: reaction.count,
          })),
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      }

      case 'add_reaction': {
        const { channel_id, message_id, emoji } = args as {
          channel_id: string;
          message_id: string;
          emoji: string;
        };

        const channel = await getChannel(channel_id);
        const message = await channel.messages.fetch(message_id);
        await message.react(emoji);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  message_id,
                  emoji,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'list_channels': {
        const channels: Array<{ id: string; name: string; guild: string }> = [];

        for (const guild of client.guilds.cache.values()) {
          for (const channel of guild.channels.cache.values()) {
            if (channel instanceof TextChannel) {
              channels.push({
                id: channel.id,
                name: channel.name,
                guild: guild.name,
              });
            }
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(channels, null, 2),
            },
          ],
        };
      }

      case 'get_message': {
        const { channel_id, message_id } = args as {
          channel_id: string;
          message_id: string;
        };

        const channel = await getChannel(channel_id);
        const message = await channel.messages.fetch(message_id);

        const formattedMessage = {
          id: message.id,
          author: {
            id: message.author.id,
            username: message.author.username,
            tag: message.author.tag,
            bot: message.author.bot,
          },
          content: message.content,
          timestamp: message.createdAt.toISOString(),
          attachments: message.attachments.map((att) => ({
            id: att.id,
            filename: att.name,
            url: att.url,
            size: att.size,
          })),
          reactions: message.reactions.cache.map((reaction) => ({
            emoji: reaction.emoji.name,
            count: reaction.count,
          })),
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formattedMessage, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: errorMessage }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Main startup
async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN environment variable is required');
  }

  // Login to Discord
  await client.login(token);
  console.error('Discord bot logged in');

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Discord MCP server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
