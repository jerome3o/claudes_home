# Claude Web Frontend

Mobile-first web interface for the Claude Agent SDK.

## Features

- 📱 **Mobile-First Design** - Optimized for Google Pixel Fold and other mobile devices
- 💬 **Multiple Sessions** - Create and manage multiple conversation sessions
- 🔧 **MCP Configuration** - Configure MCP servers through the UI
- 🤖 **Auto-Allow Tools** - No permission management, all tools automatically approved
- 🔄 **Session Resumption** - Continue conversations across page reloads
- 📊 **Compact Tool Display** - Tool calls are minimized by default, expand to see details
- 🎨 **Clean, Extensible UI** - Easy to iterate and customize

## Setup

1. Install dependencies:
```bash
npm install
```

2. Build:
```bash
npm run build
```

3. Start the server:
```bash
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

4. Open in browser:
```
http://localhost:8080
```

## MCP Self-Configuration

Claude can configure its own MCP servers! Try saying:

> "Create an MCP server that can fetch weather data"

Claude will:
1. Create the MCP server code
2. Save it to disk
3. Update the MCP configuration
4. Reload itself with the new server

## Architecture

### Backend (`src/server.ts`)
- Express.js server
- WebSocket for real-time communication
- Session management with persistence
- MCP configuration API
- Auto-approve all tools (no permission gates)

### Frontend (`public/`)
- Vanilla JavaScript (no frameworks)
- WebSocket client
- Responsive CSS with mobile-first approach
- Sidebar for session management
- Modal for MCP configuration

### Data Persistence
- Sessions stored in `data/sessions.json`
- MCP config stored in `data/mcp-config.json`
- SDK session IDs preserved for conversation resumption

## Responsive Design

- **Mobile (< 768px)**: Sidebar hidden by default, hamburger menu
- **Tablet/Fold Open (≥ 768px)**: Sidebar always visible
- **Desktop (≥ 1024px)**: Centered content with max width

## API Endpoints

### REST API
- `GET /api/sessions` - List all sessions
- `POST /api/sessions` - Create new session
- `DELETE /api/sessions/:id` - Delete session
- `GET /api/mcp-config` - Get MCP configuration
- `POST /api/mcp-config` - Update MCP configuration

### WebSocket Messages

**Client → Server:**
- `start_session` - Connect to a session
- `send_message` - Send a message to Claude
- `interrupt` - Stop current query
- `set_mcp_servers` - Update MCP servers

**Server → Client:**
- `session_started` - Session connection confirmed
- `sdk_event` - Event from Claude Agent SDK
- `query_completed` - Query finished
- `interrupted` - Query was interrupted
- `error` - Error occurred
- `mcp_servers_updated` - MCP config updated

## Extending

The codebase is designed to be easily extensible:

1. **Add new message types**: Update `handleSdkEvent()` in `app.js`
2. **Customize UI**: Modify CSS variables in `styles.css`
3. **Add features**: Server-side in `server.ts`, client-side in `app.js`
4. **Custom tools**: Add to MCP configuration through UI or API

## Environment Variables

- `PORT` - Server port (default: 8080)
- `DATA_DIR` - Data directory path (default: `./data`)

## Testing in Webtop

To test in the LinuxServer webtop container:

1. Make sure webtop is running:
```bash
docker-compose up -d webtop
```

2. Access webtop browser at: `http://localhost:3000`

3. In the webtop Firefox, navigate to:
```
http://localhost:8080
```

Or use the host IP if running the web server on the host.
