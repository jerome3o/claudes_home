# Claude Web — Mobile-First Claude Agent SDK Frontend

## Overview

This is a PWA (Progressive Web App) that provides a mobile-first chat interface for the Claude Agent SDK. The primary user (Jerome) accesses it from a **Google Pixel Fold** phone via Tailscale HTTPS at `https://claude.tail8904.ts.net`. It is installed as a standalone PWA on the phone's home screen.

You (Claude) are running on a Linux server (`claude` on Tailscale, IP `100.110.255.35`). The user's phone is `google-pixel-10-pro-fold` on the same tailnet.

## Architecture

```
Phone (Pixel Fold)                     Server (Linux)
┌──────────────┐                ┌────────────────────────────────┐
│  PWA (app.js)│◄──WSS/HTTPS──►│ Tailscale Serve (port 443)     │
│  standalone  │                │   └─► Express + WS (port 8080) │
│  mode        │                │        ├─ SQLite (sessions/msgs)│
│              │                │        ├─ Claude Agent SDK      │
│              │                │        ├─ VNC proxy (/vnc/)     │
│              │                │        └─ MCP servers           │
└──────────────┘                │                                │
                                │ Docker: webtop (port 3000)     │
                                │   ├─ computer-use-mcp          │
                                │   ├─ chrome-devtools-mcp       │
                                │   └─ Chromium + XFCE desktop   │
                                └────────────────────────────────┘
```

### Networking

- **Tailscale Serve** handles HTTPS termination: `tailscale serve` proxies `https://claude.tail8904.ts.net` → `http://127.0.0.1:8080`
- The Express server itself is plain HTTP on port 8080 — Tailscale adds TLS
- WebSocket upgrades pass through Tailscale Serve transparently (WSS → WS)
- **Tailnet only** — not exposed to the public internet

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Server | `src/server.ts` | Express + WS server, Claude SDK query runner |
| Client | `public/app.js` | Vanilla JS PWA frontend (~1400 lines) |
| Styles | `public/styles.css` | Dark theme, compact mobile-first UI |
| Service Worker | `public/service-worker.js` | Cache management, offline shell |
| PWA Manifest | `public/manifest.json` | Standalone display, icons |
| Database | `data/claude.db` | SQLite (better-sqlite3), WAL mode |
| MCP Config | `data/mcp-config.json` | MCP server definitions |
| Tests | `src/server.test.ts` | 20 integration tests (Vitest) |

## User Preferences

The user (Jerome) has strong opinions about the UI:

- **Compact UI**: Small text, tight spacing, information-dense. Role labels are 0.75rem uppercase, content is 0.9rem. Don't add whitespace padding.
- **Status awareness**: The user wants to always know what's happening. There's a connection status pill in the header (green/yellow/red dot + label), message send acknowledgments ("Sent ✓", "Starting Claude...", spinner), and tool activity shown in the status bar.
- **MCP server status**: Shown as tiny inline pills with colored dots, NOT verbose blocks.
- **Result stats**: Compact single-line format: `3 turns · $0.0234 · 1200↓ 450↑`
- **Dark theme only**: Background #0f0f0f, no light mode.
- **Reliability over features**: The user prioritizes connection reliability, state sync on reconnect, and message durability over new features.
- **Test coverage**: 80/20 approach — maximum benefit for least work. Integration tests that spin up a real server and test HTTP + WebSocket behavior.

## Development

### Prerequisites

- Node.js 20+ (via nvm: `/root/.nvm/versions/node/v20.20.0/`)
- Docker (for webtop container)
- Tailscale (for HTTPS access)

### Commands

```bash
npm run dev        # Dev server with hot reload (tsx watch)
npm run build      # TypeScript → dist/
npm start          # Production server (node dist/server.js)
npm test           # Run integration tests (vitest)
npm run test:watch # Watch mode tests
```

### Build & Deploy

```bash
npm run build && systemctl restart claude-web
```

**WARNING**: `systemctl restart claude-web` will kill the current WebSocket connection if you're running inside this app. The client will auto-reconnect with exponential backoff, and the connection status pill will show the reconnect state. If a query was running, the server has a 10-second grace timer before aborting orphaned queries.

### Service Worker Cache

After changing client files (`app.js`, `styles.css`, `index.html`), bump the cache version in `public/service-worker.js`:

```js
const CACHE_NAME = 'claude-v12'; // Increment this
```

The user needs to tap "Refresh App" in the sidebar to pick up changes (or the service worker will update on next visit via stale-while-revalidate).

### Systemd Service

```ini
# /etc/systemd/system/claude-web.service
[Service]
WorkingDirectory=/root/source/claudes_home/claude-web
ExecStart=/root/.nvm/versions/node/v20.20.0/bin/npm start
Environment="PORT=8080"
Restart=always
RestartSec=10
StandardOutput=append:/var/log/claude-web/output.log
StandardError=append:/var/log/claude-web/error.log
```

View logs: `journalctl -u claude-web -f` or `tail -f /var/log/claude-web/output.log`

## Server (`src/server.ts`)

### Database

SQLite via better-sqlite3 with WAL mode and prepared statements. Two tables:

- **sessions**: id, name, folder, created, lastActive, sdkSessionId
- **messages**: id, session_id (FK CASCADE), role, content, timestamp, useMarkdown, status

Auto-migrates from legacy `sessions.json` on first run if DB is empty.

### WebSocket Protocol

Client connects via WSS. Messages are JSON with a `type` field:

**Client → Server:**
- `start_session { sessionId }` — join a session (re-routes WS)
- `send_message { sessionId, prompt, resume?, images? }` — start a query
- `interrupt { sessionId }` — gracefully interrupt
- `set_mcp_servers { sessionId, servers }` — update MCP config
- `client_log { level, message }` — remote console logging

**Server → Client:**
- `session_started { sessionId, activeQuery }` — session joined + query state
- `sdk_event { sessionId, event }` — Claude SDK events (streamed)
- `query_completed { sessionId }` — query done
- `interrupted { sessionId }` — query interrupted
- `error { sessionId, error }` — error
- `session_notification { sessionId, sessionName, notification }` — cross-session (toasts)

### Query Lifecycle (Reliability)

1. **Orphan abort**: When all clients disconnect from a session, a 10-second grace timer starts. If no client reconnects, the query is forcefully closed via `q.close()` to save API quota.
2. **Session switch abort**: Same timer logic on session switch — if old session has no clients, orphan timer starts.
3. **Query overwrite prevention**: If `send_message` arrives while a query is running, the old query is closed first.
4. **Heartbeat**: Server pings all clients every 30 seconds. Unresponsive clients (no pong) are terminated on the next cycle.

### REST API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Create session |
| DELETE | `/api/sessions/:id` | Delete session + messages |
| PATCH | `/api/sessions/:id` | Rename session |
| GET | `/api/sessions/:id/messages` | Load message history |
| POST | `/api/sessions/:id/messages` | Pre-save user message (dedup) |
| GET | `/api/sessions/:id/status` | Query running? (reconnect sync) |
| GET/POST | `/api/mcp-config` | MCP server configuration |
| POST | `/api/webtop/restart` | Restart Docker webtop container |

### Message Durability

User messages are saved via two paths (belt + suspenders):
1. **REST pre-save**: Client fires `POST /api/sessions/:id/messages` before WS send (survives WS drop)
2. **WS save**: Server saves in `handleSendMessage` on receipt

Both paths deduplicate: identical content within 5 seconds is skipped.

## Client (`public/app.js`)

### Connection Status

The header shows a colored pill with connection state:
- 🟢 `OK · 12s` — connected, seconds since last ping
- 🟡 `CONNECTING` / `RETRY 3` — reconnecting (with backoff)
- 🔴 `OFFLINE` — disconnected
- 🟢 `SENDING` → `INITIALIZING` → `RESPONDING` → `TOOL: Bash` — query activity

### Reconnection Logic

Exponential backoff with jitter: 1s → 2s → 4s → 8s → 16s → 30s max (±30% jitter). On reconnect:
1. Checks `GET /api/sessions/:id/status` to sync query state
2. If query still running: shows interrupt button, sets `isSending`
3. If server restarted mid-query: reloads session history, shows toast
4. `session_started` message includes `activeQuery` flag

### Session Switch Race Prevention

A sequence counter (`selectSessionSeq`) increments on each `selectSession()`. If the user rapidly switches sessions, stale `loadSessionHistory()` responses are discarded (the fetch response's sequence number won't match the current counter).

### Remote Console Logging

All `console.log/warn/error/info` calls are intercepted and piped to the server via `client_log` WS messages. This lets you see phone-side logs in the server terminal.

### Features

- **Multi-session**: Create, rename, delete sessions. Concurrent queries across sessions.
- **Cross-session notifications**: Toast when a background session's query completes. Unread badges on sessions + hamburger menu.
- **Image upload**: Attach images (base64), sent as multimodal SDK messages.
- **MCP config editor**: JSON editor modal for MCP server configuration.
- **VNC viewer**: Picture-in-picture webtop desktop viewer (draggable, resizable, minimizable).
- **PWA**: Installable, offline shell, standalone mode with gesture bar handling.

## Webtop Desktop Environment

A Docker container (`webtop-mcp`) based on LinuxServer.io Webtop (Ubuntu + XFCE) provides a desktop environment for visual testing and computer use.

### Docker Setup

```bash
# From /root/source/claudes_home/
docker-compose up -d
```

The `Dockerfile` installs `computer-use-mcp` and `chrome-devtools-mcp` globally via npm. The desktop is accessible at `http://localhost:3000` (proxied through the app at `/vnc/`).

### MCP Servers (in-app)

Configured in `data/mcp-config.json` and editable via the MCP Config modal:

1. **computer-use** — Screenshot, click, type, scroll the desktop
2. **chrome-devtools** — Navigate, evaluate JS, click elements, take screenshots in Chromium (port 9222)
3. **discord** — Send/read Discord messages, reactions (custom MCP server)

### Testing the UI

**You should use the webtop and Chrome DevTools MCP to test the app visually.** Open `https://claude.tail8904.ts.net` in the webtop's Chromium browser and use the chrome-devtools tools to:
- Navigate to the app
- Take screenshots to verify layout
- Evaluate JavaScript in the console
- Click elements and fill forms
- Monitor network requests and WebSocket frames

This is especially important for CSS changes, mobile layout verification, and interaction testing.

## Parent Project — Discord Harness

This web app lives inside a larger project at `/root/source/claudes_home/` which also includes:

### Discord Bot (`src/index.ts`)

A Discord harness that runs Claude Agent SDK sessions via Discord channels:
- `#claude-chat` — Main interaction channel
- `#claude-verbose` — Debug JSON events
- `#claude-text` — Raw text responses
- Messages get 🤖 (working), ✅ (done), or ❌ (error) reactions

### Discord MCP Server (`discord-mcp/`)

Custom MCP server providing Discord API access: send messages, read messages, add reactions, list channels, get specific messages. Used by Claude to interact with Discord from within sessions.

### Discord Voice Bot (`discord-voice-bot/`)

Voice-enabled Discord bot with Google Cloud Speech-to-Text/TTS and Claude API integration. Join voice channels, listen, respond.

### Restart System

The Discord harness has a self-restart mechanism via `restart-daemon.sh` + signal file (`.restart-signal`). The `restart_kernel` MCP tool lets Claude restart itself.

## Important Notes for Future Sessions

1. **You're likely being accessed via the PWA on a Pixel Fold.** Keep this in mind — the user is on mobile, on a folding phone, typing with thumbs. Keep responses focused.

2. **Connection drops are normal.** The phone sleeps, the app backgrounds, the network flaps. The reconnection logic handles this. Don't panic about disconnects.

3. **`systemctl restart claude-web` kills the WS connection.** The client handles this gracefully now (exponential backoff, status check on reconnect, history reload). But be aware that restarting the service during your own response will interrupt it.

4. **Always bump the service worker cache** after changing client files. Otherwise the phone will serve stale cached versions and the user will be confused about why their changes didn't take effect.

5. **Use the webtop for visual testing.** You have `computer-use` and `chrome-devtools` MCP servers. Open the app URL in the webtop Chromium and verify your UI changes visually. Don't just trust the code.

6. **The user wants compact, information-dense UI.** Small text, tight spacing, status indicators everywhere. No large padding, no verbose messages. Think "terminal" not "marketing site".

7. **SQLite is the persistence layer.** Don't try to use JSON files. The migration from `sessions.json` was already done.

8. **Tests exist and should pass.** Run `npm test` before deploying. The tests spin up a real server subprocess on a random port and test HTTP + WebSocket behavior.

9. **Model preference: Always use the smartest available model.** The user wants Opus. Currently `claude-opus-4-5-20251101`. If a newer/better model becomes available, use that.

10. **MCP servers are configured both at the Claude CLI level** (`~/.claude/settings.json` — `computer-use`) **and at the app level** (`data/mcp-config.json` — `computer-use`, `chrome-devtools`, `discord`). The app-level config is what gets passed to SDK queries.

11. **The user's Tailscale network** includes: this server (`claude`), Pixel Fold (`google-pixel-10-pro-fold`), laptop (`jerome-laptop`), and Raspberry Pis (`rpi1`, `rpi5`).

12. **Logs**: Server logs go to `/var/log/claude-web/output.log` and `error.log`. Client console logs are piped to the server via WebSocket.
