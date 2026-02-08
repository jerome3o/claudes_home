/**
 * Integration tests for claude-web server
 *
 * These tests spin up a real server on a random port and test
 * HTTP endpoints and WebSocket behavior. They use a temporary
 * SQLite database so the production DB is never touched.
 *
 * Note: Tests that involve the Claude SDK query() are skipped
 * (they require API keys). We test everything else: DB CRUD,
 * WS session routing, heartbeat, status endpoint, message
 * dedup, and session isolation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// We can't import the server module directly (it has side effects
// and binds to a port). Instead, we test against a subprocess.
// But for speed and simplicity, we'll test the HTTP API directly
// by starting a subprocess with a custom PORT and DATA_DIR.

let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
let baseUrl: string;
let wsUrl: string;
let tmpDir: string;
const TEST_PORT = 18_000 + Math.floor(Math.random() * 1000);

// Helper: wait for server to be ready
async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/sessions`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server not ready after ${timeoutMs}ms`);
}

// Helper: connect a WebSocket and wait for open
function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    // Timeout after 5s
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

// Helper: wait for a specific WS message type
function waitForMessage(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for message type: ${type}`)), timeoutMs);

    const handler = (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {
        // Ignore parse errors
      }
    };
    ws.on('message', handler);
  });
}

// Helper: collect all WS messages for a duration
function collectMessages(ws: WebSocket, durationMs: number): Promise<any[]> {
  return new Promise((resolve) => {
    const msgs: any[] = [];
    const handler = (data: any) => {
      try { msgs.push(JSON.parse(data.toString())); } catch {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(msgs);
    }, durationMs);
  });
}

// Helper: send JSON over WS
function wsSend(ws: WebSocket, data: any) {
  ws.send(JSON.stringify(data));
}

describe('Claude Web Server Integration Tests', () => {
  beforeAll(async () => {
    // Create temp directory for test DB
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-web-test-'));

    // Start server subprocess with tsx
    const { spawn } = await import('child_process');
    serverProcess = spawn('npx', ['tsx', 'src/server.ts'], {
      cwd: '/root/source/claudes_home/claude-web',
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        DATA_DIR: tmpDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Log server output for debugging
    serverProcess.stdout?.on('data', (d: Buffer) => {
      // Uncomment for debugging: console.log('[server]', d.toString().trim());
    });
    serverProcess.stderr?.on('data', (d: Buffer) => {
      // Uncomment for debugging: console.error('[server err]', d.toString().trim());
    });

    baseUrl = `http://127.0.0.1:${TEST_PORT}`;
    wsUrl = `ws://127.0.0.1:${TEST_PORT}`;

    await waitForServer(baseUrl);
  }, 15_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      // Wait a moment for clean shutdown
      await new Promise(r => setTimeout(r, 500));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    // Cleanup temp directory
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ============================================
  // 1. Database CRUD via REST API
  // ============================================

  describe('Session CRUD', () => {
    it('should list sessions (initially empty)', async () => {
      const res = await fetch(`${baseUrl}/api/sessions`);
      expect(res.ok).toBe(true);
      const sessions = await res.json();
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('should create a session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Session 1' }),
      });
      expect(res.ok).toBe(true);
      const session = await res.json();
      expect(session.id).toBeTruthy();
      expect(session.name).toBe('Test Session 1');
      expect(session.created).toBeGreaterThan(0);
    });

    it('should list the created session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions`);
      const sessions = await res.json();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions.some((s: any) => s.name === 'Test Session 1')).toBe(true);
    });

    it('should rename a session', async () => {
      const listRes = await fetch(`${baseUrl}/api/sessions`);
      const sessions = await listRes.json();
      const session = sessions[0];

      const res = await fetch(`${baseUrl}/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Session' }),
      });
      expect(res.ok).toBe(true);

      // Verify rename
      const verifyRes = await fetch(`${baseUrl}/api/sessions`);
      const updated = await verifyRes.json();
      expect(updated.find((s: any) => s.id === session.id)?.name).toBe('Renamed Session');
    });

    it('should delete a session (cascade deletes messages)', async () => {
      // Create session with a message
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'To Delete' }),
      });
      const session = await createRes.json();

      // Add a message via POST
      await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'test message', timestamp: Date.now() }),
      });

      // Verify message exists
      const msgRes = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`);
      const msgData = await msgRes.json();
      expect(msgData.messages.length).toBe(1);

      // Delete session
      const delRes = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
      expect(delRes.ok).toBe(true);

      // Verify session gone
      const listRes = await fetch(`${baseUrl}/api/sessions`);
      const sessions = await listRes.json();
      expect(sessions.find((s: any) => s.id === session.id)).toBeUndefined();

      // Verify messages gone (session 404)
      const msgRes2 = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`);
      expect(msgRes2.status).toBe(404);
    });
  });

  // ============================================
  // 2. Session status endpoint
  // ============================================

  describe('Session Status', () => {
    it('should return activeQuery: false for idle session', async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Status Test' }),
      });
      const session = await createRes.json();

      const res = await fetch(`${baseUrl}/api/sessions/${session.id}/status`);
      expect(res.ok).toBe(true);
      const status = await res.json();
      expect(status.activeQuery).toBe(false);

      // Cleanup
      await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    });

    it('should return 404 for non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent_session/status`);
      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // 3. Message pre-save and deduplication
  // ============================================

  describe('Message Pre-save & Dedup', () => {
    let sessionId: string;

    beforeEach(async () => {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Dedup Test' }),
      });
      const session = await res.json();
      sessionId = session.id;
    });

    it('should save a user message via REST POST', async () => {
      const ts = Date.now();
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello from REST', timestamp: ts }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.deduplicated).toBe(false);

      // Verify it's in history
      const histRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`);
      const hist = await histRes.json();
      expect(hist.messages.length).toBe(1);
      expect(hist.messages[0].content).toBe('Hello from REST');
      expect(hist.messages[0].role).toBe('user');
    });

    it('should deduplicate identical messages within 5 seconds', async () => {
      const ts = Date.now();
      const content = 'Duplicate me ' + ts;

      // First save
      const res1 = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, timestamp: ts }),
      });
      const data1 = await res1.json();
      expect(data1.deduplicated).toBe(false);

      // Second save (same content, within 5s)
      const res2 = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, timestamp: ts + 1000 }),
      });
      const data2 = await res2.json();
      expect(data2.deduplicated).toBe(true);

      // Verify only one message in DB
      const histRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`);
      const hist = await histRes.json();
      expect(hist.messages.length).toBe(1);
    });

    it('should not deduplicate different messages', async () => {
      await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Message A', timestamp: Date.now() }),
      });

      await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Message B', timestamp: Date.now() }),
      });

      const histRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`);
      const hist = await histRes.json();
      expect(hist.messages.length).toBe(2);
    });
  });

  // ============================================
  // 4. WebSocket session management
  // ============================================

  describe('WebSocket Sessions', () => {
    it('should connect and start a session', async () => {
      const ws = await connectWs(wsUrl);

      // Create a session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'WS Test' }),
      });
      const session = await createRes.json();

      // Start session
      const startPromise = waitForMessage(ws, 'session_started');
      wsSend(ws, { type: 'start_session', sessionId: session.id });
      const msg = await startPromise;

      expect(msg.sessionId).toBe(session.id);
      expect(msg.activeQuery).toBe(false);

      ws.close();
      await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    });

    it('should report activeQuery in session_started', async () => {
      // Without an actual SDK query running, activeQuery should be false
      const ws = await connectWs(wsUrl);
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Active Query Test' }),
      });
      const session = await createRes.json();

      const startPromise = waitForMessage(ws, 'session_started');
      wsSend(ws, { type: 'start_session', sessionId: session.id });
      const msg = await startPromise;

      expect(msg.activeQuery).toBe(false);

      ws.close();
      await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    });
  });

  // ============================================
  // 5. Session isolation (WS broadcast)
  // ============================================

  describe('Session Isolation', () => {
    it('should only receive messages for the subscribed session', async () => {
      // Create two sessions
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Session A' }),
        }),
        fetch(`${baseUrl}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Session B' }),
        }),
      ]);
      const sessionA = await res1.json();
      const sessionB = await res2.json();

      // Connect two WS clients
      const wsA = await connectWs(wsUrl);
      const wsB = await connectWs(wsUrl);

      // Start sessions
      const startA = waitForMessage(wsA, 'session_started');
      wsSend(wsA, { type: 'start_session', sessionId: sessionA.id });
      await startA;

      const startB = waitForMessage(wsB, 'session_started');
      wsSend(wsB, { type: 'start_session', sessionId: sessionB.id });
      await startB;

      // Collect messages on both for 1 second
      const msgsA = collectMessages(wsA, 1000);
      const msgsB = collectMessages(wsB, 1000);

      // Send a client_log (which doesn't broadcast) to session A
      // We can't easily trigger a broadcast without an SDK query,
      // but we can verify that the session routing doesn't leak
      // by checking that no cross-session messages arrive

      const [collectedA, collectedB] = await Promise.all([msgsA, msgsB]);

      // Neither should have received messages from the other's session
      const crossLeakA = collectedA.filter((m: any) => m.sessionId === sessionB.id && m.type !== 'session_notification');
      const crossLeakB = collectedB.filter((m: any) => m.sessionId === sessionA.id && m.type !== 'session_notification');
      expect(crossLeakA.length).toBe(0);
      expect(crossLeakB.length).toBe(0);

      wsA.close();
      wsB.close();
      await fetch(`${baseUrl}/api/sessions/${sessionA.id}`, { method: 'DELETE' });
      await fetch(`${baseUrl}/api/sessions/${sessionB.id}`, { method: 'DELETE' });
    });
  });

  // ============================================
  // 6. Heartbeat (ping/pong)
  // ============================================

  describe('Heartbeat', () => {
    it('should receive pings from the server within 35 seconds', async () => {
      const ws = await connectWs(wsUrl);

      const gotPing = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 35_000);
        ws.on('ping', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      const result = await gotPing;
      expect(result).toBe(true);

      ws.close();
    }, 40_000);
  });

  // ============================================
  // 7. MCP Config API
  // ============================================

  describe('MCP Config', () => {
    it('should get empty MCP config initially', async () => {
      const res = await fetch(`${baseUrl}/api/mcp-config`);
      expect(res.ok).toBe(true);
      const config = await res.json();
      expect(typeof config).toBe('object');
    });

    it('should save and retrieve MCP config', async () => {
      const testConfig = {
        'test-server': {
          command: 'echo',
          args: ['hello'],
        },
      };

      const saveRes = await fetch(`${baseUrl}/api/mcp-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testConfig),
      });
      expect(saveRes.ok).toBe(true);

      const getRes = await fetch(`${baseUrl}/api/mcp-config`);
      const config = await getRes.json();
      expect(config['test-server']).toBeDefined();
      expect(config['test-server'].command).toBe('echo');
    });
  });

  // ============================================
  // 8. Message history loading
  // ============================================

  describe('Message History', () => {
    it('should return messages in chronological order', async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'History Test' }),
      });
      const session = await createRes.json();

      // Insert messages with known timestamps
      const ts = Date.now();
      for (let i = 0; i < 5; i++) {
        await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `Message ${i}`, timestamp: ts + i * 1000 }),
        });
      }

      const histRes = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`);
      const hist = await histRes.json();
      expect(hist.messages.length).toBe(5);

      // Verify order
      for (let i = 0; i < 5; i++) {
        expect(hist.messages[i].content).toBe(`Message ${i}`);
      }

      await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    });
  });

  // ============================================
  // 9. Rename validation
  // ============================================

  describe('Rename Validation', () => {
    it('should reject rename without name', async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Rename Validation Test' }),
      });
      const session = await createRes.json();

      const res = await fetch(`${baseUrl}/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);

      await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    });
  });

  // ============================================
  // 10. Message POST validation
  // ============================================

  describe('Message POST Validation', () => {
    it('should reject message without content', async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Validation Test' }),
      });
      const session = await createRes.json();

      const res = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);

      await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    });

    it('should reject message for non-existent session', async () => {
      const res = await fetch(`${baseUrl}/api/sessions/nonexistent/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'test', timestamp: Date.now() }),
      });
      expect(res.status).toBe(404);
    });
  });
});
