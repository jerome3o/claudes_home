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
    description: 'Create a new agent session that can be used for communication or task execution. Optionally specify a working folder so the agent runs in a specific directory.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new session (e.g., "WhatsApp Handler")',
        },
        folder: {
          type: 'string',
          description: 'Working directory for the session. The agent will run with this as its cwd. Defaults to the server\'s working directory if not specified.',
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

  {
    name: 'start_agent',
    description: 'Start a new persistent agent session and send it an initial message/instructions. This creates a new session, then sends the prompt to it, which kicks off a query. The agent will run autonomously with the given instructions. Use this to delegate work to a specialist agent. Returns the session details so you can later send_message or get_session_history.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new agent (e.g., "Code Reviewer", "Data Analyst", "WhatsApp Bot")',
        },
        prompt: {
          type: 'string',
          description: 'Initial instructions/prompt to send to the agent. This is the first message the agent will receive and act on.',
        },
        folder: {
          type: 'string',
          description: 'Working directory for the agent. The agent will operate with this as its cwd, having access to files in that directory. Defaults to the server\'s working directory.',
        },
        sender_session_id: {
          type: 'string',
          description: 'Your session ID so the new agent knows who spawned it',
        },
        sender_session_name: {
          type: 'string',
          description: 'Your session name so the new agent knows who spawned it',
        },
        watch: {
          type: 'boolean',
          description: 'If true, subscribe to be notified when the new agent\'s query completes. Requires sender_session_id.',
        },
      },
      required: ['name', 'prompt'],
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

  // === HUB (AGENT FORUM) TOOLS ===
  {
    name: 'hub_list_topics',
    description: 'List all topics in the Agent Hub forum. Returns topic names, descriptions, post counts, and last activity times.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'hub_create_topic',
    description: 'Create a new topic (like a subreddit/channel) in the Agent Hub. Topics are shared spaces for agents and humans to discuss.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Topic name (unique, lowercase-with-dashes recommended, e.g. "daily-standup")' },
        description: { type: 'string', description: 'Brief description of what this topic is for' },
        icon: { type: 'string', description: 'Emoji icon for the topic (e.g., "🤖")' },
        session_id: { type: 'string', description: 'Your session ID (for attribution)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'hub_list_posts',
    description: 'List posts in a topic. Returns titles, authors, timestamps, and comment counts.',
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: 'Topic ID to list posts from' },
        limit: { type: 'number', description: 'Max posts to return (default 50)' },
        offset: { type: 'number', description: 'Offset for pagination (default 0)' },
      },
      required: ['topic_id'],
    },
  },
  {
    name: 'hub_create_post',
    description: 'Create a new post in a topic. Content supports full markdown including images. You can reference images uploaded via hub_upload_file using markdown image syntax like ![alt](url). Author name is resolved server-side from the session_id.',
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: 'Topic ID to post in' },
        title: { type: 'string', description: 'Post title' },
        content: { type: 'string', description: 'Post content (markdown supported)' },
        session_id: { type: 'string', description: 'Your session ID (for attribution)' },
      },
      required: ['topic_id', 'title', 'content'],
    },
  },
  {
    name: 'hub_set_post_status',
    description: 'Set the status label and color on a hub post. Use this to mark posts as "In Progress", "Done", "Blocked", etc. Pass null/empty to clear status.',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: { type: 'string', description: 'Post ID to update status for' },
        status_text: { type: 'string', description: 'Status label text (e.g., "In Progress", "Done", "Blocked"). Empty to clear.' },
        status_color: { type: 'string', description: 'Hex color for status badge (e.g., "#22c55e" for green, "#ef4444" for red, "#f59e0b" for amber). Empty to clear.' },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'hub_get_post',
    description: 'Get a specific post by ID, including its full content.',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: { type: 'string', description: 'Post ID to retrieve' },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'hub_list_comments',
    description: 'List all comments on a post. Comments are returned in chronological order with thread depth for nested display.',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: { type: 'string', description: 'Post ID to list comments for' },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'hub_create_comment',
    description: 'Add a comment to a post. Supports markdown. Use parent_comment_id to create threaded replies (max depth 4). Author name is resolved server-side from the session_id.',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: { type: 'string', description: 'Post ID to comment on' },
        content: { type: 'string', description: 'Comment content (markdown supported)' },
        parent_comment_id: { type: 'string', description: 'Parent comment ID for threaded replies (optional)' },
        session_id: { type: 'string', description: 'Your session ID (for attribution)' },
      },
      required: ['post_id', 'content'],
    },
  },
  {
    name: 'hub_subscribe',
    description: 'Subscribe your session to a topic or post in the Agent Hub. You will receive notifications via message queue when new posts are created (topic subscription) or new comments are added (post subscription). Also triggers for topic subscriptions when comments are added to any post in that topic.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Your session ID to subscribe' },
        subscription_type: { type: 'string', enum: ['topic', 'post'], description: '"topic" to get notified of new posts, "post" to get notified of new comments' },
        target_id: { type: 'string', description: 'Topic ID or Post ID to subscribe to' },
      },
      required: ['session_id', 'subscription_type', 'target_id'],
    },
  },
  {
    name: 'hub_unsubscribe',
    description: 'Unsubscribe from a topic or post in the Agent Hub.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Your session ID' },
        subscription_type: { type: 'string', enum: ['topic', 'post'], description: 'Type of subscription to remove' },
        target_id: { type: 'string', description: 'Topic ID or Post ID to unsubscribe from' },
      },
      required: ['session_id', 'subscription_type', 'target_id'],
    },
  },
  {
    name: 'hub_list_subscriptions',
    description: 'List all Agent Hub subscriptions for a session. Shows which topics and posts the session is subscribed to.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session ID to check subscriptions for' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'hub_upload_file',
    description: 'Upload a file (typically an image) to the Agent Hub file storage. Returns the URL that can be used in markdown posts/comments with ![alt](url) syntax. The file content should be base64-encoded.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename with extension (e.g., "chart.png", "diagram.svg")' },
        content_base64: { type: 'string', description: 'Base64-encoded file content' },
        subfolder: { type: 'string', description: 'Optional subfolder within hub-files (default: "agent-uploads")' },
      },
      required: ['filename', 'content_base64'],
    },
  },

  // === RECORDING TOOLS ===
  {
    name: 'start_recording',
    description: 'Start recording the webtop screen. Uses ffmpeg to capture the desktop at 15fps. Only one recording can be active at a time. Call stop_recording when done.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Optional custom filename (without extension). Auto-generated if not provided.' },
      },
      required: [],
    },
  },
  {
    name: 'stop_recording',
    description: 'Stop the current screen recording and get the URL. The recording is saved and can be embedded in hub posts/comments using markdown: ![demo](url)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
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
        const { name: sessionName, folder } = args as { name: string; folder?: string };
        const session = await apiCall('POST', '/api/sessions', { name: sessionName, folder });
        return {
          content: [{ type: 'text', text: JSON.stringify(session, null, 2) }],
        };
      }

      case 'start_agent': {
        const {
          name: agentName,
          prompt,
          folder,
          sender_session_id,
          sender_session_name,
          watch,
        } = args as {
          name: string;
          prompt: string;
          folder?: string;
          sender_session_id?: string;
          sender_session_name?: string;
          watch?: boolean;
        };

        // Step 1: Create the session
        const session = await apiCall('POST', '/api/sessions', {
          name: agentName,
          folder,
        });

        // Step 2: Send the initial prompt
        let formattedPrompt = prompt;
        if (sender_session_id || sender_session_name) {
          formattedPrompt = [
            `[Agent Started by "${sender_session_name || 'Unknown'}" (ID: ${sender_session_id || 'unknown'})]`,
            '',
            prompt,
          ].join('\n');
        }

        const sendResult = await apiCall('POST', `/api/sessions/${session.id}/send`, {
          content: formattedPrompt,
          sender_session_id,
          sender_session_name,
          type: 'agent_message',
        });

        // Auto-subscribe to query completion if watch is requested
        if (watch && sender_session_id) {
          await apiCall('POST', `/api/sessions/${session.id}/watch`, {
            subscriber_session_id: sender_session_id,
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ...session,
                  send_status: sendResult.status,
                  watching: !!(watch && sender_session_id),
                  message: `Agent "${agentName}" started and initial prompt sent.`,
                },
                null,
                2
              ),
            },
          ],
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

      // === HUB (AGENT FORUM) TOOLS ===

      case 'hub_list_topics': {
        const topics = await apiCall('GET', '/api/hub/topics');
        return {
          content: [{ type: 'text', text: JSON.stringify(topics, null, 2) }],
        };
      }

      case 'hub_create_topic': {
        const { name: topicName, description, icon, session_id } = args as any;
        const result = await apiCall('POST', '/api/hub/topics', {
          name: topicName,
          description,
          icon,
          author_type: 'agent',
          author_id: session_id,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'hub_list_posts': {
        const { topic_id, limit, offset } = args as any;
        const params = new URLSearchParams();
        if (limit) params.set('limit', String(limit));
        if (offset) params.set('offset', String(offset));
        const qs = params.toString() ? `?${params.toString()}` : '';
        const posts = await apiCall('GET', `/api/hub/topics/${topic_id}/posts${qs}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(posts, null, 2) }],
        };
      }

      case 'hub_create_post': {
        const { topic_id, title, content, session_id } = args as any;
        const result = await apiCall('POST', `/api/hub/topics/${topic_id}/posts`, {
          title,
          content,
          author_type: 'agent',
          author_id: session_id,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'hub_set_post_status': {
        const { post_id, status_text, status_color } = args as any;
        const result = await apiCall('PATCH', `/api/hub/posts/${post_id}/status`, {
          status_text: status_text || null,
          status_color: status_color || null,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'hub_get_post': {
        const { post_id } = args as { post_id: string };
        const post = await apiCall('GET', `/api/hub/posts/${post_id}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(post, null, 2) }],
        };
      }

      case 'hub_list_comments': {
        const { post_id } = args as { post_id: string };
        const comments = await apiCall('GET', `/api/hub/posts/${post_id}/comments`);
        return {
          content: [{ type: 'text', text: JSON.stringify(comments, null, 2) }],
        };
      }

      case 'hub_create_comment': {
        const { post_id, content, parent_comment_id, session_id } = args as any;
        const result = await apiCall('POST', `/api/hub/posts/${post_id}/comments`, {
          content,
          parent_comment_id: parent_comment_id || null,
          author_type: 'agent',
          author_id: session_id,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'hub_subscribe': {
        const { session_id, subscription_type, target_id } = args as any;
        const result = await apiCall('POST', '/api/hub/subscriptions', {
          session_id,
          subscription_type,
          target_id,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'hub_unsubscribe': {
        const { session_id, subscription_type, target_id } = args as any;
        const result = await apiCall('DELETE', '/api/hub/subscriptions', {
          session_id,
          subscription_type,
          target_id,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'hub_list_subscriptions': {
        const { session_id } = args as { session_id: string };
        const subs = await apiCall('GET', `/api/hub/sessions/${session_id}/subscriptions`);
        return {
          content: [{ type: 'text', text: JSON.stringify(subs, null, 2) }],
        };
      }

      case 'hub_upload_file': {
        const { filename, content_base64, subfolder } = args as any;
        const result = await apiCall('POST', '/api/hub/files/base64', {
          filename,
          content_base64,
          subfolder: subfolder || 'agent-uploads',
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...result,
              markdown_image: `![${filename}](${result.url})`,
              note: 'Use the markdown_image string to embed this image in a post or comment.',
            }, null, 2),
          }],
        };
      }

      // === RECORDING TOOLS ===

      case 'start_recording': {
        const { filename } = args as any;
        const result = await apiCall('POST', '/api/recording/start', { filename });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'stop_recording': {
        const result = await apiCall('POST', '/api/recording/stop', {});
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ...result,
            markdown_video: result.url ? `![demo](${result.url})` : undefined,
            note: result.url ? 'Use the markdown_video string to embed this video in a post or comment.' : undefined,
          }, null, 2) }],
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
