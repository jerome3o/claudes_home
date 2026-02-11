#!/usr/bin/env node
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, request as httpRequest } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { Cron } from 'croner';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKUserMessage, Options as SDKOptions, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Build environment variables for spawned Claude Code processes.
 * Ensures the PATH includes the directory of the current Node.js binary
 * so that `spawn("node", ...)` inside the SDK can always find it —
 * even when the server runs in a restricted environment (e.g. systemd,
 * Docker, cron) where PATH is minimal.
 */
function getSpawnEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  const nodeBinDir = dirname(process.execPath);
  if (env.PATH) {
    if (!env.PATH.split(':').includes(nodeBinDir)) {
      env.PATH = `${nodeBinDir}:${env.PATH}`;
    }
  } else {
    env.PATH = nodeBinDir;
  }
  return env;
}

/**
 * Resolve the working directory for a session's Claude Code process.
 * Falls back to `process.cwd()` when the configured folder doesn't
 * exist on disk — preventing a misleading `spawn node ENOENT` from
 * `child_process.spawn` (which throws ENOENT for missing cwd too).
 */
function resolveSessionCwd(folder: string | null | undefined): string {
  if (folder && existsSync(folder)) {
    return folder;
  }
  if (folder) {
    console.warn(`[session] Configured folder does not exist: ${folder} — falling back to ${process.cwd()}`);
  }
  return process.cwd();
}

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

  CREATE TABLE IF NOT EXISTS sdk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    event_data TEXT NOT NULL,
    turn_index INTEGER DEFAULT 0,
    timestamp INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_sdk_events_session ON sdk_events(session_id, timestamp);

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'cron',
    cron_expression TEXT,
    timezone TEXT DEFAULT 'UTC',
    prompt TEXT NOT NULL,
    session_mode TEXT NOT NULL DEFAULT 'new',
    session_id TEXT,
    webhook_path TEXT,
    webhook_secret TEXT,
    enabled INTEGER DEFAULT 1,
    model TEXT DEFAULT 'opus',
    max_turns INTEGER DEFAULT 0,
    max_budget_usd REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id),
    status TEXT NOT NULL DEFAULT 'running',
    trigger_type TEXT NOT NULL,
    trigger_data TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    error TEXT,
    result_summary TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at);

  CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    webhook_path TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, webhook_path)
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_subs_path ON webhook_subscriptions(webhook_path);
  CREATE INDEX IF NOT EXISTS idx_webhook_subs_session ON webhook_subscriptions(session_id);

  CREATE TABLE IF NOT EXISTS message_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'pending'
  );

  CREATE INDEX IF NOT EXISTS idx_message_queue_session ON message_queue(session_id, status);

  CREATE TABLE IF NOT EXISTS scheduled_events (
    id TEXT PRIMARY KEY,
    name TEXT,
    type TEXT NOT NULL DEFAULT 'task',
    status TEXT NOT NULL DEFAULT 'pending',
    scheduled_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    executed_at DATETIME,
    task_id TEXT,
    webhook_path TEXT,
    webhook_data TEXT,
    session_id TEXT,
    message_content TEXT,
    metadata TEXT,
    error TEXT,
    result_summary TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_events_status_time ON scheduled_events(status, scheduled_at);
`);

// Migration: add pinned column to sessions
try { db.exec('ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0'); } catch(e) { /* column already exists */ }

db.exec(`
  -- Agent Hub tables
  CREATE TABLE IF NOT EXISTS hub_topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    icon TEXT DEFAULT '',
    created_by_type TEXT NOT NULL DEFAULT 'user',
    created_by_id TEXT,
    created_by_name TEXT DEFAULT 'User',
    post_count INTEGER DEFAULT 0,
    last_activity_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS hub_posts (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES hub_topics(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    author_type TEXT NOT NULL DEFAULT 'user',
    author_id TEXT,
    author_name TEXT DEFAULT 'User',
    comment_count INTEGER DEFAULT 0,
    pinned INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_hub_posts_topic ON hub_posts(topic_id, created_at DESC);
`);

// Migrations for post status and archive
try { db.exec('ALTER TABLE hub_posts ADD COLUMN status_text TEXT DEFAULT NULL'); } catch(e) {}
try { db.exec('ALTER TABLE hub_posts ADD COLUMN status_color TEXT DEFAULT NULL'); } catch(e) {}
try { db.exec('ALTER TABLE hub_posts ADD COLUMN archived INTEGER DEFAULT 0'); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS hub_comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES hub_posts(id) ON DELETE CASCADE,
    parent_comment_id TEXT,
    content TEXT NOT NULL,
    author_type TEXT NOT NULL DEFAULT 'user',
    author_id TEXT,
    author_name TEXT DEFAULT 'User',
    depth INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_hub_comments_post ON hub_comments(post_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS hub_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    subscription_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, subscription_type, target_id)
  );

  CREATE INDEX IF NOT EXISTS idx_hub_subs_target ON hub_subscriptions(subscription_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_hub_subs_session ON hub_subscriptions(session_id);

  CREATE TABLE IF NOT EXISTS hub_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL REFERENCES hub_posts(id) ON DELETE CASCADE,
    comment_id TEXT,
    emoji TEXT NOT NULL,
    session_id TEXT,
    author_type TEXT NOT NULL DEFAULT 'user',
    author_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, emoji, session_id, comment_id)
  );
  CREATE INDEX IF NOT EXISTS idx_hub_reactions_post ON hub_reactions(post_id);
  CREATE INDEX IF NOT EXISTS idx_hub_reactions_comment ON hub_reactions(comment_id);

  CREATE TABLE IF NOT EXISTS query_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(subscriber_session_id, target_session_id)
  );
`);

// Add was_querying column for seamless restart support (idempotent)
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN was_querying INTEGER DEFAULT 0`);
} catch (_e) {
  // Column already exists — ignore
}

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
// Announcements topic auto-setup
// ============================
const ANNOUNCEMENTS_TOPIC_ID = 'announcements-topic-00000000';

function ensureAnnouncementsTopic() {
  const existing = stmts.hubGetTopicByName.get('announcements') as any;
  if (!existing) {
    stmts.hubCreateTopic.run(
      ANNOUNCEMENTS_TOPIC_ID,
      'announcements',
      'System-wide announcements — all sessions are auto-subscribed',
      '📢',
      'system',
      null,
      'System'
    );
    console.log('[hub] Created announcements topic');
  }
}

function autoSubscribeAnnouncementsTopic() {
  const topic = stmts.hubGetTopicByName.get('announcements') as any;
  if (!topic) return;
  const sessions = stmts.getAllSessions.all() as any[];
  for (const session of sessions) {
    stmts.hubCreateSubscription.run(session.id, 'topic', topic.id);
  }
}

// ============================
// Database helper functions
// ============================
const stmts = {
  getAllSessions: db.prepare(
    'SELECT id, name, folder, created, lastActive, sdkSessionId, pinned FROM sessions ORDER BY lastActive DESC'
  ),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  createSession: db.prepare(
    'INSERT INTO sessions (id, name, folder, created, lastActive, sdkSessionId) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  renameSession: db.prepare('UPDATE sessions SET name = ? WHERE id = ?'),
  updateSessionFolder: db.prepare('UPDATE sessions SET folder = ? WHERE id = ?'),
  updateLastActive: db.prepare('UPDATE sessions SET lastActive = ? WHERE id = ?'),
  updateSdkSessionId: db.prepare('UPDATE sessions SET sdkSessionId = ? WHERE id = ?'),
  getMessages: db.prepare(
    'SELECT role, content, timestamp, useMarkdown, status FROM messages WHERE session_id = ? ORDER BY timestamp ASC'
  ),
  getMessagesPaginated: db.prepare(
    'SELECT role, content, timestamp, useMarkdown, status FROM messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ? OFFSET ?'
  ),
  getMessagesTail: db.prepare(
    'SELECT * FROM (SELECT role, content, timestamp, useMarkdown, status FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC'
  ),
  insertMessage: db.prepare(
    'INSERT INTO messages (session_id, role, content, timestamp, useMarkdown, status) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getMessageCount: db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?'),
  // SDK events persistence
  insertSdkEvent: db.prepare(
    'INSERT INTO sdk_events (session_id, event_type, event_data, turn_index, timestamp) VALUES (?, ?, ?, ?, ?)'
  ),
  getSdkEvents: db.prepare(
    'SELECT event_type, event_data, turn_index, timestamp FROM sdk_events WHERE session_id = ? ORDER BY timestamp ASC, id ASC'
  ),
  getSdkEventsPaginated: db.prepare(
    'SELECT event_type, event_data, turn_index, timestamp FROM sdk_events WHERE session_id = ? ORDER BY timestamp ASC, id ASC LIMIT ? OFFSET ?'
  ),
  getSdkEventsTail: db.prepare(
    'SELECT * FROM (SELECT event_type, event_data, turn_index, timestamp, id FROM sdk_events WHERE session_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?) ORDER BY timestamp ASC, id ASC'
  ),
  getSdkEventCount: db.prepare('SELECT COUNT(*) as cnt FROM sdk_events WHERE session_id = ?'),
  // Scheduled tasks
  getAllTasks: db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC'),
  getTask: db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?'),
  getTaskByWebhookPath: db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'webhook' AND webhook_path = ? AND enabled = 1"),
  createTask: db.prepare(
    `INSERT INTO scheduled_tasks (id, name, type, cron_expression, timezone, prompt, session_mode, session_id, webhook_path, webhook_secret, enabled, model, max_turns, max_budget_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  updateTask: db.prepare(
    `UPDATE scheduled_tasks SET name=?, type=?, cron_expression=?, timezone=?, prompt=?, session_mode=?, session_id=?,
     webhook_path=?, webhook_secret=?, enabled=?, model=?, max_turns=?, max_budget_usd=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ),
  deleteTask: db.prepare('DELETE FROM scheduled_tasks WHERE id = ?'),
  getEnabledCronTasks: db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'cron' AND enabled = 1"),
  // Task runs
  insertTaskRun: db.prepare(
    'INSERT INTO task_runs (id, task_id, session_id, status, trigger_type, trigger_data) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  updateTaskRunStatus: db.prepare(
    'UPDATE task_runs SET status=?, finished_at=CURRENT_TIMESTAMP, error=?, result_summary=? WHERE id=?'
  ),
  getTaskRuns: db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 50'),
  getTaskRun: db.prepare('SELECT * FROM task_runs WHERE id = ?'),
  markInterruptedRuns: db.prepare("UPDATE task_runs SET status = 'interrupted', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'"),
  // Webhook subscriptions
  getSubscriptionsByPath: db.prepare(
    'SELECT ws.*, s.name as session_name FROM webhook_subscriptions ws JOIN sessions s ON ws.session_id = s.id WHERE ws.webhook_path = ?'
  ),
  getSubscriptionsBySession: db.prepare(
    'SELECT * FROM webhook_subscriptions WHERE session_id = ?'
  ),
  createSubscription: db.prepare(
    'INSERT OR IGNORE INTO webhook_subscriptions (session_id, webhook_path) VALUES (?, ?)'
  ),
  deleteSubscription: db.prepare(
    'DELETE FROM webhook_subscriptions WHERE session_id = ? AND webhook_path = ?'
  ),
  // Message queue
  enqueueMessage: db.prepare(
    "INSERT INTO message_queue (session_id, type, content, metadata, status) VALUES (?, ?, ?, ?, 'pending')"
  ),
  getPendingMessages: db.prepare(
    "SELECT * FROM message_queue WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 10"
  ),
  updateMessageStatus: db.prepare(
    'UPDATE message_queue SET status = ? WHERE id = ?'
  ),
  getQueuedMessageCount: db.prepare(
    "SELECT COUNT(*) as cnt FROM message_queue WHERE session_id = ? AND status = 'pending'"
  ),
  // Scheduled events
  createEvent: db.prepare(
    `INSERT INTO scheduled_events (id, name, type, status, scheduled_at, task_id, webhook_path, webhook_data, session_id, message_content, metadata)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
  ),
  getEvent: db.prepare('SELECT * FROM scheduled_events WHERE id = ?'),
  updateEvent: db.prepare(
    `UPDATE scheduled_events SET name=?, scheduled_at=?, task_id=?, webhook_path=?, webhook_data=?, session_id=?, message_content=?, metadata=? WHERE id=? AND status='pending'`
  ),
  cancelEvent: db.prepare(
    `UPDATE scheduled_events SET status='cancelled' WHERE id=? AND status='pending'`
  ),
  getDueEvents: db.prepare(
    `SELECT * FROM scheduled_events WHERE status='pending' AND scheduled_at <= datetime('now') ORDER BY scheduled_at ASC LIMIT 20`
  ),
  getUpcomingEvents: db.prepare(
    `SELECT * FROM scheduled_events WHERE status='pending' ORDER BY scheduled_at ASC LIMIT 100`
  ),
  getAllEvents: db.prepare(
    `SELECT * FROM scheduled_events ORDER BY scheduled_at DESC LIMIT 100`
  ),
  updateEventStatus: db.prepare(
    `UPDATE scheduled_events SET status=?, executed_at=CURRENT_TIMESTAMP, error=?, result_summary=? WHERE id=?`
  ),
  markEventRunning: db.prepare(
    `UPDATE scheduled_events SET status='running' WHERE id=? AND status='pending'`
  ),
  // Hub - Topics
  hubGetAllTopics: db.prepare('SELECT * FROM hub_topics ORDER BY last_activity_at DESC'),
  hubGetTopic: db.prepare('SELECT * FROM hub_topics WHERE id = ?'),
  hubGetTopicByName: db.prepare('SELECT * FROM hub_topics WHERE name = ?'),
  hubCreateTopic: db.prepare(
    `INSERT INTO hub_topics (id, name, description, icon, created_by_type, created_by_id, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  hubUpdateTopic: db.prepare(
    'UPDATE hub_topics SET name=?, description=?, icon=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ),
  hubDeleteTopic: db.prepare('DELETE FROM hub_topics WHERE id = ?'),
  hubUpdateTopicActivity: db.prepare(
    'UPDATE hub_topics SET last_activity_at=CURRENT_TIMESTAMP, post_count=post_count+1 WHERE id=?'
  ),
  hubDecrementTopicPostCount: db.prepare(
    'UPDATE hub_topics SET post_count = MAX(0, post_count - 1) WHERE id = ?'
  ),
  // Hub - Posts
  hubGetPostsByTopic: db.prepare(
    'SELECT * FROM hub_posts WHERE topic_id = ? ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?'
  ),
  hubGetPost: db.prepare('SELECT * FROM hub_posts WHERE id = ?'),
  hubCreatePost: db.prepare(
    `INSERT INTO hub_posts (id, topic_id, title, content, author_type, author_id, author_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  hubUpdatePost: db.prepare(
    'UPDATE hub_posts SET title=?, content=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ),
  hubDeletePost: db.prepare('DELETE FROM hub_posts WHERE id = ?'),
  hubIncrementCommentCount: db.prepare(
    'UPDATE hub_posts SET comment_count=comment_count+1, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ),
  hubDecrementCommentCount: db.prepare(
    'UPDATE hub_posts SET comment_count = MAX(0, comment_count - 1) WHERE id = ?'
  ),
  hubGetRecentPosts: db.prepare(
    'SELECT p.*, t.name as topic_name, t.icon as topic_icon FROM hub_posts p JOIN hub_topics t ON p.topic_id = t.id ORDER BY p.created_at DESC LIMIT ?'
  ),
  // Hub - Comments
  hubGetCommentsByPost: db.prepare(
    'SELECT * FROM hub_comments WHERE post_id = ? ORDER BY created_at ASC'
  ),
  hubGetComment: db.prepare('SELECT * FROM hub_comments WHERE id = ?'),
  hubCreateComment: db.prepare(
    `INSERT INTO hub_comments (id, post_id, parent_comment_id, content, author_type, author_id, author_name, depth)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  hubDeleteComment: db.prepare('DELETE FROM hub_comments WHERE id = ?'),
  // Hub - Subscriptions
  hubGetSubscriptionsByTarget: db.prepare(
    'SELECT hs.*, s.name as session_name FROM hub_subscriptions hs JOIN sessions s ON hs.session_id = s.id WHERE hs.subscription_type = ? AND hs.target_id = ?'
  ),
  hubGetSubscriptionsBySession: db.prepare(
    'SELECT * FROM hub_subscriptions WHERE session_id = ?'
  ),
  hubCreateSubscription: db.prepare(
    'INSERT OR IGNORE INTO hub_subscriptions (session_id, subscription_type, target_id) VALUES (?, ?, ?)'
  ),
  hubDeleteSubscription: db.prepare(
    'DELETE FROM hub_subscriptions WHERE session_id = ? AND subscription_type = ? AND target_id = ?'
  ),
  // Seamless restart support
  markSessionQuerying: db.prepare('UPDATE sessions SET was_querying = ? WHERE id = ?'),
  clearAllQuerying: db.prepare('UPDATE sessions SET was_querying = 0'),
  getQueryingSessions: db.prepare('SELECT id, name, sdkSessionId FROM sessions WHERE was_querying = 1 AND sdkSessionId IS NOT NULL'),
  // Hub - Reactions
  hubAddReaction: db.prepare(
    'INSERT OR IGNORE INTO hub_reactions (post_id, comment_id, emoji, session_id, author_type, author_name) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  hubRemoveReaction: db.prepare(
    'DELETE FROM hub_reactions WHERE post_id = ? AND emoji = ? AND session_id = ? AND (comment_id IS ? OR comment_id = ?)'
  ),
  hubGetPostReactions: db.prepare(
    'SELECT emoji, COUNT(*) as count, GROUP_CONCAT(author_name) as authors FROM hub_reactions WHERE post_id = ? AND comment_id IS NULL GROUP BY emoji'
  ),
  hubGetCommentReactions: db.prepare(
    'SELECT emoji, COUNT(*) as count, GROUP_CONCAT(author_name) as authors FROM hub_reactions WHERE comment_id = ? GROUP BY emoji'
  ),
  hubGetUserReaction: db.prepare(
    'SELECT id FROM hub_reactions WHERE post_id = ? AND emoji = ? AND session_id = ? AND (comment_id IS ? OR comment_id = ?)'
  ),
  // Query completion subscriptions
  querySubGetWatchers: db.prepare(
    'SELECT qs.*, s.name as subscriber_name FROM query_subscriptions qs JOIN sessions s ON qs.subscriber_session_id = s.id WHERE qs.target_session_id = ?'
  ),
  querySubCreate: db.prepare(
    'INSERT OR IGNORE INTO query_subscriptions (subscriber_session_id, target_session_id) VALUES (?, ?)'
  ),
  querySubDelete: db.prepare(
    'DELETE FROM query_subscriptions WHERE subscriber_session_id = ? AND target_session_id = ?'
  ),
  querySubDeleteByTarget: db.prepare(
    'DELETE FROM query_subscriptions WHERE target_session_id = ?'
  ),
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
// Queries run to completion even if all clients disconnect.
// No orphan abort — user wants async background execution.

// ============================
// Load/save MCP config (still file-based — small config)
// ============================
function loadMcpConfig(): Record<string, McpServerConfig> {
  // 1. Prefer runtime override from data/mcp-config.json (set via API)
  if (existsSync(MCP_CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(MCP_CONFIG_FILE, 'utf-8'));
    } catch (e) {
      console.error('Failed to load MCP config:', e);
    }
  }

  // 2. Fall back to project-root .mcp.json (same file the orchestrator uses)
  const projectRoot = join(__dirname, '..', '..');
  const mcpJsonPath = join(projectRoot, '.mcp.json');
  if (existsSync(mcpJsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      if (raw.mcpServers && typeof raw.mcpServers === 'object') {
        console.log(`[mcp] Loaded ${Object.keys(raw.mcpServers).length} MCP server(s) from ${mcpJsonPath}`);
        return raw.mcpServers;
      }
    } catch (e) {
      console.error('Failed to load .mcp.json:', e);
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

// Security headers — prevent embedding in iframes (e.g. inside webtop browser)
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});

// Landing page: serve hub as the main page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../public/hub.html'));
});

// Chat app at /chat
app.get('/chat', (req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});

// Serve static files
app.use(express.static(join(__dirname, '../public')));
app.use(express.json());

// ============================
// API endpoints
// ============================
app.get('/api/sessions', (req, res) => {
  const sessions = stmts.getAllSessions.all() as any[];
  const enriched = sessions.map(s => ({ ...s, activeQuery: activeQueries.has(s.id) }));
  res.json(enriched);
});

app.post('/api/sessions', (req, res) => {
  const { name, folder } = req.body;
  const id = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = Date.now();
  const sessionName = name || `Session ${(stmts.getAllSessions.all() as any[]).length + 1}`;

  stmts.createSession.run(id, sessionName, folder || null, now, now, null);

  // Auto-subscribe to announcements topic
  const announcementsTopic = stmts.hubGetTopicByName.get('announcements') as any;
  if (announcementsTopic) {
    stmts.hubCreateSubscription.run(id, 'topic', announcementsTopic.id);
  }

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
  const { name, folder } = req.body;
  if (!name && folder === undefined) {
    res.status(400).json({ error: 'Name or folder is required' });
    return;
  }
  if (name) {
    stmts.renameSession.run(name, req.params.id);
    // Broadcast rename to all connected clients so sidebar updates in real-time
    broadcastToAll({
      type: 'session_renamed',
      sessionId: req.params.id,
      name,
    });
  }
  if (folder !== undefined) {
    stmts.updateSessionFolder.run(folder || null, req.params.id);
  }
  res.json({ success: true, name, folder });
});

app.patch('/api/sessions/:id/pin', (req, res) => {
  const { id } = req.params;
  const session = stmts.getSession.get(id) as any;
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  const newPinned = session.pinned ? 0 : 1;
  db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?').run(newPinned, id);
  res.json({ id, pinned: newPinned });
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

// Get session messages (for loading history) — supports pagination
app.get('/api/sessions/:id/messages', (req, res) => {
  const session = stmts.getSession.get(req.params.id) as any;

  if (session) {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 0;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const total_count = (stmts.getMessageCount.get(req.params.id) as any).cnt;

    let messages: SessionMessage[];
    if (limit > 0 && offset === 0 && total_count > limit) {
      // Initial load: get the last N messages efficiently
      messages = stmts.getMessagesTail.all(req.params.id, limit) as SessionMessage[];
    } else if (limit > 0) {
      messages = stmts.getMessagesPaginated.all(req.params.id, limit, offset) as SessionMessage[];
    } else {
      messages = stmts.getMessages.all(req.params.id) as SessionMessage[];
    }

    const formatted = messages.map(m => ({
      ...m,
      useMarkdown: !!m.useMarkdown,
    }));
    const has_more = limit > 0 ? (offset + limit < total_count) : false;
    res.json({ messages: formatted, sdkSessionId: session.sdkSessionId, total_count, has_more });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Get session SDK events (new persistence format) — supports pagination
app.get('/api/sessions/:id/events', (req, res) => {
  const session = stmts.getSession.get(req.params.id) as any;
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 0;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
  const total_count = (stmts.getSdkEventCount.get(req.params.id) as any).cnt;

  let events: any[];
  if (limit > 0 && offset === 0 && total_count > limit) {
    // Initial load: get the last N events efficiently
    events = stmts.getSdkEventsTail.all(req.params.id, limit) as any[];
  } else if (limit > 0) {
    events = stmts.getSdkEventsPaginated.all(req.params.id, limit, offset) as any[];
  } else {
    events = stmts.getSdkEvents.all(req.params.id) as any[];
  }

  const formatted = events.map(e => ({
    event_type: e.event_type,
    event_data: JSON.parse(e.event_data),
    turn_index: e.turn_index,
    timestamp: e.timestamp,
  }));

  const has_more = limit > 0 ? (offset + limit < total_count) : false;

  res.json({ events: formatted, sdkSessionId: session.sdkSessionId, total_count, has_more });
});

// ============================
// Global Search API
// ============================
app.get('/api/messages/search', (req, res) => {
  const q = req.query.q as string;
  if (!q || !q.trim()) {
    res.json({ results: [], total_count: 0 });
    return;
  }

  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const searchTerm = q.trim();

  // Search legacy messages
  const legacyResults = db.prepare(`
    SELECT m.session_id, m.role, m.content, m.timestamp, s.name as session_name
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE m.content LIKE '%' || ? || '%'
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(searchTerm, limit) as any[];

  // Search SDK events (event_data JSON contains message text)
  const eventResults = db.prepare(`
    SELECT e.session_id, e.event_data, e.timestamp, s.name as session_name
    FROM sdk_events e
    JOIN sessions s ON e.session_id = s.id
    WHERE e.event_data LIKE '%' || ? || '%'
    ORDER BY e.timestamp DESC
    LIMIT ?
  `).all(searchTerm, limit) as any[];

  // Format legacy results
  const formattedLegacy = legacyResults.map((r: any) => ({
    session_id: r.session_id,
    session_name: r.session_name,
    content: extractSnippet(r.content, searchTerm),
    role: r.role,
    timestamp: r.timestamp,
  }));

  // Format SDK event results — extract text from event_data JSON
  const formattedEvents: any[] = [];
  for (const e of eventResults) {
    try {
      const data = JSON.parse(e.event_data);
      const message = data?.message;
      if (!message?.content) continue;
      const textBlocks = Array.isArray(message.content)
        ? message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text)
        : [String(message.content)];
      const fullText = textBlocks.join('\n');
      if (fullText.toLowerCase().includes(searchTerm.toLowerCase())) {
        formattedEvents.push({
          session_id: e.session_id,
          session_name: e.session_name,
          content: extractSnippet(fullText, searchTerm),
          role: message.role || 'assistant',
          timestamp: e.timestamp,
        });
      }
    } catch {
      // Skip malformed event data
    }
  }

  // Combine, deduplicate by content+session+timestamp, sort by timestamp DESC
  const seen = new Set<string>();
  const combined: any[] = [];
  for (const r of [...formattedLegacy, ...formattedEvents]) {
    const key = `${r.session_id}:${r.timestamp}:${r.content}`;
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(r);
    }
  }
  combined.sort((a, b) => b.timestamp - a.timestamp);
  const results = combined.slice(0, limit);

  res.json({ results, total_count: results.length });
});

/** Extract ~100 chars around the first match of `term` in `text`. */
function extractSnippet(text: string, term: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx === -1) return text.slice(0, 120);
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + term.length + 50);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

// ============================
// Scheduled Tasks API
// ============================
app.get('/api/tasks', (req, res) => {
  const tasks = stmts.getAllTasks.all();
  res.json(tasks);
});

app.post('/api/tasks', (req, res) => {
  const { name, type, cron_expression, timezone, prompt, session_mode,
          session_id, webhook_path, webhook_secret, enabled, model,
          max_turns, max_budget_usd } = req.body;

  if (!name || !prompt) {
    res.status(400).json({ error: 'Name and prompt are required' });
    return;
  }

  const id = randomUUID();
  const taskType = type || 'cron';
  const webhookPath = taskType === 'webhook' ? (webhook_path || id.slice(0, 8)) : null;

  stmts.createTask.run(
    id, name, taskType, cron_expression || null, timezone || 'UTC',
    prompt, session_mode || 'new', session_id || null,
    webhookPath, webhook_secret || null,
    enabled !== undefined ? (enabled ? 1 : 0) : 1,
    model || 'opus', max_turns ?? 0, max_budget_usd ?? 0
  );

  const task = stmts.getTask.get(id);

  // If it's a cron task and enabled, schedule it
  if (taskType === 'cron' && cron_expression && (enabled === undefined || enabled)) {
    scheduleCronTask(task as any);
  }

  res.json(task);
});

app.get('/api/tasks/:id', (req, res) => {
  const task = stmts.getTask.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const existing = stmts.getTask.get(req.params.id) as any;
  if (!existing) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  const { name, type, cron_expression, timezone, prompt, session_mode,
          session_id, webhook_path, webhook_secret, enabled, model,
          max_turns, max_budget_usd } = req.body;

  stmts.updateTask.run(
    name ?? existing.name,
    type ?? existing.type,
    cron_expression ?? existing.cron_expression,
    timezone ?? existing.timezone,
    prompt ?? existing.prompt,
    session_mode ?? existing.session_mode,
    session_id ?? existing.session_id,
    webhook_path ?? existing.webhook_path,
    webhook_secret ?? existing.webhook_secret,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    model ?? existing.model,
    max_turns ?? existing.max_turns,
    max_budget_usd ?? existing.max_budget_usd,
    req.params.id
  );

  // Re-schedule cron task
  unscheduleCronTask(req.params.id);
  const updated = stmts.getTask.get(req.params.id) as any;
  if (updated.type === 'cron' && updated.cron_expression && updated.enabled) {
    scheduleCronTask(updated);
  }

  res.json(updated);
});

app.delete('/api/tasks/:id', (req, res) => {
  unscheduleCronTask(req.params.id);
  stmts.deleteTask.run(req.params.id);
  res.json({ success: true });
});

// Manually trigger a task
app.post('/api/tasks/:id/run', (req, res) => {
  const task = stmts.getTask.get(req.params.id) as any;
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  // Fire-and-forget execution
  executeTask(task, 'manual').catch(e => console.error('Manual task execution failed:', e));

  res.status(202).json({ status: 'started', taskId: task.id });
});

// Get runs for a task
app.get('/api/tasks/:id/runs', (req, res) => {
  const runs = stmts.getTaskRuns.all(req.params.id);
  res.json(runs);
});

// Get a specific run
app.get('/api/runs/:id', (req, res) => {
  const run = stmts.getTaskRun.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  res.json(run);
});

// ============================
// AI Cron Expression Generator
// ============================
app.post('/api/generate-cron', async (req, res) => {
  const { description } = req.body;
  if (!description) {
    res.status(400).json({ error: 'Description is required' });
    return;
  }

  try {
    // Use a quick Claude query to generate the cron expression
    const prompt = `Convert this schedule description to a standard 5-field cron expression (minute hour day-of-month month day-of-week). Reply with ONLY the cron expression, nothing else. No explanation, no backticks, just the 5 fields separated by spaces.

Schedule: "${description}"`;

    const q = query({
      prompt,
      options: {
        model: 'haiku',
        maxTurns: 1,
      },
    });

    let result = '';
    for await (const event of q) {
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            result += block.text;
          }
        }
      }
    }

    // Clean up - extract just the cron expression (5 fields)
    const cleaned = result.trim().replace(/`/g, '').trim();
    const cronMatch = cleaned.match(/^[\d*,\/-]+\s+[\d*,\/-]+\s+[\d*,\/-]+\s+[\d*,\/-]+\s+[\d*,\/-]+/);

    if (cronMatch) {
      res.json({ cron: cronMatch[0], raw: cleaned });
    } else {
      res.json({ cron: cleaned, raw: cleaned });
    }
  } catch (e) {
    console.error('Cron generation error:', e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ============================
// Scheduled Events API
// ============================

// List events (optionally filter by status)
app.get('/api/events', (req, res) => {
  const status = req.query.status as string;
  if (status === 'pending') {
    res.json(stmts.getUpcomingEvents.all());
  } else {
    res.json(stmts.getAllEvents.all());
  }
});

// Get a single event
app.get('/api/events/:id', (req, res) => {
  const event = stmts.getEvent.get(req.params.id);
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  res.json(event);
});

// Create a scheduled event
app.post('/api/events', (req, res) => {
  const { name, type, scheduled_at, delay_seconds, task_id, webhook_path,
          webhook_data, session_id, message_content, metadata } = req.body;

  if (!type) {
    res.status(400).json({ error: 'type is required (task, webhook, or message)' });
    return;
  }

  if (!scheduled_at && !delay_seconds) {
    res.status(400).json({ error: 'Either scheduled_at or delay_seconds is required' });
    return;
  }

  // Validate type-specific requirements
  if (type === 'task' && !task_id) {
    res.status(400).json({ error: 'task_id is required for task events' });
    return;
  }
  if (type === 'webhook' && !webhook_path) {
    res.status(400).json({ error: 'webhook_path is required for webhook events' });
    return;
  }
  if (type === 'message' && (!session_id || !message_content)) {
    res.status(400).json({ error: 'session_id and message_content are required for message events' });
    return;
  }

  const id = randomUUID();
  const fireAt = scheduled_at
    ? new Date(scheduled_at).toISOString()
    : new Date(Date.now() + Number(delay_seconds) * 1000).toISOString();

  stmts.createEvent.run(
    id,
    name || null,
    type,
    fireAt,
    task_id || null,
    webhook_path || null,
    webhook_data ? JSON.stringify(webhook_data) : null,
    session_id || null,
    message_content || null,
    metadata ? JSON.stringify(metadata) : null
  );

  const event = stmts.getEvent.get(id);
  console.log(`[events] Created event "${name || id}" (type: ${type}) scheduled for ${fireAt}`);
  res.json(event);
});

// Update a pending event
app.put('/api/events/:id', (req, res) => {
  const existing = stmts.getEvent.get(req.params.id) as any;
  if (!existing) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  if (existing.status !== 'pending') {
    res.status(400).json({ error: `Cannot update event with status "${existing.status}"` });
    return;
  }

  const { name, scheduled_at, delay_seconds, task_id, webhook_path,
          webhook_data, session_id, message_content, metadata } = req.body;

  const newScheduledAt = delay_seconds
    ? new Date(Date.now() + Number(delay_seconds) * 1000).toISOString()
    : (scheduled_at ? new Date(scheduled_at).toISOString() : existing.scheduled_at);

  stmts.updateEvent.run(
    name ?? existing.name,
    newScheduledAt,
    task_id ?? existing.task_id,
    webhook_path ?? existing.webhook_path,
    webhook_data !== undefined ? JSON.stringify(webhook_data) : existing.webhook_data,
    session_id ?? existing.session_id,
    message_content ?? existing.message_content,
    metadata !== undefined ? JSON.stringify(metadata) : existing.metadata,
    req.params.id
  );

  const updated = stmts.getEvent.get(req.params.id);
  console.log(`[events] Updated event "${req.params.id}"`);
  res.json(updated);
});

// Cancel a pending event
app.delete('/api/events/:id', (req, res) => {
  const existing = stmts.getEvent.get(req.params.id) as any;
  if (!existing) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }

  const result = stmts.cancelEvent.run(req.params.id);
  if (result.changes === 0) {
    res.status(400).json({ error: `Cannot cancel event with status "${existing.status}"` });
    return;
  }

  console.log(`[events] Cancelled event "${existing.name || req.params.id}"`);
  res.json({ success: true, event_id: req.params.id });
});

// ============================
// Agent Hub API
// ============================

// Resolve author name server-side instead of trusting client input
function resolveAuthorName(author_type: string | undefined, author_id: string | undefined): string {
  if (author_type === 'agent' && author_id) {
    const session = stmts.getSession.get(author_id) as any;
    if (session) return session.name;
    return 'Agent';
  }
  // For users (or unspecified), hardcode the name
  return 'Jerome';
}

// Parse @mentions from content and resolve to session IDs
function parseMentions(content: string): { sessionId: string; name: string }[] {
  const mentionRegex = /@([\w\s/.-]+?)(?=\s|$|[.,;:!?)\]}])/g;
  const mentions: { sessionId: string; name: string }[] = [];
  const seen = new Set<string>();
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    const name = match[1].trim();
    if (name && !seen.has(name.toLowerCase())) {
      // Look up session by name (case-insensitive)
      const session = db.prepare('SELECT id, name FROM sessions WHERE LOWER(name) = LOWER(?)').get(name) as any;
      if (session) {
        seen.add(name.toLowerCase());
        mentions.push({ sessionId: session.id, name: session.name });
      }
    }
  }
  return mentions;
}

// Notify agents that were @mentioned in post/comment content
function notifyMentionedAgents(
  mentions: { sessionId: string; name: string }[],
  postId: string,
  postTitle: string,
  mentionedBy: string,
  excludeSessionId?: string
) {
  for (const mention of mentions) {
    if (mention.sessionId === excludeSessionId) continue;

    // Auto-subscribe mentioned agent to the post
    try { stmts.hubCreateSubscription.run(mention.sessionId, 'post', postId); } catch(e) {}

    // Send direct notification
    const message = `[Hub Mention] You were mentioned by ${mentionedBy} in "${postTitle}"\n\nView: /hub#/posts/${postId}`;
    const metadata = JSON.stringify({ type: 'hub_mention', post_id: postId });

    // Check if they have an active query
    if (activeQueries.has(mention.sessionId)) {
      db.prepare('INSERT INTO message_queue (session_id, type, content, metadata) VALUES (?, ?, ?, ?)')
        .run(mention.sessionId, 'hub_mention', message, metadata);
    } else {
      processIncomingMessage(mention.sessionId, message);
    }
  }
}

// Hub static files
const HUB_FILES_DIR = join(DATA_DIR, 'hub-files');
if (!existsSync(HUB_FILES_DIR)) mkdirSync(HUB_FILES_DIR, { recursive: true });
app.use('/hub-files', express.static(HUB_FILES_DIR));

// Redirect /hub to / for backward compatibility
app.get('/hub', (req, res) => {
  res.redirect('/');
});
app.get('/hub/*', (req, res) => {
  res.redirect('/');
});

// --- Topics ---
app.get('/api/hub/topics', (req, res) => {
  try {
    const topics = stmts.hubGetAllTopics.all();
    res.json(topics);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/hub/topics/:id', (req, res) => {
  try {
    let topic = stmts.hubGetTopic.get(req.params.id) as any;
    if (!topic) {
      topic = stmts.hubGetTopicByName.get(req.params.id) as any;
    }
    if (!topic) {
      res.status(404).json({ error: 'Topic not found' });
      return;
    }
    res.json(topic);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/hub/topics', (req, res) => {
  try {
    const { name, description, icon, author_type, author_id } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }
    const existing = stmts.hubGetTopicByName.get(name) as any;
    if (existing) {
      res.status(409).json({ error: 'Topic name already exists' });
      return;
    }
    const id = randomUUID();
    const resolvedName = resolveAuthorName(author_type, author_id);
    stmts.hubCreateTopic.run(
      id, name, description || null, icon || '',
      author_type || 'user', author_id || null, resolvedName
    );
    res.json(stmts.hubGetTopic.get(id));

    sendNtfyNotification(
      `New topic: ${name}`,
      `Created by ${resolvedName}\n${description || ''}`,
      'new,speech_balloon'
    );
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.patch('/api/hub/topics/:id', (req, res) => {
  try {
    const existing = stmts.hubGetTopic.get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Topic not found' });
      return;
    }
    const { name, description, icon } = req.body;
    stmts.hubUpdateTopic.run(
      name ?? existing.name,
      description ?? existing.description,
      icon ?? existing.icon,
      req.params.id
    );
    res.json(stmts.hubGetTopic.get(req.params.id));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/hub/topics/:id', (req, res) => {
  try {
    stmts.hubDeleteTopic.run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Posts ---
app.get('/api/hub/topics/:id/posts', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const includeArchived = req.query.include_archived === 'true';

    let posts;
    if (includeArchived) {
      posts = stmts.hubGetPostsByTopic.all(req.params.id, limit, offset);
    } else {
      posts = db.prepare(
        'SELECT * FROM hub_posts WHERE topic_id = ? AND archived = 0 ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?'
      ).all(req.params.id, limit, offset);
    }
    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/hub/posts/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const posts = stmts.hubGetRecentPosts.all(limit);
    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/hub/posts/:id', (req, res) => {
  try {
    const post = stmts.hubGetPost.get(req.params.id) as any;
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    const reactions = stmts.hubGetPostReactions.all(req.params.id);
    res.json({ ...post, reactions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/hub/topics/:id/posts', (req, res) => {
  try {
    const topic = stmts.hubGetTopic.get(req.params.id) as any;
    if (!topic) {
      res.status(404).json({ error: 'Topic not found' });
      return;
    }
    const { title, content, author_type, author_id } = req.body;
    if (!title || !content) {
      res.status(400).json({ error: 'Title and content are required' });
      return;
    }
    const id = randomUUID();
    const resolvedName = resolveAuthorName(author_type, author_id);
    stmts.hubCreatePost.run(
      id, req.params.id, title, content,
      author_type || 'user', author_id || null, resolvedName
    );
    stmts.hubUpdateTopicActivity.run(req.params.id);
    const post = stmts.hubGetPost.get(id);

    // Notify topic subscribers
    notifyHubSubscribers(
      'topic', req.params.id,
      `New post in topic "${topic.name}": "${title}" by ${resolvedName}\n\nRead it at: /hub#/posts/${id}`,
      author_id
    );

    sendNtfyNotification(
      `New post in ${topic.name}: ${title}`,
      `By ${resolvedName}\n\n${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`,
      'memo'
    );

    // Auto-subscribe post author to their own post
    if (author_type === 'agent' && author_id) {
      try { stmts.hubCreateSubscription.run(author_id, 'post', id); } catch(e) {}
    }

    // Process @mentions
    const mentions = parseMentions(content);
    if (mentions.length > 0) {
      notifyMentionedAgents(mentions, id, title, resolvedName, author_id);
    }

    res.json(post);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.patch('/api/hub/posts/:id', (req, res) => {
  try {
    const existing = stmts.hubGetPost.get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    const { title, content } = req.body;
    stmts.hubUpdatePost.run(
      title ?? existing.title,
      content ?? existing.content,
      req.params.id
    );
    res.json(stmts.hubGetPost.get(req.params.id));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.patch('/api/hub/posts/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const { status_text, status_color } = req.body;
    const post = stmts.hubGetPost.get(id) as any;
    if (!post) return res.status(404).json({ error: 'Post not found' });
    // Validate status_color if provided — only allow hex colors
    if (status_color && !/^#[0-9a-fA-F]{6}$/.test(status_color)) {
      return res.status(400).json({ error: 'Invalid status_color. Must be a hex color like #ff0000' });
    }
    db.prepare('UPDATE hub_posts SET status_text = ?, status_color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(status_text || null, status_color || null, id);
    res.json({ id, status_text: status_text || null, status_color: status_color || null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.patch('/api/hub/posts/:id/archive', (req, res) => {
  try {
    const { id } = req.params;
    const post = stmts.hubGetPost.get(id) as any;
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const newArchived = post.archived ? 0 : 1;
    db.prepare('UPDATE hub_posts SET archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newArchived, id);
    res.json({ id, archived: newArchived });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/hub/posts/:id', (req, res) => {
  try {
    const post = stmts.hubGetPost.get(req.params.id) as any;
    if (post) {
      stmts.hubDecrementTopicPostCount.run(post.topic_id);
    }
    stmts.hubDeletePost.run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Comments ---
app.get('/api/hub/posts/:id/comments', (req, res) => {
  try {
    const comments = stmts.hubGetCommentsByPost.all(req.params.id) as any[];
    const commentsWithReactions = comments.map(c => ({
      ...c,
      reactions: stmts.hubGetCommentReactions.all(c.id),
    }));
    res.json(commentsWithReactions);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/hub/posts/:id/comments', (req, res) => {
  try {
    const post = stmts.hubGetPost.get(req.params.id) as any;
    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }
    const { content, parent_comment_id, author_type, author_id } = req.body;
    if (!content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }
    let depth = 0;
    if (parent_comment_id) {
      const parent = stmts.hubGetComment.get(parent_comment_id) as any;
      if (parent) depth = Math.min((parent.depth || 0) + 1, 4);
    }
    const id = randomUUID();
    const resolvedName = resolveAuthorName(author_type, author_id);
    stmts.hubCreateComment.run(
      id, req.params.id, parent_comment_id || null, content,
      author_type || 'user', author_id || null, resolvedName,
      depth
    );
    stmts.hubIncrementCommentCount.run(req.params.id);
    const comment = stmts.hubGetComment.get(id);

    // Notify post subscribers (and topic subscribers via the helper)
    notifyHubSubscribers(
      'post', req.params.id,
      `New comment on "${post.title}" by ${resolvedName}:\n\n${content.substring(0, 300)}${content.length > 300 ? '...' : ''}\n\nView thread: /hub#/posts/${req.params.id}`,
      author_id
    );

    sendNtfyNotification(
      `New comment on "${post.title}"`,
      `By ${resolvedName}\n\n${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`,
      'speech_balloon'
    );

    // Auto-subscribe commenter to the post they commented on
    if (author_type === 'agent' && author_id) {
      try { stmts.hubCreateSubscription.run(author_id, 'post', req.params.id); } catch(e) {}
    }

    // Process @mentions in comment
    const mentions = parseMentions(content);
    if (mentions.length > 0) {
      notifyMentionedAgents(mentions, req.params.id, post.title, resolvedName, author_id);
    }

    res.json(comment);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/hub/comments/:id', (req, res) => {
  try {
    const comment = stmts.hubGetComment.get(req.params.id) as any;
    if (comment) {
      stmts.hubDecrementCommentCount.run(comment.post_id);
    }
    stmts.hubDeleteComment.run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Hub Subscriptions ---
app.post('/api/hub/subscriptions', (req, res) => {
  try {
    const { session_id, subscription_type, target_id } = req.body;
    if (!session_id || !subscription_type || !target_id) {
      res.status(400).json({ error: 'session_id, subscription_type, and target_id are required' });
      return;
    }
    if (!['topic', 'post'].includes(subscription_type)) {
      res.status(400).json({ error: 'subscription_type must be "topic" or "post"' });
      return;
    }
    stmts.hubCreateSubscription.run(session_id, subscription_type, target_id);
    res.json({ success: true, session_id, subscription_type, target_id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/hub/subscriptions', (req, res) => {
  try {
    const { session_id, subscription_type, target_id } = req.body;
    if (!session_id || !subscription_type || !target_id) {
      res.status(400).json({ error: 'session_id, subscription_type, and target_id are required' });
      return;
    }
    stmts.hubDeleteSubscription.run(session_id, subscription_type, target_id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/hub/sessions/:id/subscriptions', (req, res) => {
  try {
    const subs = stmts.hubGetSubscriptionsBySession.all(req.params.id);
    res.json(subs);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get all subscribers for a topic or post
app.get('/api/hub/subscriptions/by-target', (req, res) => {
  try {
    const { type, id } = req.query;
    if (!type || !id) {
      res.status(400).json({ error: 'type and id query params required' });
      return;
    }
    if (!['topic', 'post'].includes(type as string)) {
      res.status(400).json({ error: 'type must be "topic" or "post"' });
      return;
    }
    const subs = stmts.hubGetSubscriptionsByTarget.all(type, id);
    res.json(subs);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get subscriber count for a topic or post
app.get('/api/hub/subscriptions/count', (req, res) => {
  try {
    const { type, id } = req.query;
    if (!type || !id) {
      res.status(400).json({ error: 'type and id query params required' });
      return;
    }
    const subs = stmts.hubGetSubscriptionsByTarget.all(type, id) as any[];
    res.json({ count: subs.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Hub Reactions ---
app.post('/api/hub/reactions', (req, res) => {
  try {
    const { post_id, comment_id, emoji, session_id, author_name, reactor_id } = req.body;
    if (!post_id || !emoji) {
      res.status(400).json({ error: 'post_id and emoji are required' });
      return;
    }

    // reactor_id is required to enforce one-per-user uniqueness
    // For agents it's the session_id, for web users it's a browser-generated ID
    const rid = reactor_id || session_id;
    if (!rid) {
      res.status(400).json({ error: 'reactor_id is required' });
      return;
    }

    const authorType = session_id ? 'agent' : 'user';
    const cid = comment_id || null;

    // Check if reaction already exists (toggle behavior)
    const existing = stmts.hubGetUserReaction.get(post_id, emoji, rid, cid, cid);

    if (existing) {
      stmts.hubRemoveReaction.run(post_id, emoji, rid, cid, cid);
      res.json({ action: 'removed', emoji });
    } else {
      stmts.hubAddReaction.run(post_id, cid, emoji, rid, authorType, author_name || 'Anonymous');
      res.json({ action: 'added', emoji });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/hub/posts/:id/reactions', (req, res) => {
  try {
    const reactions = stmts.hubGetPostReactions.all(req.params.id);
    res.json(reactions);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/hub/comments/:id/reactions', (req, res) => {
  try {
    const reactions = stmts.hubGetCommentReactions.all(req.params.id);
    res.json(reactions);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- Hub File Upload (multipart for web UI) ---
const hubUpload = multer({ dest: '/tmp/claude-hub-uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/hub/files', hubUpload.array('files', 10), (req, res) => {
  try {
    const subfolder = ((req.body.subfolder as string) || '').replace(/\.\./g, '');
    const targetDir = join(HUB_FILES_DIR, subfolder);
    if (!targetDir.startsWith(HUB_FILES_DIR)) {
      res.status(400).json({ error: 'Invalid subfolder' });
      return;
    }
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No files provided' });
      return;
    }

    const uploaded: { name: string; url: string }[] = [];
    for (const file of files) {
      const ext = file.originalname.split('.').pop() || '';
      const uniqueName = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}.${ext}`;
      const dest = join(targetDir, uniqueName);
      const data = readFileSync(file.path);
      writeFileSync(dest, data);
      unlinkSync(file.path);
      const relativePath = subfolder ? `${subfolder}/${uniqueName}` : uniqueName;
      uploaded.push({ name: file.originalname, url: `/hub-files/${relativePath}` });
    }
    res.json({ success: true, files: uploaded });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Hub base64 file upload (for MCP agents)
app.post('/api/hub/files/base64', (req, res) => {
  try {
    const { filename, content_base64, subfolder } = req.body;
    if (!filename || !content_base64) {
      res.status(400).json({ error: 'filename and content_base64 are required' });
      return;
    }
    const sf = (subfolder || '').replace(/\.\./g, '');
    const targetDir = join(HUB_FILES_DIR, sf);
    if (!targetDir.startsWith(HUB_FILES_DIR)) {
      res.status(400).json({ error: 'Invalid subfolder' });
      return;
    }
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    const ext = filename.split('.').pop() || 'bin';
    const uniqueName = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}.${ext}`;
    const dest = join(targetDir, uniqueName);
    const buffer = Buffer.from(content_base64, 'base64');
    writeFileSync(dest, buffer);
    const relativePath = sf ? `${sf}/${uniqueName}` : uniqueName;
    res.json({ success: true, url: `/hub-files/${relativePath}`, filename: uniqueName });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ============================
// Dashboard Routes & Stats API
// ============================

// Serve Dashboard page
app.get('/dashboard', (req, res) => {
  res.sendFile(join(__dirname, '../public/dashboard.html'));
});

// Activity timeline — messages per hour for last 24h, grouped by effective role.
// Messages stored with role='user' are further classified: hub notifications,
// agent-started triggers, inter-agent messages, and webhook messages are counted
// as 'bot' activity rather than genuine human 'user' activity.
app.get('/api/stats/activity', (req, res) => {
  try {
    const hours = 24;
    const since = Date.now() - (hours * 60 * 60 * 1000);

    const rows = db.prepare(`
      SELECT
        CAST((timestamp / 3600000) * 3600000 AS INTEGER) as hour_bucket,
        CASE
          WHEN role = 'user' AND (
            content LIKE '[Hub Notification]%'
            OR content LIKE '[Agent Started%'
            OR content LIKE '[Message from Agent]%'
            OR content LIKE '[Webhook Notification]%'
          ) THEN 'bot'
          ELSE role
        END as effective_role,
        COUNT(*) as count
      FROM messages
      WHERE timestamp > ?
      GROUP BY hour_bucket, effective_role
      ORDER BY hour_bucket
    `).all(since) as Array<{ hour_bucket: number; effective_role: string; count: number }>;

    // Build full 24-hour array of buckets
    const now = Date.now();
    const currentHourStart = Math.floor(now / 3600000) * 3600000;
    const bucketMap = new Map<number, { user: number; assistant: number; bot: number }>();

    for (let i = hours - 1; i >= 0; i--) {
      const hourTs = currentHourStart - (i * 3600000);
      bucketMap.set(hourTs, { user: 0, assistant: 0, bot: 0 });
    }

    for (const row of rows) {
      const bucket = bucketMap.get(row.hour_bucket);
      if (bucket) {
        const role = row.effective_role as 'user' | 'assistant' | 'bot';
        if (role in bucket) {
          bucket[role] = row.count;
        }
      }
    }

    const result = Array.from(bucketMap.entries()).map(([ts, counts]) => ({
      hour: new Date(ts).toISOString(),
      ...counts
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Cost & token usage — from result events in sdk_events
app.get('/api/stats/costs', (req, res) => {
  try {
    const since = Date.now() - (24 * 60 * 60 * 1000);

    const rows = db.prepare(`
      SELECT
        CAST((timestamp / 3600000) * 3600000 AS INTEGER) as hour_bucket,
        event_data
      FROM sdk_events
      WHERE event_type = 'result' AND timestamp > ?
      ORDER BY timestamp
    `).all(since) as Array<{ hour_bucket: number; event_data: string }>;

    // Build hour buckets
    const now = Date.now();
    const currentHourStart = Math.floor(now / 3600000) * 3600000;
    const hours = 24;
    const bucketMap = new Map<number, { total_cost_usd: number; input_tokens: number; output_tokens: number }>();

    for (let i = hours - 1; i >= 0; i--) {
      const hourTs = currentHourStart - (i * 3600000);
      bucketMap.set(hourTs, { total_cost_usd: 0, input_tokens: 0, output_tokens: 0 });
    }

    for (const row of rows) {
      try {
        const data = JSON.parse(row.event_data);
        // Only include successful result events
        if (data.subtype !== 'success') continue;
        const bucket = bucketMap.get(row.hour_bucket);
        if (bucket) {
          bucket.total_cost_usd += (data.total_cost_usd || 0);
          if (data.usage) {
            bucket.input_tokens += (data.usage.input_tokens || 0);
            bucket.output_tokens += (data.usage.output_tokens || 0);
          }
        }
      } catch { /* skip unparseable event_data */ }
    }

    const result = Array.from(bucketMap.entries()).map(([ts, costs]) => ({
      hour: new Date(ts).toISOString(),
      ...costs
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Sessions overview with stats
app.get('/api/stats/sessions', (req, res) => {
  try {
    const sessions = db.prepare(`
      SELECT
        s.id, s.name, s.folder, s.lastActive, s.created,
        (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as messageCount,
        (SELECT COUNT(*) FROM sdk_events WHERE session_id = s.id AND event_type = 'result') as queryCount
      FROM sessions s
      ORDER BY s.lastActive DESC
    `).all() as Array<any>;

    const result = sessions.map((s: any) => ({
      ...s,
      isActive: activeQueries.has(s.id),
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Recent task runs with task names
app.get('/api/stats/task-runs', (req, res) => {
  try {
    const runs = db.prepare(`
      SELECT
        tr.id, tr.task_id, tr.session_id, tr.status,
        tr.trigger_type, tr.trigger_data,
        tr.started_at, tr.finished_at, tr.error, tr.result_summary,
        st.name as task_name
      FROM task_runs tr
      LEFT JOIN scheduled_tasks st ON tr.task_id = st.id
      ORDER BY tr.started_at DESC
      LIMIT 20
    `).all();

    res.json(runs);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ============================
// Session Message & Subscription API
// ============================

// Send a message to a session via REST (used by MCP server and agent-to-agent communication)
app.post('/api/sessions/:id/send', (req, res) => {
  const { content, sender_session_id, sender_session_name, type } = req.body;
  if (!content) {
    res.status(400).json({ error: 'Content is required' });
    return;
  }

  const session = stmts.getSession.get(req.params.id) as any;
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const hasActiveQuery = activeQueries.has(req.params.id);

  if (hasActiveQuery) {
    // Queue the message for delivery after current query completes
    const metadata = JSON.stringify({ sender_session_id, sender_session_name, type: type || 'agent_message' });
    stmts.enqueueMessage.run(req.params.id, type || 'agent_message', content, metadata);
    console.log(`[send] Queued message for session ${req.params.id} (active query)`);
    res.json({ status: 'queued', activeQuery: true });
  } else {
    // Process immediately
    processIncomingMessage(req.params.id, content).catch(e =>
      console.error(`[send] Failed to process message for session ${req.params.id}:`, e)
    );
    res.status(202).json({ status: 'processing', activeQuery: false });
  }
});

// Get queued messages for a session
app.get('/api/sessions/:id/queue', (req, res) => {
  const session = stmts.getSession.get(req.params.id) as any;
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const messages = stmts.getPendingMessages.all(req.params.id) as any[];
  const count = (stmts.getQueuedMessageCount.get(req.params.id) as any).cnt;
  res.json({ messages, count });
});

// Subscribe a session to a webhook path
app.post('/api/sessions/:id/subscribe', (req, res) => {
  const { webhook_path } = req.body;
  if (!webhook_path) {
    res.status(400).json({ error: 'webhook_path is required' });
    return;
  }
  const session = stmts.getSession.get(req.params.id) as any;
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  stmts.createSubscription.run(req.params.id, webhook_path);
  console.log(`[subscribe] Session ${req.params.id} subscribed to webhook path "${webhook_path}"`);
  res.json({ success: true, session_id: req.params.id, webhook_path });
});

// Unsubscribe a session from a webhook path
app.delete('/api/sessions/:id/subscribe/:path', (req, res) => {
  stmts.deleteSubscription.run(req.params.id, req.params.path);
  console.log(`[unsubscribe] Session ${req.params.id} unsubscribed from webhook path "${req.params.path}"`);
  res.json({ success: true });
});

// List webhook subscriptions for a session
app.get('/api/sessions/:id/subscriptions', (req, res) => {
  const subs = stmts.getSubscriptionsBySession.all(req.params.id) as any[];
  res.json(subs);
});

// Watch for query completion
app.post('/api/sessions/:id/watch', (req, res) => {
  const { subscriber_session_id } = req.body;
  if (!subscriber_session_id) {
    res.status(400).json({ error: 'subscriber_session_id is required' });
    return;
  }
  const target = stmts.getSession.get(req.params.id) as any;
  if (!target) {
    res.status(404).json({ error: 'Target session not found' });
    return;
  }
  stmts.querySubCreate.run(subscriber_session_id, req.params.id);
  res.json({ success: true, watching: req.params.id });
});

app.delete('/api/sessions/:id/watch', (req, res) => {
  const { subscriber_session_id } = req.body;
  if (!subscriber_session_id) {
    res.status(400).json({ error: 'subscriber_session_id is required' });
    return;
  }
  stmts.querySubDelete.run(subscriber_session_id, req.params.id);
  res.json({ success: true });
});

// ============================
// Webhook Endpoint
// ============================
app.post('/hook/:path', (req, res) => {
  const webhookPath = req.params.path;
  const task = stmts.getTaskByWebhookPath.get(webhookPath) as any;
  const subscriptions = stmts.getSubscriptionsByPath.all(webhookPath) as any[];

  // If no task AND no subscriptions, 404
  if (!task && subscriptions.length === 0) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }

  // Auth check (only for task-based webhooks)
  if (task?.webhook_secret) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${task.webhook_secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const triggerData = req.body || {};

  // Check for delay/schedule parameters
  const delaySeconds = triggerData._delay_seconds || req.query.delay_seconds;
  const scheduledAt = triggerData._scheduled_at || req.query.scheduled_at;

  if (delaySeconds || scheduledAt) {
    // Create a scheduled event instead of executing immediately
    const eventId = randomUUID();
    const fireAt = scheduledAt
      ? new Date(scheduledAt as string).toISOString()
      : new Date(Date.now() + Number(delaySeconds) * 1000).toISOString();

    // Strip delay params from the payload
    const { _delay_seconds, _scheduled_at, ...cleanData } = triggerData;

    stmts.createEvent.run(
      eventId, `Delayed webhook: ${webhookPath}`, 'webhook', fireAt,
      null, webhookPath, JSON.stringify(cleanData), null, null, null
    );

    console.log(`[webhook] Scheduled delayed webhook "${webhookPath}" for ${fireAt} (event: ${eventId})`);
    res.status(202).json({
      status: 'scheduled',
      event_id: eventId,
      scheduled_at: fireAt,
    });
    return;
  }

  // Execute the task if one exists (existing behavior)
  if (task && task.enabled) {
    executeTask(task, 'webhook', triggerData).catch(e =>
      console.error('Webhook task execution failed:', e)
    );
  }

  // Deliver to subscribed sessions
  if (subscriptions.length > 0) {
    const formattedMessage = `[Webhook Notification]\nYou received a message from webhook "${webhookPath}".\nYou're subscribed to this webhook. Here's the incoming data:\n\n${JSON.stringify(triggerData, null, 2)}`;

    for (const sub of subscriptions) {
      const hasActiveQuery = activeQueries.has(sub.session_id);
      if (hasActiveQuery) {
        // Queue the message
        const metadata = JSON.stringify({ webhook_path: webhookPath, type: 'webhook' });
        stmts.enqueueMessage.run(sub.session_id, 'webhook', formattedMessage, metadata);
        console.log(`[webhook] Queued message for session ${sub.session_id} (${sub.session_name}, active query)`);
      } else {
        // Send immediately
        processIncomingMessage(sub.session_id, formattedMessage).catch(e =>
          console.error(`[webhook] Failed to deliver to session ${sub.session_id}:`, e)
        );
        console.log(`[webhook] Delivering immediately to session ${sub.session_id} (${sub.session_name})`);
      }
    }
  }

  res.status(202).json({
    status: 'started',
    taskId: task?.id || null,
    subscribedSessions: subscriptions.length,
  });
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
            }
          }
          currentSessionId = message.sessionId;
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

        case 'rename_session': {
          const { sessionId: renameId, name: newName } = message;
          if (renameId && newName && typeof newName === 'string' && newName.trim().length > 0) {
            const trimmedName = newName.trim();
            stmts.renameSession.run(trimmedName, renameId);
            console.log(`[rename] Session ${renameId} renamed to "${trimmedName}"`);
            // Broadcast to all clients so sidebar updates in real-time
            broadcastToAll({
              type: 'session_renamed',
              sessionId: renameId,
              name: trimmedName,
            });
            ws.send(JSON.stringify({
              type: 'session_renamed',
              sessionId: renameId,
              name: trimmedName,
              success: true,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              error: 'rename_session requires a valid sessionId and non-empty name',
            }));
          }
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
      }
    }
  });
});

async function handleStartSession(ws: WebSocket, message: any) {
  const { sessionId } = message;

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
      broadcastQueryState(sessionId, false);
      notifyQueryWatchers(sessionId);
    }

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

    // Load session for folder and SDK session ID
    const sessionData = stmts.getSession.get(sessionId) as any;
    const sessionCwd = resolveSessionCwd(sessionData?.folder);

    // Load MCP config
    const mcpServers = loadMcpConfig();

    // Create query options
    const sessionName = sessionData?.name || 'Unknown';
    const options: SDKOptions = {
      cwd: sessionCwd,
      env: getSpawnEnv(),
      mcpServers,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: `\n\nYour identity: You are agent "${sessionName}" (session ID: ${sessionId}). You can use this information when communicating with other agents or when you need to identify yourself. You can rename yourself using: curl -X PATCH http://localhost:${PORT}/api/sessions/${sessionId} -H 'Content-Type: application/json' -d '{"name": "New Name"}'`,
      },
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
    broadcastQueryState(sessionId, true);

    // Save user message as SDK event for persistence
    if (prompt) {
      try {
        stmts.insertSdkEvent.run(
          sessionId,
          'user',
          JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }),
          0,
          Date.now()
        );
      } catch (e) {
        console.error('Failed to persist user SDK event:', e);
      }
    }

    // Stream events to client with error handling
    let turnIndex = 0;
    try {
      for await (const event of q) {
        // Increment turn on each assistant message
        if (event.type === 'assistant') {
          turnIndex++;
        }
        broadcastToSession(sessionId, {
          type: 'sdk_event',
          sessionId,
          event,
          timestamp: Date.now(),
        }, turnIndex);
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
      broadcastQueryState(sessionId, false);
      notifyQueryWatchers(sessionId);
      processNextQueuedMessage(sessionId);
    }
  } catch (error) {
    console.error('Error in query:', error);
    broadcastToSession(sessionId, {
      type: 'error',
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    activeQueries.delete(sessionId);
    broadcastQueryState(sessionId, false);
    notifyQueryWatchers(sessionId);
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

function broadcastToSession(sessionId: string, data: any, turnIndex: number = 0) {
  const connections = sessionConnections.get(sessionId);
  if (connections) {
    const message = JSON.stringify(data);
    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }

  // Persist SDK events to the new sdk_events table
  if (data.type === 'sdk_event' && data.event) {
    const event = data.event;
    const ts = data.timestamp || Date.now();

    // Save the SDK session ID for resumption
    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      saveSdkSessionId(sessionId, event.session_id);
    }

    // Persist all event types to sdk_events table
    try {
      stmts.insertSdkEvent.run(
        sessionId,
        event.type,
        JSON.stringify(event),
        turnIndex,
        ts
      );
    } catch (e) {
      console.error('Failed to persist SDK event:', e);
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

// Broadcast query state changes to all clients (for sidebar activity indicators)
function broadcastQueryState(sessionId: string, active: boolean) {
  broadcastToAll({ type: 'session_query_state', sessionId, active });
}

function notifyQueryWatchers(sessionId: string) {
  try {
    const watchers = stmts.querySubGetWatchers.all(sessionId) as any[];
    if (watchers.length === 0) return;

    const session = stmts.getSession.get(sessionId) as any;
    const sessionName = session?.name || sessionId;
    const message = `[Query Completed] Session "${sessionName}" has finished its query.`;

    for (const watcher of watchers) {
      const hasActiveQuery = activeQueries.has(watcher.subscriber_session_id);
      if (hasActiveQuery) {
        const metadata = JSON.stringify({ type: 'query_completion', target_session_id: sessionId });
        stmts.enqueueMessage.run(watcher.subscriber_session_id, 'query_completion', message, metadata);
        console.log(`[watch] Queued completion notification for ${watcher.subscriber_session_id}`);
      } else {
        processIncomingMessage(watcher.subscriber_session_id, message).catch(e =>
          console.error(`[watch] Failed to deliver completion notification to ${watcher.subscriber_session_id}:`, e)
        );
        console.log(`[watch] Delivering completion notification to ${watcher.subscriber_session_id}`);
      }
    }

    // One-shot: delete all subscriptions for this target
    stmts.querySubDeleteByTarget.run(sessionId);
  } catch (e) {
    console.error(`[watch] Error notifying query watchers for ${sessionId}:`, e);
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

// ============================
// Scheduled Task Execution Engine
// ============================
const activeCronJobs = new Map<string, Cron>();

function scheduleCronTask(task: any) {
  try {
    const job = new Cron(task.cron_expression, { timezone: task.timezone || 'UTC' }, () => {
      console.log(`[cron] Firing task "${task.name}" (${task.id})`);
      executeTask(task, 'cron').catch(e => console.error(`[cron] Task "${task.name}" failed:`, e));
    });
    activeCronJobs.set(task.id, job);
    console.log(`[cron] Scheduled task "${task.name}" with expression "${task.cron_expression}"`);
  } catch (e) {
    console.error(`[cron] Failed to schedule task "${task.name}":`, e);
  }
}

function unscheduleCronTask(taskId: string) {
  const job = activeCronJobs.get(taskId);
  if (job) {
    job.stop();
    activeCronJobs.delete(taskId);
  }
}

async function executeTask(task: any, triggerType: string, triggerData?: any): Promise<void> {
  const runId = randomUUID();
  let sessionId: string;

  try {
    // Create or reuse session
    if (task.session_mode === 'reuse' && task.session_id) {
      // Verify session exists
      const existing = stmts.getSession.get(task.session_id) as any;
      if (existing) {
        sessionId = task.session_id;
        stmts.updateLastActive.run(Date.now(), sessionId);
      } else {
        // Session was deleted, create new
        sessionId = createTaskSession(task);
      }
    } else {
      sessionId = createTaskSession(task);
    }

    // Insert task run record
    stmts.insertTaskRun.run(runId, task.id, sessionId, 'running', triggerType, triggerData ? JSON.stringify(triggerData) : null);

    // Build prompt
    let fullPrompt = task.prompt;
    if (triggerType === 'webhook' && triggerData) {
      fullPrompt = `<task_prompt>\n${task.prompt}\n</task_prompt>\n\n<webhook_data>\n${JSON.stringify(triggerData, null, 2)}\n</webhook_data>`;
    }

    // Load session for folder and SDK session ID
    const session = stmts.getSession.get(sessionId) as any;
    const sessionCwd = resolveSessionCwd(session?.folder);

    // Load MCP config
    const mcpServers = loadMcpConfig();

    // Create query options (0 = unlimited for turns/budget)
    const taskSessionName = session?.name || task.name || 'Unknown';
    const options: SDKOptions = {
      cwd: sessionCwd,
      env: getSpawnEnv(),
      mcpServers,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: `\n\nYour identity: You are agent "${taskSessionName}" (session ID: ${sessionId}). You can use this information when communicating with other agents or when you need to identify yourself. You can rename yourself using: curl -X PATCH http://localhost:${PORT}/api/sessions/${sessionId} -H 'Content-Type: application/json' -d '{"name": "New Name"}'`,
      },
      ...(task.max_turns > 0 && { maxTurns: task.max_turns }),
      ...(task.max_budget_usd > 0 && { maxBudgetUsd: task.max_budget_usd }),
      ...(task.model && { model: task.model }),
      canUseTool: async (toolName, input) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
    };

    if (session?.sdkSessionId) {
      options.resume = session.sdkSessionId;
    }

    // Save user message as SDK event
    stmts.insertSdkEvent.run(
      sessionId,
      'user',
      JSON.stringify({ type: 'user', message: { role: 'user', content: fullPrompt } }),
      0,
      Date.now()
    );

    // Run query
    const q = query({ prompt: fullPrompt, options });
    activeQueries.set(sessionId, q);
    broadcastQueryState(sessionId, true);

    let turnIndex = 0;
    try {
      for await (const event of q) {
        if (event.type === 'assistant') turnIndex++;

        // broadcastToSession handles both persistence (to sdk_events table)
        // and broadcasting to any connected clients viewing this session
        broadcastToSession(sessionId, {
          type: 'sdk_event',
          sessionId,
          event,
          timestamp: Date.now(),
        }, turnIndex);
      }

      // Query completed
      broadcastToSession(sessionId, { type: 'query_completed', sessionId });
      broadcastToAll({
        type: 'session_notification',
        sessionId,
        sessionName: (stmts.getSession.get(sessionId) as any)?.name || 'Task',
        notification: 'completed',
      });

      stmts.updateTaskRunStatus.run('completed', null, `Completed in ${turnIndex} turns`, runId);
      console.log(`[task] "${task.name}" completed successfully in ${turnIndex} turns`);
    } catch (iterError) {
      console.error(`[task] "${task.name}" iteration error:`, iterError);
      stmts.updateTaskRunStatus.run(
        'failed',
        iterError instanceof Error ? iterError.message : String(iterError),
        null,
        runId
      );
      broadcastToSession(sessionId, {
        type: 'error',
        sessionId,
        error: iterError instanceof Error ? iterError.message : String(iterError),
      });
    } finally {
      activeQueries.delete(sessionId);
      broadcastQueryState(sessionId, false);
      notifyQueryWatchers(sessionId);
      processNextQueuedMessage(sessionId);
    }
  } catch (error) {
    console.error(`[task] "${task.name}" execution error:`, error);
    stmts.updateTaskRunStatus.run(
      'failed',
      error instanceof Error ? error.message : String(error),
      null,
      runId
    );
  }
}

function createTaskSession(task: any): string {
  const id = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = Date.now();
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const name = `🤖 ${task.name} - ${dateStr}`;
  stmts.createSession.run(id, name, null, now, now, null);

  // Auto-subscribe to announcements topic
  const announcementsTopic = stmts.hubGetTopicByName.get('announcements') as any;
  if (announcementsTopic) {
    stmts.hubCreateSubscription.run(id, 'topic', announcementsTopic.id);
  }

  return id;
}

// ============================
// Message Queue Processing
// ============================

async function processIncomingMessage(sessionId: string, content: string): Promise<void> {
  // Close any existing active query for this session
  const existingQuery = activeQueries.get(sessionId);
  if (existingQuery) {
    console.log(`[processIncomingMessage] Closing existing query for session ${sessionId}`);
    try { existingQuery.close(); } catch (e) { console.error('[processIncomingMessage] Error closing existing query:', e); }
    activeQueries.delete(sessionId);
    broadcastQueryState(sessionId, false);
    notifyQueryWatchers(sessionId);
  }

  // Save user message
  stmts.insertMessage.run(sessionId, 'user', content, Date.now(), 0, null);
  stmts.updateLastActive.run(Date.now(), sessionId);

  // Save as SDK event
  try {
    stmts.insertSdkEvent.run(
      sessionId, 'user',
      JSON.stringify({ type: 'user', message: { role: 'user', content } }),
      0, Date.now()
    );
  } catch (e) {
    console.error('[processIncomingMessage] Failed to persist user SDK event:', e);
  }

  // Load session for folder and SDK session ID
  const session = stmts.getSession.get(sessionId) as any;
  const sessionCwd = resolveSessionCwd(session?.folder);
  const incomingSessionName = session?.name || 'Unknown';

  // Load MCP config and create query options
  const mcpServers = loadMcpConfig();
  const options: SDKOptions = {
    cwd: sessionCwd,
    env: getSpawnEnv(),
    mcpServers,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `\n\nYour identity: You are agent "${incomingSessionName}" (session ID: ${sessionId}). You can use this information when communicating with other agents or when you need to identify yourself. You can rename yourself using: curl -X PATCH http://localhost:${PORT}/api/sessions/${sessionId} -H 'Content-Type: application/json' -d '{"name": "New Name"}'`,
    },
    canUseTool: async (toolName: string, input: any) => ({
      behavior: 'allow' as const,
      updatedInput: input,
    }),
  };

  if (session?.sdkSessionId) {
    options.resume = session.sdkSessionId;
  }

  const q = query({ prompt: content, options });
  activeQueries.set(sessionId, q);
  broadcastQueryState(sessionId, true);

  let turnIndex = 0;
  try {
    for await (const event of q) {
      if (event.type === 'assistant') turnIndex++;
      broadcastToSession(sessionId, {
        type: 'sdk_event',
        sessionId,
        event,
        timestamp: Date.now(),
      }, turnIndex);
    }

    broadcastToSession(sessionId, { type: 'query_completed', sessionId });
    broadcastToAll({
      type: 'session_notification',
      sessionId,
      sessionName: (stmts.getSession.get(sessionId) as any)?.name || 'Unknown',
      notification: 'completed',
    });
  } catch (iterError) {
    console.error('[processIncomingMessage] Iteration error:', iterError);
    broadcastToSession(sessionId, {
      type: 'error',
      sessionId,
      error: iterError instanceof Error ? iterError.message : String(iterError),
    });
  } finally {
    activeQueries.delete(sessionId);
    broadcastQueryState(sessionId, false);
    notifyQueryWatchers(sessionId);
    // Drain next queued message
    processNextQueuedMessage(sessionId);
  }
}

function processNextQueuedMessage(sessionId: string) {
  const pending = stmts.getPendingMessages.all(sessionId) as any[];
  if (pending.length === 0) return;

  const next = pending[0];
  stmts.updateMessageStatus.run('processing', next.id);
  console.log(`[queue] Processing queued message ${next.id} for session ${sessionId} (${pending.length} pending)`);

  // Fire-and-forget the next message
  processIncomingMessage(sessionId, next.content)
    .then(() => {
      stmts.updateMessageStatus.run('delivered', next.id);
      console.log(`[queue] Delivered queued message ${next.id}`);
    })
    .catch((e) => {
      console.error(`[queue] Failed to process queued message ${next.id}:`, e);
      stmts.updateMessageStatus.run('failed', next.id);
      // Try next message even if this one failed
      processNextQueuedMessage(sessionId);
    });
}

// ============================
// Hub Notification System
// ============================
const NTFY_CHANNEL = 'jerome-agent-hub-notifications';

async function sendNtfyNotification(title: string, message: string, tags?: string) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_CHANNEL}`, {
      method: 'POST',
      headers: {
        'Title': title,
        'Tags': tags || 'speech_balloon',
      },
      body: message,
    });
  } catch (e) {
    console.error('[ntfy] Failed to send notification:', e);
  }
}

function notifyHubSubscribers(
  subscriptionType: 'topic' | 'post',
  targetId: string,
  message: string,
  excludeSessionId?: string
) {
  const subs = stmts.hubGetSubscriptionsByTarget.all(subscriptionType, targetId) as any[];

  // Also notify topic subscribers when a new comment is on a post in that topic
  let topicSubs: any[] = [];
  if (subscriptionType === 'post') {
    const post = stmts.hubGetPost.get(targetId) as any;
    if (post) {
      topicSubs = stmts.hubGetSubscriptionsByTarget.all('topic', post.topic_id) as any[];
    }
  }

  // Combine and deduplicate by session_id
  const allSubs = [...subs, ...topicSubs];
  const seen = new Set<string>();

  for (const sub of allSubs) {
    if (seen.has(sub.session_id)) continue;
    if (sub.session_id === excludeSessionId) continue;
    seen.add(sub.session_id);

    const hasActiveQuery = activeQueries.has(sub.session_id);
    const formattedMessage = `[Hub Notification]\n${message}`;

    if (hasActiveQuery) {
      const metadata = JSON.stringify({ type: 'hub_notification', subscription_type: subscriptionType, target_id: targetId });
      stmts.enqueueMessage.run(sub.session_id, 'hub_notification', formattedMessage, metadata);
      console.log(`[hub] Queued notification for session ${sub.session_id} (active query)`);
    } else {
      processIncomingMessage(sub.session_id, formattedMessage).catch(e =>
        console.error(`[hub] Failed to deliver notification to session ${sub.session_id}:`, e)
      );
      console.log(`[hub] Delivering notification to session ${sub.session_id}`);
    }
  }

  // Broadcast via WebSocket for real-time UI updates
  broadcastToAll({
    type: 'hub_update',
    subscription_type: subscriptionType,
    target_id: targetId,
  });
}

// Initialize cron scheduler on startup
function initCronScheduler() {
  // Mark any runs that were in-progress when server stopped
  stmts.markInterruptedRuns.run();

  // Load and schedule all enabled cron tasks
  const tasks = stmts.getEnabledCronTasks.all() as any[];
  console.log(`[cron] Loading ${tasks.length} scheduled task(s)`);
  for (const task of tasks) {
    scheduleCronTask(task);
  }
}

// Initialize announcements topic and auto-subscribe all sessions
ensureAnnouncementsTopic();
autoSubscribeAnnouncementsTopic();

initCronScheduler();

// ============================
// Scheduled Event Processor
// ============================
const EVENT_POLL_INTERVAL_MS = 10_000; // Check every 10 seconds

// Mark events that were running when server stopped as failed
db.prepare("UPDATE scheduled_events SET status='failed', error='Server restarted during execution' WHERE status='running'").run();

async function processScheduledEvents() {
  const dueEvents = stmts.getDueEvents.all() as any[];

  for (const event of dueEvents) {
    // Mark as running (prevents double-processing)
    const result = stmts.markEventRunning.run(event.id);
    if (result.changes === 0) continue; // Already picked up

    console.log(`[events] Executing event "${event.name || event.id}" (type: ${event.type})`);

    try {
      let summary = '';

      switch (event.type) {
        case 'task': {
          const task = stmts.getTask.get(event.task_id) as any;
          if (!task) throw new Error(`Task ${event.task_id} not found`);
          const triggerData = event.metadata ? JSON.parse(event.metadata) : undefined;
          await executeTask(task, 'scheduled_event', triggerData);
          summary = `Ran task "${task.name}"`;
          break;
        }
        case 'webhook': {
          const webhookPath = event.webhook_path;
          const webhookData = event.webhook_data ? JSON.parse(event.webhook_data) : {};

          // Execute task if one exists for this path
          const task = stmts.getTaskByWebhookPath.get(webhookPath) as any;
          if (task && task.enabled) {
            await executeTask(task, 'webhook', webhookData);
          }

          // Deliver to subscribed sessions
          const subs = stmts.getSubscriptionsByPath.all(webhookPath) as any[];
          const formattedMessage = `[Scheduled Webhook]\nDelayed webhook for path "${webhookPath}".\nHere's the data:\n\n${JSON.stringify(webhookData, null, 2)}`;
          for (const sub of subs) {
            if (activeQueries.has(sub.session_id)) {
              stmts.enqueueMessage.run(sub.session_id, 'webhook', formattedMessage, JSON.stringify({ webhook_path: webhookPath, type: 'scheduled_webhook' }));
            } else {
              processIncomingMessage(sub.session_id, formattedMessage).catch(e =>
                console.error(`[events] Failed to deliver to session ${sub.session_id}:`, e)
              );
            }
          }
          summary = `Delivered webhook "${webhookPath}" to ${subs.length} subscriber(s)${task ? ' + task' : ''}`;
          break;
        }
        case 'message': {
          const session = stmts.getSession.get(event.session_id) as any;
          if (!session) throw new Error(`Session ${event.session_id} not found`);

          if (activeQueries.has(event.session_id)) {
            stmts.enqueueMessage.run(event.session_id, 'scheduled_event', event.message_content, JSON.stringify({ event_id: event.id }));
            summary = 'Message queued (session busy)';
          } else {
            await processIncomingMessage(event.session_id, event.message_content);
            summary = 'Message delivered';
          }
          break;
        }
        default:
          throw new Error(`Unknown event type: ${event.type}`);
      }

      stmts.updateEventStatus.run('completed', null, summary, event.id);
      console.log(`[events] Event "${event.name || event.id}" completed: ${summary}`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      stmts.updateEventStatus.run('failed', errMsg, null, event.id);
      console.error(`[events] Event "${event.name || event.id}" failed:`, errMsg);
    }
  }
}

// Start polling loop
const eventPollInterval = setInterval(() => {
  processScheduledEvents().catch(e => console.error('[events] Poll error:', e));
}, EVENT_POLL_INTERVAL_MS);

// Process any overdue events immediately on startup
processScheduledEvents().catch(e => console.error('[events] Startup processing error:', e));

// ============================
// Graceful Shutdown
// ============================
async function gracefulShutdown(signal: string) {
  console.log(`[shutdown] Received ${signal}, starting graceful shutdown...`);

  // 1. Mark all sessions with active queries for resurrection
  for (const sessionId of activeQueries.keys()) {
    stmts.markSessionQuerying.run(1, sessionId);
    console.log(`[shutdown] Marked session ${sessionId} for resurrection`);
  }

  // 2. Close all active queries gracefully
  for (const [sessionId, q] of activeQueries.entries()) {
    try {
      q.close();
      console.log(`[shutdown] Closed query for session ${sessionId}`);
    } catch (e) {
      console.error(`[shutdown] Error closing query for ${sessionId}:`, e);
    }
  }
  activeQueries.clear();

  // 3. Stop cron jobs
  for (const [taskId, job] of activeCronJobs.entries()) {
    job.stop();
    console.log(`[shutdown] Stopped cron job ${taskId}`);
  }
  activeCronJobs.clear();

  // 4. Stop polling intervals
  clearInterval(heartbeatInterval);
  clearInterval(eventPollInterval);

  // 5. Close WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close(1012, 'Server restarting');
  });

  // 6. Close the HTTP server
  server.close(() => {
    console.log('[shutdown] HTTP server closed');
    db.close();
    console.log('[shutdown] Database closed');
    process.exit(0);
  });

  // Force exit after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error('[shutdown] Forced exit after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================
// Query Resurrection on Startup
// ============================
async function resurrectQueries() {
  const sessions = stmts.getQueryingSessions.all() as any[];
  if (sessions.length === 0) return;

  console.log(`[resurrect] Found ${sessions.length} session(s) to resume`);

  // Clear the was_querying flags now that we've read them
  stmts.clearAllQuerying.run();

  // Stagger resumptions to avoid overwhelming the system
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const delay = i * 2000; // 2 second stagger between each

    setTimeout(() => {
      console.log(`[resurrect] Resuming session "${session.name}" (${session.id})`);
      processIncomingMessage(
        session.id,
        '[System] The server was restarted. You were in the middle of working on something. Please check your current state and continue where you left off. If you were implementing a feature, check what files you\'ve already modified and what still needs to be done.'
      ).catch(e => {
        console.error(`[resurrect] Failed to resume session ${session.id}:`, e);
      });
    }, delay);
  }
}

// Start server
const HOST = '0.0.0.0';
server.listen(Number(PORT), HOST, () => {
  console.log(`Claude Web Frontend running on http://${HOST}:${PORT}`);
  console.log(`Accessible via Tailscale at http://100.110.255.35:${PORT}`);
  console.log(`Database: ${DB_FILE}`);

  // Resurrect queries that were active before restart
  resurrectQueries();

  // Drain any pending queued messages from before restart
  setTimeout(() => {
    const allSessions = stmts.getAllSessions.all() as any[];
    for (const session of allSessions) {
      if (!activeQueries.has(session.id)) {
        processNextQueuedMessage(session.id);
      }
    }
  }, 5000); // Wait 5s for resurrections to start first
});
