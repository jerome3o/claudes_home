#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

const API_BASE = process.env.CLAUDE_WEB_API || 'http://localhost:8080';

// ============================
// HTTP API Helper
// ============================

async function apiCall(method: string, path: string, body?: any): Promise<any> {
  const url = `${API_BASE}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`API ${method} ${path} failed (${response.status}): ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ============================
// Tool Definitions
// ============================

const tools: Tool[] = [
  // === SESSION TOOLS ===
  {
    name: 'list_sessions',
    description: 'List all agent sessions with their names, IDs, last active timestamps, and SDK session IDs. Use this to discover available sessions and find your own session ID.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_session',
    description: 'Create a new agent session that can be used for communication or task execution.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new session (e.g., "WhatsApp Handler")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to another agent session. If the target session has an active query running, the message will be queued and delivered when the query completes. The message will be prefixed with a "[Message from Agent]" preamble identifying the sender.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Target session ID to send the message to',
        },
        content: {
          type: 'string',
          description: 'Message content to send to the target agent',
        },
        sender_session_id: {
          type: 'string',
          description: 'Your own session ID (for identification in the message preamble)',
        },
        sender_session_name: {
          type: 'string',
          description: 'Your own session name (for identification in the message preamble)',
        },
      },
      required: ['session_id', 'content'],
    },
  },
  {
    name: 'get_session_history',
    description: 'Get recent messages and events from a session. Use "events" format for rich SDK event data (tool use, results, etc.) or "messages" format for simple text messages.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to get history from',
        },
        format: {
          type: 'string',
          enum: ['events', 'messages'],
          description: 'Response format: "events" for SDK events with full detail (default), "messages" for simple role/content pairs',
        },
      },
      required: ['session_id'],
    },
  },

  // === TASK TOOLS ===
  {
    name: 'list_tasks',
    description: 'List all scheduled tasks (cron jobs and webhook-triggered tasks) with their configuration, enabled status, and next run times.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_task',
    description: 'Create a new scheduled task. Can be a cron job (runs on a schedule) or a webhook task (runs when an HTTP endpoint is hit). The task will execute a prompt using the Claude Agent SDK.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable task name (e.g., "Weekly Report", "WhatsApp Relay")',
        },
        type: {
          type: 'string',
          enum: ['cron', 'webhook'],
          description: 'Task type: "cron" for scheduled execution, "webhook" for HTTP-triggered. Defaults to "cron".',
        },
        prompt: {
          type: 'string',
          description: 'The prompt/instructions that will be sent to the Claude agent when the task runs',
        },
        cron_expression: {
          type: 'string',
          description: 'Cron expression for scheduling (5-field format: minute hour day-of-month month day-of-week). Required for cron tasks.',
        },
        timezone: {
          type: 'string',
          description: 'Timezone for the cron schedule (e.g., "Europe/London", "UTC"). Defaults to UTC.',
        },
        session_mode: {
          type: 'string',
          enum: ['new', 'reuse'],
          description: '"new" creates a fresh session each run, "reuse" appends to an existing session. Defaults to "new".',
        },
        session_id: {
          type: 'string',
          description: 'Session ID to reuse when session_mode is "reuse"',
        },
        webhook_path: {
          type: 'string',
          description: 'Custom URL path for webhook tasks (auto-generated if not provided)',
        },
        webhook_secret: {
          type: 'string',
          description: 'Optional Bearer token for webhook authentication',
        },
        model: {
          type: 'string',
          description: 'Claude model to use: "opus", "sonnet", or "haiku". Defaults to "opus".',
        },
        max_turns: {
          type: 'number',
          description: 'Maximum conversation turns. 0 = unlimited. Defaults to 0.',
        },
        max_budget_usd: {
          type: 'number',
          description: 'Maximum budget in USD. 0 = unlimited. Defaults to 0.',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the task is enabled. Defaults to true.',
        },
      },
      required: ['name', 'prompt'],
    },
  },
  {
    name: 'update_task',
    description: 'Update an existing scheduled task. Only provide the fields you want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ID of the task to update',
        },
        name: { type: 'string', description: 'New task name' },
        type: { type: 'string', enum: ['cron', 'webhook'] },
        prompt: { type: 'string', description: 'New prompt/instructions' },
        cron_expression: { type: 'string', description: 'New cron expression' },
        timezone: { type: 'string', description: 'New timezone' },
        session_mode: { type: 'string', enum: ['new', 'reuse'] },
        session_id: { type: 'string' },
        webhook_path: { type: 'string' },
        webhook_secret: { type: 'string' },
        model: { type: 'string' },
        max_turns: { type: 'number' },
        max_budget_usd: { type: 'number' },
        enabled: { type: 'boolean' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a scheduled task. This will also cancel any active cron schedule.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ID of the task to delete',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'run_task',
    description: 'Manually trigger a task to run immediately, regardless of its cron schedule. Returns immediately; the task runs in the background.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ID of the task to run',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_task_runs',
    description: 'Get the execution history for a task, showing recent runs with their status, duration, and any errors.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ID of the task to get run history for',
        },
      },
      required: ['task_id'],
    },
  },

  // === WEBHOOK SUBSCRIPTION TOOLS ===
  {
    name: 'subscribe_webhook',
    description: 'Subscribe a session to receive notifications when a specific webhook path is hit. When the webhook receives data, a formatted message will be delivered to the session (or queued if the session is busy). Multiple sessions can subscribe to the same webhook path.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to subscribe (the session that will receive webhook notifications)',
        },
        webhook_path: {
          type: 'string',
          description: 'Webhook path to subscribe to (e.g., "whatsapp-incoming", "github-events"). The full URL will be POST /hook/{webhook_path}',
        },
      },
      required: ['session_id', 'webhook_path'],
    },
  },
  {
    name: 'unsubscribe_webhook',
    description: 'Remove a webhook subscription for a session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to unsubscribe',
        },
        webhook_path: {
          type: 'string',
          description: 'Webhook path to unsubscribe from',
        },
      },
      required: ['session_id', 'webhook_path'],
    },
  },
  {
    name: 'list_webhook_subscriptions',
    description: 'List all active webhook subscriptions for a session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to list subscriptions for',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_queued_messages',
    description: 'Get pending messages in the queue for a session. Messages are queued when they arrive while the session has an active query running.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session ID to check the queue for',
        },
      },
      required: ['session_id'],
    },
  },

  // === SCHEDULED EVENT TOOLS ===
  {
    name: 'schedule_event',
    description: 'Schedule a one-off event to fire at a future time. Can trigger a task, simulate a webhook, or send a message to a session. Use delay_seconds for relative timing or scheduled_at for absolute timing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name for the event (e.g., "Send morning reminder", "Trigger daily report")',
        },
        type: {
          type: 'string',
          enum: ['task', 'webhook', 'message'],
          description: 'Event type: "task" runs a scheduled task, "webhook" simulates a webhook POST, "message" sends a message to a session',
        },
        scheduled_at: {
          type: 'string',
          description: 'ISO 8601 datetime to fire (e.g., "2025-03-15T10:00:00Z"). Provide either this or delay_seconds.',
        },
        delay_seconds: {
          type: 'number',
          description: 'Seconds from now to fire. Provide either this or scheduled_at.',
        },
        task_id: {
          type: 'string',
          description: 'For type="task": ID of the scheduled task to run',
        },
        webhook_path: {
          type: 'string',
          description: 'For type="webhook": webhook path to deliver to (e.g., "whatsapp-incoming")',
        },
        webhook_data: {
          type: 'object',
          description: 'For type="webhook": JSON payload to deliver',
        },
        session_id: {
          type: 'string',
          description: 'For type="message": target session ID to send the message to',
        },
        message_content: {
          type: 'string',
          description: 'For type="message": the message content to send',
        },
        metadata: {
          type: 'object',
          description: 'Arbitrary JSON metadata to attach to the event',
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'list_events',
    description: 'List scheduled events. By default shows only pending events. Use status="all" to see completed, failed, and cancelled events too.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'all'],
          description: 'Filter: "pending" (default) shows upcoming events only, "all" shows all events including completed/failed/cancelled',
        },
      },
    },
  },
  {
    name: 'get_event',
    description: 'Get full details of a specific scheduled event by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'ID of the event to retrieve',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'update_event',
    description: 'Update a pending scheduled event. Can change the scheduled time, payload, or other fields. Only pending events can be updated.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'ID of the event to update',
        },
        name: { type: 'string', description: 'New name for the event' },
        scheduled_at: { type: 'string', description: 'New ISO 8601 datetime to fire' },
        delay_seconds: { type: 'number', description: 'New delay in seconds from now' },
        task_id: { type: 'string', description: 'New task ID (for task events)' },
        webhook_path: { type: 'string', description: 'New webhook path (for webhook events)' },
        webhook_data: { type: 'object', description: 'New webhook payload (for webhook events)' },
        session_id: { type: 'string', description: 'New session ID (for message events)' },
        message_content: { type: 'string', description: 'New message content (for message events)' },
        metadata: { type: 'object', description: 'New metadata' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'cancel_event',
    description: 'Cancel a pending scheduled event. Only pending events can be cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: {
          type: 'string',
          description: 'ID of the event to cancel',
        },
      },
      required: ['event_id'],
    },
  },
];

// ============================
// Server Setup
// ============================

const server = new Server(
  { name: 'claude-web-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // === SESSION TOOLS ===

      case 'list_sessions': {
        const sessions = await apiCall('GET', '/api/sessions');
        return {
          content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }],
        };
      }

      case 'create_session': {
        const { name: sessionName } = args as { name: string };
        const session = await apiCall('POST', '/api/sessions', { name: sessionName });
        return {
          content: [{ type: 'text', text: JSON.stringify(session, null, 2) }],
        };
      }

      case 'send_message': {
        const {
          session_id,
          content,
          sender_session_id,
          sender_session_name,
        } = args as {
          session_id: string;
          content: string;
          sender_session_id?: string;
          sender_session_name?: string;
        };

        // Format with agent-to-agent preamble
        let formattedContent = content;
        if (sender_session_id || sender_session_name) {
          formattedContent = [
            '[Message from Agent]',
            `You received a message from agent session "${sender_session_name || 'Unknown'}" (ID: ${sender_session_id || 'unknown'}).`,
            '',
            content,
          ].join('\n');
        }

        const result = await apiCall('POST', `/api/sessions/${session_id}/send`, {
          content: formattedContent,
          sender_session_id,
          sender_session_name,
          type: 'agent_message',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_session_history': {
        const { session_id, format } = args as {
          session_id: string;
          format?: string;
        };
        const endpoint =
          format === 'messages'
            ? `/api/sessions/${session_id}/messages`
            : `/api/sessions/${session_id}/events`;
        const data = await apiCall('GET', endpoint);
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      // === TASK TOOLS ===

      case 'list_tasks': {
        const tasks = await apiCall('GET', '/api/tasks');
        return {
          content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }],
        };
      }

      case 'create_task': {
        const taskData = args as Record<string, any>;
        // Convert enabled boolean to integer for the API
        if (typeof taskData.enabled === 'boolean') {
          taskData.enabled = taskData.enabled ? 1 : 0;
        }
        const result = await apiCall('POST', '/api/tasks', taskData);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'update_task': {
        const { task_id, ...updateData } = args as Record<string, any>;
        if (typeof updateData.enabled === 'boolean') {
          updateData.enabled = updateData.enabled ? 1 : 0;
        }
        const result = await apiCall('PUT', `/api/tasks/${task_id}`, updateData);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'delete_task': {
        const { task_id } = args as { task_id: string };
        const result = await apiCall('DELETE', `/api/tasks/${task_id}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'run_task': {
        const { task_id } = args as { task_id: string };
        const result = await apiCall('POST', `/api/tasks/${task_id}/run`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_task_runs': {
        const { task_id } = args as { task_id: string };
        const runs = await apiCall('GET', `/api/tasks/${task_id}/runs`);
        return {
          content: [{ type: 'text', text: JSON.stringify(runs, null, 2) }],
        };
      }

      // === WEBHOOK SUBSCRIPTION TOOLS ===

      case 'subscribe_webhook': {
        const { session_id, webhook_path } = args as {
          session_id: string;
          webhook_path: string;
        };
        const result = await apiCall(
          'POST',
          `/api/sessions/${session_id}/subscribe`,
          { webhook_path }
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ...result,
                  webhook_url: `${API_BASE}/hook/${webhook_path}`,
                  note: 'External services should POST JSON to the webhook_url to deliver messages to this session.',
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'unsubscribe_webhook': {
        const { session_id, webhook_path } = args as {
          session_id: string;
          webhook_path: string;
        };
        const result = await apiCall(
          'DELETE',
          `/api/sessions/${session_id}/subscribe/${webhook_path}`
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'list_webhook_subscriptions': {
        const { session_id } = args as { session_id: string };
        const subs = await apiCall(
          'GET',
          `/api/sessions/${session_id}/subscriptions`
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(subs, null, 2) }],
        };
      }

      case 'get_queued_messages': {
        const { session_id } = args as { session_id: string };
        const data = await apiCall('GET', `/api/sessions/${session_id}/queue`);
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      // === SCHEDULED EVENT TOOLS ===

      case 'schedule_event': {
        const eventData = args as Record<string, any>;
        const result = await apiCall('POST', '/api/events', eventData);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'list_events': {
        const { status } = args as { status?: string };
        const queryParam = status === 'all' ? '' : '?status=pending';
        const events = await apiCall('GET', `/api/events${queryParam}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(events, null, 2) }],
        };
      }

      case 'get_event': {
        const { event_id } = args as { event_id: string };
        const event = await apiCall('GET', `/api/events/${event_id}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(event, null, 2) }],
        };
      }

      case 'update_event': {
        const { event_id, ...updateData } = args as Record<string, any>;
        const result = await apiCall('PUT', `/api/events/${event_id}`, updateData);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'cancel_event': {
        const { event_id } = args as { event_id: string };
        const result = await apiCall('DELETE', `/api/events/${event_id}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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

// ============================
// Start Server
// ============================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Claude Web MCP server started');
  console.error(`API base: ${API_BASE}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
