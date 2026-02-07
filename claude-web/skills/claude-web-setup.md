# Claude Web Setup Skill

**Skill Name:** `claude-web-setup`
**Purpose:** Provides comprehensive documentation about the Claude Web interface setup, architecture, and operational context.

---

## Overview

You (Claude) are running inside a **custom web application** that provides a mobile-first interface for interacting with the Claude Agent SDK. This application was built by the user and integrates with Discord for notifications.

## Current Environment

- **Location:** `/root/source/claudes_home/claude-web`
- **Access Method:** Running as a web service accessible via:
  - Local: `http://localhost:8080`
  - Tailscale HTTPS: `https://claude.tail8904.ts.net` (via `tailscale serve --bg 8080`)
  - Tailscale IP: `http://100.110.255.35:8080`
  - Webtop VNC: Proxied through Express at `/vnc/` path (DO NOT access port 3000 directly from clients)
- **Platform:** Host machine with a webtop Docker container for desktop environment
- **Integration:** Discord bot for notifications and alerts
- **Primary User Device:** Google Pixel Fold (mobile-first design)

## Architecture

### Backend (`src/server.ts`)
- **Framework:** Express.js + TypeScript
- **Real-time:** WebSocket server (`noServer: true` mode for manual upgrade handling)
- **SDK:** `@anthropic-ai/claude-agent-sdk` v0.2.34
- **Storage:** JSON files in `data/` directory
  - `data/sessions.json` - Session history and metadata
  - `data/mcp-config.json` - MCP server configurations
- **Key Feature:** Auto-approves ALL tools (no permission management)
- **Port:** 8080 (bound to 0.0.0.0 for Tailscale access)
- **VNC Reverse Proxy:** Routes `/vnc/` HTTP requests + WebSocket upgrades to webtop on localhost:3000

### Frontend (`public/`)
- **Style:** Vanilla JavaScript (no frameworks)
- **UI Libraries:**
  - `marked.js` - Markdown rendering
  - Syntax highlighting for code blocks
- **Design:** Mobile-first, dark theme
- **Responsive Breakpoints:**
  - Mobile: < 768px (hamburger menu)
  - Tablet: ≥ 768px (sidebar visible)
  - Desktop: ≥ 1024px (centered layout)

## Key Features

1. **Session Management**
   - Multiple independent conversation sessions
   - Persistent across page reloads
   - SDK session ID tracking for resumption
   - Last active timestamps

2. **MCP Self-Configuration**
   - You CAN create and configure your own MCP servers!
   - Update configuration through UI or API
   - Changes persist to `data/mcp-config.json`
   - Requires restart to apply new servers

3. **Real-Time Streaming**
   - All SDK events streamed via WebSocket
   - Tool calls display minimized by default
   - Expandable for details
   - Interrupt support (pause button)

4. **Discord Integration**
   - Can send notifications via Discord MCP
   - Tag user in #claude-chat channel
   - Include Tailscale links for mobile access
   - Useful for long-running tasks

5. **Mobile Optimization**
   - Designed for Google Pixel Fold
   - Touch-friendly interface
   - Auto-focus input field
   - Enter key sends messages

6. **VNC Picture-in-Picture Viewer**
   - Floating webtop desktop view embedded in the UI
   - 4 states: hidden → PIP (draggable/resizable) → minimized (pill) → maximized (fullscreen overlay)
   - Toggle via 🖥️ button in header
   - Dragging by header bar, resize via bottom-right handle (min 240x180)
   - Position/size persists across state changes
   - Proxied through Express server (avoids CORS/cert issues)
   - Maximized state uses `top/left/right/bottom: 10px` to stay within viewport

## API Endpoints

### REST API
- `GET /api/sessions` - List all sessions
- `POST /api/sessions` - Create new session (body: `{name, folder?}`)
- `DELETE /api/sessions/:id` - Delete session
- `GET /api/sessions/:id/messages` - Get session history
- `GET /api/mcp-config` - Get MCP configuration
- `POST /api/mcp-config` - Update MCP configuration

### WebSocket Messages

**Client → Server:**
- `start_session` - Connect to a session
- `send_message` - Send prompt (with optional `resume` SDK session ID)
- `interrupt` - Stop current query
- `set_mcp_servers` - Update MCP servers

**Server → Client:**
- `session_started` - Connection confirmed
- `sdk_event` - Real-time SDK event stream
- `query_completed` - Query finished successfully
- `interrupted` - Query was interrupted
- `error` - Error occurred
- `mcp_servers_updated` - MCP config updated

## Development Workflow

### Running the Server
```bash
# Development (with auto-reload)
npm run dev

# Production build
npm run build
npm start
```

### Making Changes
1. Edit TypeScript in `src/server.ts`
2. Edit frontend in `public/` (HTML/CSS/JS)
3. For dev mode: changes auto-reload
4. For production: rebuild with `npm run build`

### Testing
- Local browser: `http://localhost:8080`
- Mobile testing: Use Tailscale URL on phone
- Webtop testing: Access via containerized Firefox

## Session Data Structure

```typescript
interface SessionInfo {
  id: string;                    // Unique session ID
  name: string;                  // Display name
  created: number;               // Unix timestamp
  lastActive: number;            // Unix timestamp
  folder?: string;               // Optional folder organization
  messages: SessionMessage[];    // Message history
  sdkSessionId?: string;         // SDK session ID for resumption
}

interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;               // Message text
  timestamp: number;             // Unix timestamp
  useMarkdown?: boolean;         // Render as markdown
  status?: string;               // Optional status indicator
}
```

## MCP Configuration

MCP servers are configured in `data/mcp-config.json` with this structure:

```json
{
  "server-name": {
    "type": "stdio",
    "command": "node",
    "args": ["path/to/server.js"],
    "env": {
      "ENV_VAR": "value"
    }
  }
}
```

## Important Behavioral Notes

### Tool Permissions
- **ALL tools are auto-approved** by default
- No permission prompts or gates
- The `canUseTool` handler always returns `{behavior: 'allow'}`
- This enables seamless operation in web interface

### Session Resumption
- SDK session IDs are captured on init events
- Stored in `sessions[sessionId].sdkSessionId`
- Passed to SDK via `options.resume` parameter
- Enables conversation continuity across reloads

### Message Persistence
- Only text blocks are saved to history
- Tool calls are NOT persisted (shown in real-time only)
- User messages saved on `event.type === 'user'` (non-synthetic)
- Assistant messages saved on `event.type === 'assistant'`

## Files to Know

### Main Application
- `src/server.ts` - Backend server (TypeScript)
- `public/app.js` - Frontend logic
- `public/styles.css` - Styling and responsive design
- `public/index.html` - HTML structure

### Documentation
- `README.md` - Setup and architecture overview
- `FEATURES.md` - Feature list and status
- `skills/claude-web-setup.md` - THIS FILE

### Configuration
- `package.json` - Dependencies and scripts
- `tsconfig.json` - TypeScript configuration
- `data/mcp-config.json` - MCP server configuration (runtime)

### Data (Generated)
- `data/sessions.json` - Session history
- `dist/server.js` - Compiled server code

## Webtop Docker Container

### Configuration (`/root/source/claudes_home/docker-compose.yml`)
- **Image:** `webtop-mcp` (custom LinuxServer webtop image)
- **Network:** `network_mode: host` (ports 3000 HTTP, 3001 HTTPS available directly)
- **Streaming:** Uses **Selkies** (NOT KasmVNC) for remote desktop streaming
- **Resolution:** Locked to **1920x1080** via `SELKIES_MANUAL_WIDTH=1920` and `SELKIES_MANUAL_HEIGHT=1080`
  - These env vars activate manual resolution mode and prevent auto-resizing to client viewport
  - Max resolution is also constrained to 1920x1080
- **Volumes:** `webtop-config` (named volume for persistent config), `./shared`, `./downloads`
- **shm_size:** 2GB for browser performance

### Container Management
```bash
# Restart webtop container
cd /root/source/claudes_home && docker compose up -d webtop

# Force recreate (e.g., after env var changes)
docker stop webtop && docker rm webtop && docker compose up -d webtop

# Check resolution
docker exec webtop bash -c "export DISPLAY=:1 && xrandr"

# View container logs
docker logs webtop --tail 50
```

### VNC Proxy Architecture
- Express server proxies HTTP requests from `/vnc/*` → `http://localhost:3000/*`
- WebSocket upgrade handler routes `/vnc/` websocket connections → `localhost:3000`
- Non-VNC websocket upgrades are handled by the Claude WSS (`noServer: true`)
- This avoids CORS issues and self-signed certificate problems in iframes

## HTTPS & Tailscale Setup

- **Tailscale Serve:** `tailscale serve --bg 8080` provides trusted HTTPS at `https://claude.tail8904.ts.net`
- **Requirements:** HTTPS Certificates and MagicDNS must be enabled in Tailscale admin (`https://login.tailscale.com/admin/dns`)
- **Why needed:** Selkies requires HTTPS for WebSocket connections; self-signed certs cause blank iframes

## Known Issues & Limitations

1. **WebSocket reconnection** - Manual page refresh required if connection drops
2. **Large tool outputs** - May slow down UI rendering
3. **Send button visibility** - May be off-screen on very small devices (use Enter key)
4. **No multi-user support** - Single-user application
5. **No authentication** - Open to anyone with Tailscale network access

## Critical Warnings

1. **NEVER use `pkill` on `node` or `server.js`** — this kills the very process you are running in! Use `sudo systemctl restart claude-web` instead.
2. **Always use `docker compose` (v2 syntax)** — `docker-compose` (v1) is not installed.
3. **Webtop uses host networking** — `ports:` section in docker-compose is ignored, ports are exposed directly on the host.

## Future Enhancements (Planned)

- File upload capability
- Voice input for mobile
- Conversation search
- Session export/import
- Conversation branching
- Better error handling and retry logic

---

## 🔄 IMPORTANT: Keep This Skill Updated!

**When you make changes to the claude-web setup:**

1. **Update this skill file** (`skills/claude-web-setup.md`)
2. Document new features, API changes, or architectural updates
3. Update version numbers and dependencies
4. Note any breaking changes or migration steps
5. Keep the "Files to Know" section current
6. Add new issues or remove resolved ones

**This skill is your reference guide!** Treat it as living documentation that evolves with the codebase. Every significant change to the architecture, features, or workflow should be reflected here.

---

## Systemd Service Setup (Production Deployment)

For persistent operation, the claude-web service should be run as a systemd service. This ensures:
- Automatic startup on system boot
- Automatic restart on crashes
- Proper logging and management
- Background operation without manual shell sessions

### Service File

Create `/etc/systemd/system/claude-web.service`:

**Note:** The npm path uses nvm (Node Version Manager), so adjust the path if using a different Node.js installation method.

```ini
[Unit]
Description=Claude Web Frontend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/source/claudes_home/claude-web
ExecStart=/root/.nvm/versions/node/v20.20.0/bin/npm start
Restart=always
RestartSec=10
StandardOutput=append:/var/log/claude-web/output.log
StandardError=append:/var/log/claude-web/error.log

# Environment variables
Environment="NODE_ENV=production"
Environment="PORT=8080"
Environment="PATH=/root/.nvm/versions/node/v20.20.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

[Install]
WantedBy=multi-user.target
```

**Current Status:** ✅ Service is installed and running
- Check status: `systemctl status claude-web`
- View logs: `journalctl -u claude-web -f` or `tail -f /var/log/claude-web/output.log`

### Setup Commands

```bash
# Create log directory
sudo mkdir -p /var/log/claude-web

# Create and enable service
sudo cp claude-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable claude-web
sudo systemctl start claude-web

# Check status
sudo systemctl status claude-web

# View logs
sudo journalctl -u claude-web -f

# Restart after code changes
cd /root/source/claudes_home/claude-web
npm run build
sudo systemctl restart claude-web
```

### Important: Update This Skill After Changes

When making changes to the service configuration or deployment:
1. Update this skill file with new information
2. Document any environment variable changes
3. Note any new dependencies or requirements
4. Update the service file if paths or commands change

## Quick Reference Commands

```bash
# Start development server (manual)
cd /root/source/claudes_home/claude-web
npm run dev

# Build for production
npm run build

# Production service management
sudo systemctl status claude-web   # Check status
sudo systemctl restart claude-web  # Restart after changes (SAFE - use this!)
sudo systemctl stop claude-web     # Stop service
sudo journalctl -u claude-web -f   # Follow logs

# Webtop container management
cd /root/source/claudes_home
docker compose up -d webtop        # Start/update webtop
docker stop webtop && docker rm webtop && docker compose up -d webtop  # Full recreate
docker logs webtop --tail 50       # View webtop logs
docker exec webtop bash -c "export DISPLAY=:1 && xrandr"  # Check resolution

# Check what's running
lsof -i :8080
ps aux | grep 'node.*server.js'

# View session data
cat data/sessions.json | jq

# View MCP config
cat data/mcp-config.json | jq

# Find this skill
cat skills/claude-web-setup.md
```

---

**Last Updated:** 2026-02-07
**SDK Version:** @anthropic-ai/claude-agent-sdk v0.2.34
**Node Version:** Check with `node --version`
