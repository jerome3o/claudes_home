import { Message } from 'discord.js';
import { DiscordClient } from './kernel/discord.js';
import { Orchestrator } from './kernel/orchestrator.js';
import { MCPServer } from './kernel/mcp-server.js';

console.log('[kernel] Starting up...');
console.log('[kernel] Node version:', process.version);
console.log('[kernel] CWD:', process.cwd());
console.log('[kernel] ENV ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET');

// Reaction emojis
const EMOJI = {
  WORKING: '🤖',      // Started working on task
  INTERRUPT: '🔄',    // Interrupting current task
  DONE: '✅',         // Task completed
  ERROR: '❌',        // Error occurred
  QUEUED: '📋',       // Message queued (fallback if interrupt fails)
};

class Kernel {
  private discord: DiscordClient;
  private orchestrator: Orchestrator;
  private mcpServer: MCPServer;
  private shuttingDown = false;
  private currentMessage: Message | null = null;

  constructor() {
    this.discord = new DiscordClient();
    this.orchestrator = new Orchestrator(process.cwd());
    this.mcpServer = new MCPServer(this.orchestrator);

    this.setupEventHandlers();
    this.setupShutdownHandlers();
  }

  private setupEventHandlers(): void {
    // Discord ready
    this.discord.on('ready', () => {
      console.log('Discord client ready');
    });

    // Discord message from owner
    this.discord.on('message', async (content: string, message: Message) => {
      console.log(`[kernel] Received message: ${content.substring(0, 50)}...`);
      console.log(`[kernel] Message from: ${message.author.tag} in channel: ${message.channel.id}`);

      const state = this.orchestrator.getState();
      console.log(`[kernel] Current orchestrator state: ${state}`);

      if (state === 'idle') {
        // Start new task
        this.currentMessage = message;
        await this.discord.react(message, EMOJI.WORKING);
        console.log('[kernel] Sending message to orchestrator...');
        try {
          await this.orchestrator.send(content);
          console.log('[kernel] Orchestrator.send() completed');
        } catch (err) {
          console.error('[kernel] Orchestrator.send() threw:', err);
          throw err;
        }
      } else {
        // Interrupt current task and start new one
        await this.discord.react(message, EMOJI.INTERRUPT);

        // Mark previous message as interrupted (if we have it)
        if (this.currentMessage) {
          await this.discord.react(this.currentMessage, EMOJI.INTERRUPT);
        }

        this.currentMessage = message;
        await this.orchestrator.interrupt();
        await this.orchestrator.send(content);
      }
    });

    // Orchestrator events
    this.orchestrator.on('text', async (text) => {
      // Send to text channel
      await this.discord.send('text', text);
      // Also log to verbose (truncated)
      await this.discord.sendVerbose('assistant.text', {
        text: text.substring(0, 200) + (text.length > 200 ? '...' : '')
      });
    });

    this.orchestrator.on('tool_use', async (tool) => {
      await this.discord.sendVerbose('tool_use', tool);
    });

    this.orchestrator.on('tool_result', async (result) => {
      // Check if this is a computer-use screenshot
      if (this.isComputerUseScreenshot(result)) {
        await this.handleScreenshot(result);
      }

      await this.discord.sendVerbose('tool_result', {
        id: result.id,
        // Truncate large results
        content: typeof result.content === 'string'
          ? result.content.substring(0, 500) + (result.content.length > 500 ? '...' : '')
          : result.content,
      });
    });

    this.orchestrator.on('result', async (result) => {
      // Final result goes to chat channel
      await this.discord.send('chat', `**Result:**\n${result}`);
      await this.discord.sendVerbose('result', { result });

      // React with done emoji
      if (this.currentMessage) {
        await this.discord.react(this.currentMessage, EMOJI.DONE);
        this.currentMessage = null;
      }
    });

    this.orchestrator.on('error', async (error) => {
      console.error('Orchestrator error:', error);
      await this.discord.send('chat', `**Error:** ${error.message}`);
      await this.discord.sendVerbose('error', {
        message: error.message,
        stack: error.stack,
      });

      // React with error emoji
      if (this.currentMessage) {
        await this.discord.react(this.currentMessage, EMOJI.ERROR);
        this.currentMessage = null;
      }
    });

    this.orchestrator.on('stateChange', async (state) => {
      console.log(`State changed to: ${state}`);
      await this.discord.sendVerbose('stateChange', { state });
    });
  }

  /**
   * Check if a tool result contains a computer-use screenshot
   */
  private isComputerUseScreenshot(result: any): boolean {
    // Computer-use tool returns output_image in the content
    if (typeof result.content === 'object' && result.content !== null) {
      return 'output_image' in result.content;
    }
    return false;
  }

  /**
   * Handle posting a screenshot to Discord
   */
  private async handleScreenshot(result: any): Promise<void> {
    try {
      const content = result.content;
      if (content && typeof content === 'object' && 'output_image' in content) {
        const imageData = content.output_image;

        // The image data should be base64 encoded
        if (typeof imageData === 'string') {
          console.log('[kernel] Posting screenshot to Discord...');
          await this.discord.sendImage('chat', imageData, 'screenshot.png', '🖥️ Desktop Screenshot');
        }
      }
    } catch (error) {
      console.error('[kernel] Failed to post screenshot:', error);
    }
  }

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;

      console.log(`\nReceived ${signal}, shutting down gracefully...`);

      try {
        await this.orchestrator.shutdown();
        await this.mcpServer.stop();
        await this.discord.disconnect();
        console.log('Shutdown complete');
        process.exit(0);
      } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  async start(): Promise<void> {
    console.log('Starting Claude Discord Harness...');

    try {
      // Start MCP server first
      await this.mcpServer.start();

      // Initialize orchestrator (loads Agent SDK)
      console.log('Initializing orchestrator...');
      await this.orchestrator.initialize();

      // Connect to Discord
      console.log('Connecting to Discord...');
      await this.discord.connect();

      console.log('Kernel started successfully!');
      console.log('Waiting for messages in #claude-chat...');
    } catch (error) {
      console.error('Failed to start kernel:', error);
      process.exit(1);
    }
  }
}

// Main entry point
const kernel = new Kernel();
kernel.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
