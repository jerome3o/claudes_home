#!/usr/bin/env node
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, request as httpRequest } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage, Options as SDKOptions, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 }); // 50MB max for image uploads

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
interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  useMarkdown?: boolean;
  status?: string;
}

interface SessionInfo {
  id: string;
  name: string;
  created: number;
  lastActive: number;
  folder?: string;
  messages: SessionMessage[];
  sdkSessionId?: string; // For resumption
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

// Webtop VNC reverse proxy (proxies localhost:3000 through /vnc/)
const VNC_TARGET = 'http://localhost:3000';

app.use('/vnc', (req, res) => {
  const proxyReq = httpRequest(
    `${VNC_TARGET}${req.url}`,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: 'localhost:3000',
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on('error', (err) => {
    console.error('VNC proxy error:', err.message);
    if (!res.headersSent) {
      res.status(502).send('VNC proxy error: Could not connect to webtop');
    }
  });

  req.pipe(proxyReq, { end: true });
});

// Service worker: ensure no HTTP caching so browser always checks for updates
app.get('/service-worker.js', (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Service-Worker-Allowed', '/');
  next();
});

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
    messages: [],
    sdkSessionId: undefined,
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

// Restart webtop container
app.post('/api/webtop/restart', (req, res) => {
  try {
    console.log('Restarting webtop container...');
    // Run restart in background so we can respond immediately
    execSync('docker restart webtop', { timeout: 60000 });
    console.log('Webtop container restarted successfully');
    res.json({ success: true, message: 'Webtop container restarted' });
  } catch (error) {
    console.error('Failed to restart webtop:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get session messages (for loading history)
app.get('/api/sessions/:id/messages', (req, res) => {
  const sessions = loadSessions();
  const session = sessions[req.params.id];

  if (session) {
    res.json({ messages: session.messages || [], sdkSessionId: session.sdkSessionId });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
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

        case 'client_log': {
          const levelMap: Record<string, string> = { log: 'LOG', warn: 'WARN', error: 'ERROR', info: 'INFO' };
          const prefix = levelMap[message.level] || 'LOG';
          console.log(`[CLIENT ${prefix}] ${message.message}`);
          break;
        }

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
  const { sessionId, prompt, resume, images } = message;

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

    // Build prompt — string for text-only, AsyncIterable<SDKUserMessage> for multimodal
    let queryPrompt: string | AsyncIterable<SDKUserMessage>;

    if (images && Array.isArray(images) && images.length > 0) {
      // Multimodal message with images
      const contentBlocks: any[] = [
        ...images.map((img: { data: string; mediaType: string }) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: img.data,
          },
        })),
        { type: 'text' as const, text: prompt || 'What do you see in this image?' },
      ];

      queryPrompt = (async function* () {
        yield {
          type: 'user' as const,
          message: {
            role: 'user' as const,
            content: contentBlocks,
          },
          parent_tool_use_id: null,
          session_id: '',
        } as SDKUserMessage;
      })();

      console.log(`Sending multimodal message with ${images.length} image(s)`);
    } else {
      queryPrompt = prompt;
    }

    // Create query
    const q = query({ prompt: queryPrompt, options });
    activeQueries.set(sessionId, q);

    // Stream events to client with error handling
    try {
      for await (const event of q) {
        broadcastToSession(sessionId, {
          type: 'sdk_event',
          sessionId,
          event,
        });
      }

      // Query completed successfully
      broadcastToSession(sessionId, {
        type: 'query_completed',
        sessionId,
      });
    } catch (iterError) {
      console.error('Error during query iteration:', iterError);
      broadcastToSession(sessionId, {
        type: 'error',
        sessionId,
        error: iterError instanceof Error ? iterError.message : String(iterError),
      });
    } finally {
      // Always clean up the active query
      activeQueries.delete(sessionId);
    }
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

function saveSessionMessage(sessionId: string, message: SessionMessage) {
  const sessions = loadSessions();
  if (sessions[sessionId]) {
    if (!sessions[sessionId].messages) {
      sessions[sessionId].messages = [];
    }
    sessions[sessionId].messages.push(message);
    sessions[sessionId].lastActive = Date.now();
    saveSessions(sessions);
  }
}

function saveSdkSessionId(sessionId: string, sdkSessionId: string) {
  const sessions = loadSessions();
  if (sessions[sessionId]) {
    sessions[sessionId].sdkSessionId = sdkSessionId;
    saveSessions(sessions);
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

  // Save messages to session history
  if (data.type === 'sdk_event' && data.event) {
    const event = data.event;

    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      // Save SDK session ID for resumption
      saveSdkSessionId(sessionId, event.session_id);
    } else if (event.type === 'user' && !event.isSynthetic && event.message) {
      // Save user message
      const content = extractMessageContent(event.message);
      if (content) {
        saveSessionMessage(sessionId, {
          role: 'user',
          content,
          timestamp: Date.now(),
        });
      }
    } else if (event.type === 'assistant' && event.message) {
      // Save assistant message (text blocks only)
      const content = extractMessageContent(event.message);
      if (content) {
        saveSessionMessage(sessionId, {
          role: 'assistant',
          content,
          timestamp: Date.now(),
          useMarkdown: true,
        });
      }
    }
  }
}

function extractMessageContent(message: any): string {
  if (!message || !message.content) return '';

  if (Array.isArray(message.content)) {
    return message.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n');
  }

  return String(message.content);
}

// Handle WebSocket upgrades - route VNC websockets to webtop, others to our WSS
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';

  if (url.startsWith('/vnc/')) {
    // Proxy WebSocket to webtop VNC
    const targetPath = url.replace('/vnc', '') || '/';
    const proxyWs = httpRequest({
      hostname: 'localhost',
      port: 3000,
      path: targetPath,
      method: 'GET',
      headers: {
        ...req.headers,
        host: 'localhost:3000',
      },
    });

    proxyWs.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      // Send the 101 Switching Protocols response back to client
      let responseHeaders = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value) responseHeaders += `${key}: ${value}\r\n`;
      }
      responseHeaders += '\r\n';
      socket.write(responseHeaders);

      // Write any buffered data
      if (proxyHead && proxyHead.length > 0) {
        socket.write(proxyHead);
      }

      // Pipe data bidirectionally
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
      proxySocket.on('close', () => socket.destroy());
      socket.on('close', () => proxySocket.destroy());
    });

    proxyWs.on('error', (err) => {
      console.error('VNC WebSocket proxy error:', err.message);
      socket.destroy();
    });

    proxyWs.end();
  } else {
    // Handle normal Claude WebSocket connections
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

// Start server on all interfaces for Tailscale access
const HOST = '0.0.0.0';
server.listen(Number(PORT), HOST, () => {
  console.log(`Claude Web Frontend running on http://${HOST}:${PORT}`);
  console.log(`Accessible via Tailscale at http://100.110.255.35:${PORT}`);
});
