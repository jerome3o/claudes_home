import express, { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';
import type { Orchestrator } from './orchestrator.js';

export class MCPServer {
  private app: express.Application;
  private server: Server;
  private transport: StreamableHTTPServerTransport | null = null;
  private orchestrator: Orchestrator;
  private httpServer: ReturnType<typeof express.application.listen> | null = null;

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
    this.app = express();
    this.app.use(express.json());

    this.server = new Server(
      {
        name: 'claude-discord-kernel',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupTools();
    this.setupRoutes();
  }

  private setupTools(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'restart_claude',
            description: 'Restart the Claude Code instance. Use when you need a fresh session or have modified configuration files.',
            inputSchema: {
              type: 'object' as const,
              properties: {
                resume: {
                  type: 'boolean',
                  description: 'If true, attempt to resume previous session context',
                },
                message: {
                  type: 'string',
                  description: 'Optional kickoff message for the new instance',
                },
              },
            },
          },
          {
            name: 'get_status',
            description: 'Get the current status of the kernel and Claude instance',
            inputSchema: {
              type: 'object' as const,
              properties: {},
            },
          },
          {
            name: 'get_session_id',
            description: 'Get the current session ID for potential resume',
            inputSchema: {
              type: 'object' as const,
              properties: {},
            },
          },
          {
            name: 'get_system_status',
            description: 'Get comprehensive system status including kernel, MCP servers, Discord, processes, and recent logs',
            inputSchema: {
              type: 'object' as const,
              properties: {},
            },
          },
          {
            name: 'get_logs',
            description: 'Get recent logs from the system',
            inputSchema: {
              type: 'object' as const,
              properties: {
                lines: {
                  type: 'number',
                  description: 'Number of log lines to retrieve (default: 50, max: 500)',
                },
              },
            },
          },
          {
            name: 'reload_mcp_config',
            description: 'Reload MCP server configuration from .mcp.json without full restart',
            inputSchema: {
              type: 'object' as const,
              properties: {},
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'restart_claude': {
          const resume = (args as { resume?: boolean })?.resume ?? false;
          const message = (args as { message?: string })?.message;

          try {
            await this.orchestrator.restart({ resume, message });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: true,
                    message: 'Claude instance restarted successfully',
                    resume,
                    kickoffMessage: message ?? null,
                  }),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        case 'get_status': {
          const status = this.orchestrator.getStatus();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(status),
              },
            ],
          };
        }

        case 'get_session_id': {
          const status = this.orchestrator.getStatus();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  sessionId: status.sessionId ?? null,
                }),
              },
            ],
          };
        }

        case 'get_system_status': {
          const { execSync } = await import('child_process');
          const { readFileSync } = await import('fs');

          try {
            const status = this.orchestrator.getStatus();

            // Get process info
            const npmProcess = execSync('ps aux | grep "npm run dev" | grep -v grep || echo "not found"', { encoding: 'utf-8' });
            const discordProcess = execSync('ps aux | grep "discord-mcp" | grep -v grep || echo "not found"', { encoding: 'utf-8' });

            // Get MCP config
            let mcpConfig: any = {};
            try {
              mcpConfig = JSON.parse(readFileSync('/root/source/claudes_home/.mcp.json', 'utf-8'));
            } catch (e) {
              mcpConfig = { error: 'Could not read .mcp.json' };
            }

            const systemStatus = {
              kernel: {
                uptime: status.uptime,
                sessionId: status.sessionId ?? null,
                state: status.state,
              },
              mcpServers: {
                configured: Object.keys(mcpConfig.mcpServers || {}),
                // Note: Actual connection status would need to be tracked separately
              },
              processes: {
                npm: npmProcess.trim(),
                discord: discordProcess.trim(),
              },
              timestamp: new Date().toISOString(),
            };

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(systemStatus, null, 2),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: error instanceof Error ? error.message : String(error),
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        case 'get_logs': {
          const { execSync } = await import('child_process');
          const lines = (args as { lines?: number })?.lines ?? 50;
          const maxLines = Math.min(lines, 500);

          try {
            // Try to get logs from tmux
            const logs = execSync(
              `tmux capture-pane -t 0:1.1 -p -S -${maxLines} 2>/dev/null || echo "Could not capture tmux logs"`,
              { encoding: 'utf-8' }
            );

            return {
              content: [
                {
                  type: 'text' as const,
                  text: logs,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: error instanceof Error ? error.message : String(error),
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        case 'reload_mcp_config': {
          try {
            this.orchestrator.reloadMcpConfig();
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: true,
                    message: 'MCP configuration reloaded. Note: You may need to restart Claude for changes to take effect.',
                  }),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        default:
          return {
            content: [
              {
                type: 'text' as const,
                text: `Unknown tool: ${name}`,
              },
            ],
            isError: true,
          };
      }
    });
  }

  private setupRoutes(): void {
    // MCP endpoint using Streamable HTTP transport
    this.app.all('/mcp', async (req: Request, res: Response) => {
      // Create transport for this request
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
      });

      // Connect server to transport
      await this.server.connect(transport);

      // Handle the request
      await transport.handleRequest(req, res);
    });

    // Health check endpoint
    this.app.get('/health', (_req: Request, res: Response) => {
      const status = this.orchestrator.getStatus();
      res.json({
        healthy: true,
        ...status,
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = this.app.listen(config.mcpPort, () => {
        console.log(`MCP server listening on http://localhost:${config.mcpPort}/mcp`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      return new Promise((resolve, reject) => {
        this.httpServer!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}
