import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load .env file
const dotenvResult = dotenvConfig();
console.log('[config] dotenv loaded:', dotenvResult.error ? `error: ${dotenvResult.error.message}` : 'success');
console.log('[config] ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? `set (${process.env.ANTHROPIC_API_KEY.substring(0, 15)}...)` : 'NOT SET');

const configSchema = z.object({
  // Discord
  discordBotToken: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  discordOwnerId: z.string().min(1, 'DISCORD_OWNER_ID is required'),
  discordChannelChat: z.string().min(1, 'DISCORD_CHANNEL_CHAT is required'),
  discordChannelVerbose: z.string().min(1, 'DISCORD_CHANNEL_VERBOSE is required'),
  discordChannelText: z.string().min(1, 'DISCORD_CHANNEL_TEXT is required'),

  // MCP Server
  mcpPort: z.number().int().positive().default(3100),

  // Optional
  anthropicApiKey: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const rawConfig = {
    discordBotToken: process.env.DISCORD_BOT_TOKEN,
    discordOwnerId: process.env.DISCORD_OWNER_ID,
    discordChannelChat: process.env.DISCORD_CHANNEL_CHAT,
    discordChannelVerbose: process.env.DISCORD_CHANNEL_VERBOSE,
    discordChannelText: process.env.DISCORD_CHANNEL_TEXT,
    mcpPort: process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3100,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    console.error('Configuration error:');
    for (const error of result.error.errors) {
      console.error(`  - ${error.path.join('.')}: ${error.message}`);
    }
    console.error('\nPlease check your .env file. See .env.example for required variables.');
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
