#!/usr/bin/env node
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, request as httpRequest } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import multer from 'multer';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage, Options as SDKOptions, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 }); // 50MB max for image uploads

// Configuration
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const DB_FILE = join(DATA_DIR, 'claude.db');
const MCP_CONFIG_FILE = join(DATA_DIR, 'mcp-config.json');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json'); // For migration

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// ============================
// SQLite Database Setup
// ============================
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT,
    created INTEGER NOT NULL,
    lastActive INTEGER NOT NULL,
    sdkSessionId TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    useMarkdown INTEGER DEFAULT 0,
    status TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp);
`);

// Migrate from JSON if old sessions.json exists and DB is empty
function migrateFromJson() {
  const sessionCount = (db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as any).cnt;
  if (sessionCount > 0) return; // Already have data

  if (!existsSync(SESSIONS_FILE)) return;

  console.log('Migrating sessions from JSON to SQLite...');
  try {
    const oldData = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    const insertSession = db.prepare(
      'INSERT OR IGNORE INTO sessions (id, name, folder, created, lastActive, sdkSessionId) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertMessage = db.prepare(
      'INSERT INTO messages (session_id, role, content, timestamp, useMarkdown, status) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const migrate = db.transaction(() => {
      for (const [id, session] of Object.entries(oldData) as [string, any][]) {
        insertSession.run(
          session.id || id,
          session.name || 'Untitled',
          session.folder || null,
          session.created || Date.now(),
          session.lastActive || Date.now(),
          session.sdkSessionId || null
        );

        if (session.messages && Array.isArray(session.messages)) {
          for (const msg of session.messages) {
            insertMessage.run(
              session.id || id,
              msg.role,
              msg.content,
              msg.timestamp || Date.now(),
              msg.useMarkdown ? 1 : 0,
              msg.status || null
            );
          }
        }
      }
    });

    migrate();
    console.log(`Migration complete: ${Object.keys(oldData).length} sessions migrated`);
  } catch (e) {
    console.error('Migration failed:', e);
  }
}

migrateFromJson();

// ============================
// Database helper functions
// ============================
const stmts = {
  getAllSessions: db.prepare(
    'SELECT id, name, folder, created, lastActive, sdkSessionId FROM sessions ORDER BY lastActive DESC'
  ),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  createSession: db.prepare(
    'INSERT INTO sessions (id, name, folder, created, lastActive, sdkSessionId) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  renameSession: db.prepare('UPDATE sessions SET name = ? WHERE id = ?'),
  updateLastActive: db.prepare('UPDATE sessions SET lastActive = ? WHERE id = ?'),
  updateSdkSessionId: db.prepare('UPDATE sessions SET sdkSessionId = ? WHERE id = ?'),
  getMessages: db.prepare(
    'SELECT role, content, timestamp, useMarkdown, status FROM messages WHERE session_id = ? ORDER BY timestamp ASC'
  ),
  insertMessage: db.prepare(
    'INSERT INTO messages (session_id, role, content, timestamp, useMarkdown, status) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getMessageCount: db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?'),
};

// Session interfaces (for type safety)
interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  useMarkdown?: boolean | number;
  status?: string;
}

// Active queries and connections
const activeQueries = new Map<string, Query>();
const sessionConnections = new Map<string, Set<WebSocket>>();
// Track ALL connected websockets for cross-session notifications
const allConnections = new Set<WebSocket>();
// Disconnect timers: abort orphaned queries after grace period
const disconnectTimers = new Map<string, NodeJS.Timeout>();
const DISCONNECT_GRACE_MS = 10_000; // 10 seconds before aborting orphaned query

// ============================
// Query lifecycle helpers
// ============================

/** Start a disconnect timer for a session — aborts the query after grace period */
function startDisconnectTimer(sessionId: string) {
  // Don't start if there's no active query
  if (!activeQueries.has(sessionId)) return;
  // Don't start if there are still connected clients
  const conns = sessionConnections.get(sessionId);
  if (conns && conns.size > 0) return;
  // Don't restart if timer already running
  if (disconnectTimers.has(sessionId)) return;

  console.log(`[lifecycle] Starting ${DISCONNECT_GRACE_MS}ms disconnect timer for session ${sessionId}`);
  const timer = setTimeout(() => {
    disconnectTimers.delete(sessionId);
    const q = activeQueries.get(sessionId);
    if (q) {
      console.log(`[lifecycle] Aborting orphaned query for session ${sessionId}`);
      try { q.close(); } catch (e) { console.error('[lifecycle] Error closing query:', e); }
      activeQueries.delete(sessionId);
    }
  }, DISCONNECT_GRACE_MS);
  disconnectTimers.set(sessionId, timer);
}

/** Cancel a disconnect timer (client reconnected in time) */
function cancelDisconnectTimer(sessionId: string) {
  const timer = disconnectTimers.get(sessionId);
  if (timer) {
    console.log(`[lifecycle] Cancelled disconnect timer for session ${sessionId} (client reconnected)`);
    clearTimeout(timer);
    disconnectTimers.delete(sessionId);
  }
}

// ============================
// Load/save MCP config (still file-based — small config)
// ============================
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

// ============================
// Webtop VNC reverse proxy
// ============================
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

// ============================
// API endpoints
// ============================
app.get('/api/sessions', (req, res) => {
  const sessions = stmts.getAllSessions.all();
  res.json(sessions);
});

app.post('/api/sessions', (req, res) => {
  const { name, folder } = req.body;
  const id = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = Date.now();
  const sessionName = name || `Session ${(stmts.getAllSessions.all() as any[]).length + 1}`;

  stmts.createSession.run(id, sessionName, folder || null, now, now, null);

  res.json({
    id,
    name: sessionName,
    folder: folder || null,
    created: now,
    lastActive: now,
    sdkSessionId: null,
  });
});

app.delete('/api/sessions/:id', (req, res) => {
  stmts.deleteSession.run(req.params.id);
  res.json({ success: true });
});

app.patch('/api/sessions/:id', (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Name is required' });
    return;
  }
  stmts.renameSession.run(name, req.params.id);
  res.json({ success: true, name });
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

// ============================
// File Browser API
// ============================
const FILE_ROOT = process.env.FILE_ROOT || '/root/source/claudes_home';

// Multer for file uploads
const upload = multer({ dest: '/tmp/claude-web-uploads/', limits: { fileSize: 50 * 1024 * 1024 } });

function safePath(requestedPath: string): string {
  // Resolve to absolute, ensure within FILE_ROOT
  const resolved = join(FILE_ROOT, requestedPath.replace(/\.\./g, ''));
  if (!resolved.startsWith(FILE_ROOT)) return FILE_ROOT;
  return resolved;
}

app.get('/api/files', (req, res) => {
  const dirPath = safePath((req.query.path as string) || '/');
  try {
    if (!existsSync(dirPath)) {
      res.status(404).json({ error: 'Path not found' });
      return;
    }
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Not a directory' });
      return;
    }
    const entries = readdirSync(dirPath).map(name => {
      try {
        const fullPath = join(dirPath, name);
        const s = statSync(fullPath);
        return {
          name,
          isDir: s.isDirectory(),
          size: s.size,
          modified: s.mtimeMs,
        };
      } catch {
        return { name, isDir: false, size: 0, modified: 0 };
      }
    });
    // Sort: dirs first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    // Relative path from FILE_ROOT
    const relPath = dirPath.replace(FILE_ROOT, '') || '/';
    res.json({ path: relPath, entries });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/files/download', (req, res) => {
  const filePath = safePath((req.query.path as string) || '');
  try {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.download(filePath);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/files/upload', upload.array('files', 20), (req, res) => {
  const targetDir = safePath((req.body.path as string) || '/');
  try {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No files provided' });
      return;
    }
    for (const file of files) {
      const dest = join(targetDir, file.originalname);
      const data = readFileSync(file.path);
      writeFileSync(dest, data);
      unlinkSync(file.path); // cleanup temp
    }
    res.json({ success: true, count: files.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/files', (req, res) => {
  const filePath = safePath((req.query.path as string) || '');
  try {
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const s = statSync(filePath);
    if (s.isDirectory()) {
      execSync(`rm -rf ${JSON.stringify(filePath)}`);
    } else {
      unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Read file content (text or binary info)
app.get('/api/files/read', (req, res) => {
  const filePath = safePath((req.query.path as string) || '');
  try {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const stat = statSync(filePath);
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    // Image types — serve raw with correct content-type
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'];
    if (imageExts.includes(ext)) {
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        ico: 'image/x-icon', bmp: 'image/bmp',
      };
      res.json({ type: 'image', mime: mimeMap[ext] || 'image/png', size: stat.size });
      return;
    }

    // Video types
    const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'mkv'];
    if (videoExts.includes(ext)) {
      const mimeMap: Record<string, string> = {
        mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg',
        mov: 'video/quicktime', mkv: 'video/x-matroska',
      };
      res.json({ type: 'video', mime: mimeMap[ext] || 'video/mp4', size: stat.size });
      return;
    }

    // Audio types
    const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
    if (audioExts.includes(ext)) {
      res.json({ type: 'audio', size: stat.size });
      return;
    }

    // Binary check — if file is too large or has binary content, don't send text
    const MAX_TEXT_SIZE = 2 * 1024 * 1024; // 2MB
    if (stat.size > MAX_TEXT_SIZE) {
      res.json({ type: 'binary', size: stat.size, reason: 'File too large to edit' });
      return;
    }

    // Try reading as UTF-8 text
    const content = readFileSync(filePath, 'utf-8');

    // Simple binary check — look for null bytes
    if (content.includes('\0')) {
      res.json({ type: 'binary', size: stat.size });
      return;
    }

    res.json({ type: 'text', content, size: stat.size });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Write/save file content
app.put('/api/files/write', (req, res) => {
  const filePath = safePath((req.body.path as string) || '');
  const content = req.body.content;
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'Content must be a string' });
    return;
  }
  try {
    writeFileSync(filePath, content, 'utf-8');
    res.json({ success: true, size: Buffer.byteLength(content, 'utf-8') });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Serve raw file (for images/videos in the viewer)
app.get('/api/files/raw', (req, res) => {
  const filePath = safePath((req.query.path as string) || '');
  try {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ============================
// System Status API
// ============================
app.get('/api/system-status', (req, res) => {
  try {
    // Git status
    let gitStatus = { branch: '', dirty: 0, untracked: 0 };
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: FILE_ROOT, timeout: 3000 }).toString().trim();
      const statusOut = execSync('git status --porcelain', { cwd: FILE_ROOT, timeout: 3000 }).toString().trim();
      const lines = statusOut ? statusOut.split('\n') : [];
      const dirty = lines.filter(l => !l.startsWith('??')).length;
      const untracked = lines.filter(l => l.startsWith('??')).length;
      gitStatus = { branch, dirty, untracked };
    } catch { /* not a git repo or git not available */ }

    // CPU load average
    let load = [0, 0, 0];
    try {
      const loadStr = readFileSync('/proc/loadavg', 'utf-8');
      const parts = loadStr.split(' ');
      load = [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])];
    } catch {}

    // Memory
    let memUsed = 0;
    let memTotal = 0;
    try {
      const memInfo = readFileSync('/proc/meminfo', 'utf-8');
      const totalMatch = memInfo.match(/MemTotal:\s+(\d+)/);
      const availMatch = memInfo.match(/MemAvailable:\s+(\d+)/);
      if (totalMatch && availMatch) {
        memTotal = Math.round(parseInt(totalMatch[1]) / 1024); // MB
        memUsed = memTotal - Math.round(parseInt(availMatch[1]) / 1024);
      }
    } catch {}

    // Active queries
    const queries = activeQueries.size;

    // Disk usage of data dir
    let diskUsage = '';
    try {
      diskUsage = execSync(`du -sh ${JSON.stringify(DATA_DIR)} 2>/dev/null`, { timeout: 3000 }).toString().split('\t')[0].trim();
    } catch {}

    // Uptime
    let uptime = 0;
    try {
      uptime = parseFloat(readFileSync('/proc/uptime', 'utf-8').split(' ')[0]);
    } catch {}

    res.json({
      git: gitStatus,
      load,
      mem: { used: memUsed, total: memTotal },
      queries,
      diskUsage,
      uptime: Math.round(uptime),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get session query status (for reconnect state sync)
app.get('/api/sessions/:id/status', (req, res) => {
  const session = stmts.getSession.get(req.params.id) as any;
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({
    activeQuery: activeQueries.has(req.params.id),
  });
});

// Pre-save user message via REST (Batch 4: durability — fire-and-forget from client)
app.post('/api/sessions/:id/messages', (req, res) => {
  const { content, timestamp } = req.body;
  if (!content) {
    res.status(400).json({ error: 'Content is required' });
    return;
  }

  const session = stmts.getSession.get(req.params.id) as any;
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // Dedup: skip if identical message exists within last 5 seconds
  const recentDup = db.prepare(
    'SELECT id FROM messages WHERE session_id = ? AND role = ? AND content = ? AND timestamp > ?'
  ).get(req.params.id, 'user', content, (timestamp || Date.now()) - 5000);

  if (recentDup) {
    res.json({ success: true, deduplicated: true });
    return;
  }

  stmts.insertMessage.run(req.params.id, 'user', content, timestamp || Date.now(), 0, null);
  stmts.updateLastActive.run(Date.now(), req.params.id);
  res.json({ success: true, deduplicated: false });
});

// Get session messages (for loading history)
app.get('/api/sessions/:id/messages', (req, res) => {
  const session = stmts.getSession.get(req.params.id) as any;

  if (session) {
    const messages = stmts.getMessages.all(req.params.id) as SessionMessage[];
    // Convert useMarkdown from integer to boolean for client
    const formatted = messages.map(m => ({
      ...m,
      useMarkdown: !!m.useMarkdown,
    }));
    res.json({ messages: formatted, sdkSessionId: session.sdkSessionId });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ============================
// WebSocket handling
// ============================

// Heartbeat: ping all clients every 30s, terminate zombies
const HEARTBEAT_INTERVAL_MS = 30_000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws: WebSocket & { isAlive?: boolean }) => {
    if (ws.isAlive === false) {
      console.log('[heartbeat] Terminating unresponsive client');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

wss.on('connection', (ws: WebSocket & { isAlive?: boolean }) => {
  console.log('Client connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  allConnections.add(ws);

  let currentSessionId: string | null = null;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'start_session': {
          const oldSessionId = currentSessionId;
          // Remove from old session connections
          if (currentSessionId && sessionConnections.has(currentSessionId)) {
            const oldConns = sessionConnections.get(currentSessionId)!;
            oldConns.delete(ws);
            if (oldConns.size === 0) {
              sessionConnections.delete(currentSessionId);
              // Batch 1B: start disconnect timer for old session on switch
              startDisconnectTimer(currentSessionId);
            }
          }
          currentSessionId = message.sessionId;
          // Cancel any disconnect timer for the session we're joining
          cancelDisconnectTimer(message.sessionId);
          await handleStartSession(ws, message);
          break;
        }

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
    allConnections.delete(ws);
    if (currentSessionId && sessionConnections.has(currentSessionId)) {
      const connections = sessionConnections.get(currentSessionId)!;
      connections.delete(ws);
      if (connections.size === 0) {
        sessionConnections.delete(currentSessionId);
        // Batch 1A: start disconnect timer — abort orphaned query after grace period
        startDisconnectTimer(currentSessionId);
      }
    }
  });
});

async function handleStartSession(ws: WebSocket, message: any) {
  const { sessionId } = message;

  // Cancel disconnect timer — client reconnected
  cancelDisconnectTimer(sessionId);

  // Track connection
  if (!sessionConnections.has(sessionId)) {
    sessionConnections.set(sessionId, new Set());
  }
  sessionConnections.get(sessionId)!.add(ws);

  // Update session last active
  stmts.updateLastActive.run(Date.now(), sessionId);

  ws.send(JSON.stringify({
    type: 'session_started',
    sessionId,
    activeQuery: activeQueries.has(sessionId), // Tell client if a query is running
  }));
}

async function handleSendMessage(ws: WebSocket, message: any) {
  const { sessionId, prompt, resume, images } = message;

  try {
    // Batch 1C: Prevent query overwrite — close existing query before starting new one
    const existingQuery = activeQueries.get(sessionId);
    if (existingQuery) {
      console.log(`[lifecycle] Closing existing query for session ${sessionId} before starting new one`);
      try { existingQuery.close(); } catch (e) { console.error('[lifecycle] Error closing existing query:', e); }
      activeQueries.delete(sessionId);
    }

    // Cancel any pending disconnect timer (we're actively using this session)
    cancelDisconnectTimer(sessionId);

    // Save user message immediately (don't rely on SDK echo)
    // Dedup: skip if identical message was pre-saved via REST within last 5s
    if (prompt) {
      const recentDup = db.prepare(
        'SELECT id FROM messages WHERE session_id = ? AND role = ? AND content = ? AND timestamp > ?'
      ).get(sessionId, 'user', prompt, Date.now() - 5000);

      if (!recentDup) {
        stmts.insertMessage.run(sessionId, 'user', prompt, Date.now(), 0, null);
      }
      stmts.updateLastActive.run(Date.now(), sessionId);
    }

    // Load MCP config
    const mcpServers = loadMcpConfig();

    // Create query options
    const options: SDKOptions = {
      cwd: process.cwd(),
      mcpServers,
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

      // Query completed — notify session subscribers
      broadcastToSession(sessionId, {
        type: 'query_completed',
        sessionId,
      });

      // Also broadcast a notification to ALL clients (for toast in other sessions)
      const session = stmts.getSession.get(sessionId) as any;
      broadcastToAll({
        type: 'session_notification',
        sessionId,
        sessionName: session?.name || 'Unknown',
        notification: 'completed',
      });
    } catch (iterError) {
      console.error('Error during query iteration:', iterError);
      broadcastToSession(sessionId, {
        type: 'error',
        sessionId,
        error: iterError instanceof Error ? iterError.message : String(iterError),
      });
    } finally {
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
  stmts.insertMessage.run(
    sessionId,
    message.role,
    message.content,
    message.timestamp,
    message.useMarkdown ? 1 : 0,
    message.status || null
  );
  stmts.updateLastActive.run(Date.now(), sessionId);
}

function saveSdkSessionId(sessionId: string, sdkSessionId: string) {
  stmts.updateSdkSessionId.run(sdkSessionId, sessionId);
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
      saveSdkSessionId(sessionId, event.session_id);
    } else if (event.type === 'assistant' && event.message) {
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

// Broadcast to ALL connected clients (for cross-session notifications)
function broadcastToAll(data: any) {
  const message = JSON.stringify(data);
  allConnections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
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

// ============================
// WebSocket upgrade handler
// ============================
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';

  if (url.startsWith('/vnc/')) {
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
      let responseHeaders = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value) responseHeaders += `${key}: ${value}\r\n`;
      }
      responseHeaders += '\r\n';
      socket.write(responseHeaders);

      if (proxyHead && proxyHead.length > 0) {
        socket.write(proxyHead);
      }

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
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

// Start server
const HOST = '0.0.0.0';
server.listen(Number(PORT), HOST, () => {
  console.log(`Claude Web Frontend running on http://${HOST}:${PORT}`);
  console.log(`Accessible via Tailscale at http://100.110.255.35:${PORT}`);
  console.log(`Database: ${DB_FILE}`);
});
