#!/usr/bin/env node
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, Options as SDKOptions, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Configuration
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
const MCP_CONFIG_FILE = join(DATA_DIR, 'mcp-config.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Session storage
interface SessionInfo {
  id: string;
  name: string;
  created: number;
  lastActive: number;
  folder?: string;
}

interface SessionStore {
  [sessionId: string]: SessionInfo;
}

// Active queries
const activeQueries = new Map<string, Query>();
const sessionConnections = new Map<string, Set<WebSocket>>();

// Load/save sessions
function loadSessions(): SessionStore {
  if (existsSync(SESSIONS_FILE)) {
    try {
      return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  }
  return {};
}

function saveSessions(sessions: SessionStore) {
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// Load/save MCP config
function loadMcpConfig(): Record<string, McpServerConfig> {
  if (existsSync(MCP_CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(MCP_CONFIG_FILE, 'utf-8'));
    } catch (e) {
      console.error('Failed to load MCP config:', e);
    }
  }
  return {};
}

function saveMcpConfig(config: Record<string, McpServerConfig>) {
  writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Serve static files
app.use(express.static(join(__dirname, '../public')));
app.use(express.json());

// API endpoints
app.get('/api/sessions', (req, res) => {
  const sessions = loadSessions();
  res.json(Object.values(sessions));
});

app.post('/api/sessions', (req, res) => {
  const { name, folder } = req.body;
  const sessions = loadSessions();
  const id = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  sessions[id] = {
    id,
    name: name || `Session ${Object.keys(sessions).length + 1}`,
    folder,
    created: Date.now(),
    lastActive: Date.now(),
  };

  saveSessions(sessions);
  res.json(sessions[id]);
});

app.delete('/api/sessions/:id', (req, res) => {
  const sessions = loadSessions();
  delete sessions[req.params.id];
  saveSessions(sessions);
  res.json({ success: true });
});

app.get('/api/mcp-config', (req, res) => {
  res.json(loadMcpConfig());
});

app.post('/api/mcp-config', (req, res) => {
  saveMcpConfig(req.body);
  res.json({ success: true });
});

// WebSocket handling
wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected');

  let currentSessionId: string | null = null;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'start_session':
          await handleStartSession(ws, message);
          currentSessionId = message.sessionId;
          break;

        case 'send_message':
          await handleSendMessage(ws, message);
          break;

        case 'interrupt':
          await handleInterrupt(message.sessionId);
          break;

        case 'set_mcp_servers':
          await handleSetMcpServers(ws, message);
          break;

        default:
          console.log('Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (currentSessionId && sessionConnections.has(currentSessionId)) {
      const connections = sessionConnections.get(currentSessionId)!;
      connections.delete(ws);
      if (connections.size === 0) {
        sessionConnections.delete(currentSessionId);
      }
    }
  });
});

async function handleStartSession(ws: WebSocket, message: any) {
  const { sessionId, resume } = message;

  // Track connection
  if (!sessionConnections.has(sessionId)) {
    sessionConnections.set(sessionId, new Set());
  }
  sessionConnections.get(sessionId)!.add(ws);

  // Update session last active
  const sessions = loadSessions();
  if (sessions[sessionId]) {
    sessions[sessionId].lastActive = Date.now();
    saveSessions(sessions);
  }

  ws.send(JSON.stringify({
    type: 'session_started',
    sessionId,
  }));
}

async function handleSendMessage(ws: WebSocket, message: any) {
  const { sessionId, prompt, resume } = message;

  try {
    // Load MCP config
    const mcpServers = loadMcpConfig();

    // Create query options
    const options: SDKOptions = {
      cwd: process.cwd(),
      mcpServers,
      // Auto-allow all tools (no permission management)
      canUseTool: async (toolName, input) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
    };

    // Resume if session ID provided
    if (resume) {
      options.resume = resume;
    }

    // Create query
    const q = query({ prompt, options });
    activeQueries.set(sessionId, q);

    // Stream events to client
    for await (const event of q) {
      broadcastToSession(sessionId, {
        type: 'sdk_event',
        sessionId,
        event,
      });
    }

    // Query completed
    broadcastToSession(sessionId, {
      type: 'query_completed',
      sessionId,
    });

    activeQueries.delete(sessionId);
  } catch (error) {
    console.error('Error in query:', error);
    broadcastToSession(sessionId, {
      type: 'error',
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    activeQueries.delete(sessionId);
  }
}

async function handleInterrupt(sessionId: string) {
  const q = activeQueries.get(sessionId);
  if (q) {
    await q.interrupt();
    broadcastToSession(sessionId, {
      type: 'interrupted',
      sessionId,
    });
  }
}

async function handleSetMcpServers(ws: WebSocket, message: any) {
  const { sessionId, servers } = message;
  const q = activeQueries.get(sessionId);

  if (q) {
    try {
      const result = await q.setMcpServers(servers);

      // Also save to config file
      saveMcpConfig(servers);

      ws.send(JSON.stringify({
        type: 'mcp_servers_updated',
        sessionId,
        result,
      }));
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function broadcastToSession(sessionId: string, data: any) {
  const connections = sessionConnections.get(sessionId);
  if (connections) {
    const message = JSON.stringify(data);
    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
}

// Start server on all interfaces for Tailscale access
const HOST = '0.0.0.0';
server.listen(Number(PORT), HOST, () => {
  console.log(`Claude Web Frontend running on http://${HOST}:${PORT}`);
  console.log(`Accessible via Tailscale at http://100.110.255.35:${PORT}`);
});
