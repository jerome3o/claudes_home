import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const SESSION_FILE = '.claude-session';
import type {
  OrchestratorState,
  OrchestratorEvents,
  KernelStatus,
  RestartOptions,
} from '../types.js';

// Import SDK types
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  Query,
  Options,
} from '@anthropic-ai/claude-agent-sdk';

// MCP server config types (matching SDK expectations)
type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
} | {
  type: 'http';
  url: string;
} | {
  type: 'sse';
  url: string;
};

type McpJsonConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

// Store SDK function
let queryFn: ((params: { prompt: string; options?: Options }) => Query) | null = null;

/**
 * Load session ID from file
 * Returns null if file doesn't exist or has errors
 */
function loadSessionId(cwd: string): string | null {
  const sessionFile = join(cwd, SESSION_FILE);

  if (!existsSync(sessionFile)) {
    console.log('[orchestrator] No saved session found');
    return null;
  }

  try {
    const sessionId = readFileSync(sessionFile, 'utf-8').trim();
    if (sessionId) {
      console.log('[orchestrator] Loaded saved session:', sessionId);
      return sessionId;
    }
    return null;
  } catch (error) {
    console.error('[orchestrator] Failed to load session file:', error);
    return null;
  }
}

/**
 * Save session ID to file
 */
function saveSessionId(cwd: string, sessionId: string): void {
  const sessionFile = join(cwd, SESSION_FILE);

  try {
    writeFileSync(sessionFile, sessionId, 'utf-8');
    console.log('[orchestrator] Saved session:', sessionId);
  } catch (error) {
    console.error('[orchestrator] Failed to save session file:', error);
  }
}

/**
 * Clear saved session file
 */
function clearSessionFile(cwd: string): void {
  const sessionFile = join(cwd, SESSION_FILE);

  try {
    if (existsSync(sessionFile)) {
      unlinkSync(sessionFile);
      console.log('[orchestrator] Cleared saved session file');
    }
  } catch (error) {
    console.error('[orchestrator] Failed to clear session file:', error);
  }
}

/**
 * Load MCP servers from .mcp.json file
 * Returns empty object if file doesn't exist or has errors
 */
function loadMcpConfig(cwd: string): Record<string, McpServerConfig> {
  const mcpJsonPath = join(cwd, '.mcp.json');

  if (!existsSync(mcpJsonPath)) {
    console.log('[orchestrator] No .mcp.json found at', mcpJsonPath);
    return {};
  }

  try {
    const content = readFileSync(mcpJsonPath, 'utf-8');
    const config: McpJsonConfig = JSON.parse(content);

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      console.log('[orchestrator] .mcp.json has no mcpServers field');
      return {};
    }

    const serverCount = Object.keys(config.mcpServers).length;
    console.log(`[orchestrator] Loaded ${serverCount} MCP server(s) from .mcp.json:`, Object.keys(config.mcpServers));
    return config.mcpServers;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error('[orchestrator] Failed to parse .mcp.json - invalid JSON:', error.message);
    } else {
      console.error('[orchestrator] Failed to load .mcp.json:', error);
    }
    return {};
  }
}

async function loadAgentSDK(): Promise<void> {
  try {
    console.log('[orchestrator] Loading Agent SDK...');
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    console.log('[orchestrator] SDK module keys:', Object.keys(sdk));

    if ('query' in sdk && typeof sdk.query === 'function') {
      queryFn = sdk.query;
      console.log('[orchestrator] Agent SDK V1 API loaded successfully');
    } else {
      throw new Error('Agent SDK query function not found');
    }
  } catch (error) {
    console.error('[orchestrator] Failed to load Agent SDK:', error);
    throw error;
  }
}

export interface Orchestrator {
  on<E extends keyof OrchestratorEvents>(
    event: E,
    listener: OrchestratorEvents[E]
  ): this;
  emit<E extends keyof OrchestratorEvents>(
    event: E,
    ...args: Parameters<OrchestratorEvents[E]>
  ): boolean;
}

export class Orchestrator extends EventEmitter {
  private state: OrchestratorState = 'idle';
  private sessionId: string | null = null;
  private currentQuery: Query | null = null;
  private startTime: number = Date.now();
  private cwd: string;
  private queuedMessage: string | null = null;
  private mcpServers: Record<string, McpServerConfig> = {};

  constructor(cwd: string = process.cwd()) {
    super();
    this.cwd = cwd;
  }

  async initialize(): Promise<void> {
    await loadAgentSDK();
    this.mcpServers = loadMcpConfig(this.cwd);
    // Try to resume previous session if one was saved
    this.sessionId = loadSessionId(this.cwd);
  }

  /**
   * Reload MCP config from .mcp.json (useful after config changes)
   */
  reloadMcpConfig(): void {
    this.mcpServers = loadMcpConfig(this.cwd);
  }

  getState(): OrchestratorState {
    return this.state;
  }

  getStatus(): KernelStatus {
    return {
      state: this.state,
      sessionId: this.sessionId ?? undefined,
      uptime: Date.now() - this.startTime,
    };
  }

  private setState(newState: OrchestratorState): void {
    const oldState = this.state;
    this.state = newState;
    if (oldState !== newState) {
      this.emit('stateChange', newState);
    }
  }

  /**
   * Check if there's a queued message waiting
   */
  hasQueuedMessage(): boolean {
    return this.queuedMessage !== null;
  }

  /**
   * Queue a message to be sent after current task completes
   */
  queueMessage(message: string): void {
    this.queuedMessage = message;
    console.log('Message queued for after current task completes');
  }

  /**
   * Interrupt current execution
   */
  async interrupt(): Promise<void> {
    if (this.currentQuery) {
      console.log('Interrupting current query...');
      try {
        await this.currentQuery.interrupt();
      } catch (error) {
        console.error('Error during interrupt:', error);
      }
      this.currentQuery = null;
    }
    this.setState('idle');
  }

  /**
   * Send a message to Claude and stream the response
   */
  async send(message: string): Promise<void> {
    if (!queryFn) {
      throw new Error('Agent SDK not loaded');
    }

    if (this.state === 'running') {
      // Queue message for later
      this.queueMessage(message);
      return;
    }

    this.setState('running');

    try {
      console.log('[orchestrator] Creating query with prompt:', message.substring(0, 100) + '...');
      console.log('[orchestrator] Session:', this.sessionId ? `resuming ${this.sessionId}` : 'new session');
      console.log('[orchestrator] MCP servers:', Object.keys(this.mcpServers).length > 0 ? Object.keys(this.mcpServers) : 'none');
      console.log('[orchestrator] ENV check - ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET');

      this.currentQuery = queryFn({
        prompt: message,
        options: {
          cwd: this.cwd,
          settingSources: ['project', 'local'],
          // Load MCP servers from .mcp.json
          ...(Object.keys(this.mcpServers).length > 0 ? { mcpServers: this.mcpServers } : {}),
          // Resume existing session if we have one
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          // Auto-approve all tool uses programmatically (works even as root)
          canUseTool: async (toolName, input, _options) => {
            console.log(`[orchestrator] Auto-allowing tool: ${toolName}`);
            return {
              behavior: 'allow' as const,
              updatedInput: input,
            };
          },
          stderr: (msg: string) => {
            console.log('[orchestrator] STDERR:', msg);
          },
        },
      });

      console.log('[orchestrator] Query created, starting iteration...');
      let eventCount = 0;
      for await (const event of this.currentQuery) {
        eventCount++;
        console.log(`[orchestrator] Event #${eventCount}: type=${event.type}, subtype=${'subtype' in event ? event.subtype : 'n/a'}`);
        await this.processStreamEvent(event);
      }
      console.log(`[orchestrator] Query completed, processed ${eventCount} events`);

      this.currentQuery = null;
    } catch (error) {
      console.error('[orchestrator] Query error:', error);
      console.error('[orchestrator] Error stack:', error instanceof Error ? error.stack : 'no stack');
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.setState('idle');

      // Process queued message if any
      if (this.queuedMessage) {
        const queued = this.queuedMessage;
        this.queuedMessage = null;
        // Small delay before processing queued message
        await new Promise(resolve => setTimeout(resolve, 100));
        await this.send(queued);
      }
    }
  }

  /**
   * Process a single stream event
   */
  private async processStreamEvent(event: SDKMessage): Promise<void> {
    switch (event.type) {
      case 'system': {
        const sysMsg = event as SDKSystemMessage;
        if (sysMsg.subtype === 'init') {
          this.sessionId = sysMsg.session_id;
          // Persist session ID for server restarts
          saveSessionId(this.cwd, this.sessionId);
          console.log(`[orchestrator] Session initialized: ${this.sessionId}`);
          console.log(`[orchestrator] Tools: ${sysMsg.tools.join(', ')}`);
          console.log(`[orchestrator] MCP servers: ${sysMsg.mcp_servers.map(s => `${s.name}(${s.status})`).join(', ')}`);
        }
        break;
      }

      case 'assistant': {
        const assistantMsg = event as SDKAssistantMessage;
        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            await this.processContentBlock(block);
          }
        }
        break;
      }

      case 'result': {
        const resultMsg = event as SDKResultMessage;
        if (resultMsg.subtype === 'success') {
          this.emit('result', resultMsg.result);
        } else {
          // Error result
          const errors = 'errors' in resultMsg ? resultMsg.errors : [];
          this.emit('error', new Error(errors.join(', ') || 'Unknown error'));
        }
        break;
      }

      case 'user': {
        // Tool results
        const userMsg = event;
        if ('message' in userMsg && userMsg.message && 'content' in userMsg.message) {
          const content = userMsg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block && 'type' in block && block.type === 'tool_result') {
                const toolResult = block as { tool_use_id: string; content?: unknown };
                this.emit('tool_result', {
                  id: toolResult.tool_use_id,
                  content: toolResult.content,
                });
              }
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Process a content block from assistant message
   */
  private async processContentBlock(block: unknown): Promise<void> {
    if (typeof block !== 'object' || !block) return;

    const typedBlock = block as { type: string; text?: string; id?: string; name?: string; input?: unknown };

    if (typedBlock.type === 'text' && typedBlock.text) {
      this.emit('text', typedBlock.text);
    } else if (typedBlock.type === 'tool_use') {
      this.emit('tool_use', {
        id: typedBlock.id || '',
        name: typedBlock.name || '',
        input: typedBlock.input,
      });
    }
  }

  /**
   * Restart (clear state and optionally send a new message)
   */
  async restart(options: RestartOptions = {}): Promise<void> {
    console.log('[orchestrator] Restarting...', options);

    // Interrupt any current query
    await this.interrupt();

    // Clear session to start fresh
    this.sessionId = null;
    this.queuedMessage = null;
    clearSessionFile(this.cwd);

    // Reload MCP config in case it changed
    this.reloadMcpConfig();
    this.setState('idle');

    console.log('[orchestrator] Session cleared, ready for new conversation');

    // Send kickoff message if provided
    if (options.message) {
      await this.send(options.message);
    }
  }

  /**
   * Clean shutdown
   */
  async shutdown(): Promise<void> {
    console.log('Shutting down orchestrator...');
    await this.interrupt();
    this.setState('idle');
  }
}
