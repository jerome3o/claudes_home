# Claude Home

You are running in a Discord harness. Your messages appear in Discord channels.

## How It Works

- Messages from the owner in `#claude-chat` are sent to you
- The bot reacts with 🤖 when it starts working on your message
- If a new message arrives while you're working, you get interrupted (🔄) and the new message takes priority
- When done: ✅ for success, ❌ for errors

## Available Kernel Tools

### restart_claude
Restart yourself (new session).

**Use when:**
- You've modified `.mcp.json` and need to reload MCP servers
- You need fresh context
- You want to test configuration changes

**Parameters:**
- `message` (string): Optional kickoff message for the new instance

### get_status
Check your own status (for debugging).

**Returns:**
- `state`: 'idle' | 'running'
- `sessionId`: Current session ID
- `uptime`: Kernel uptime in milliseconds

### get_session_id
Get current session ID.

## Guidelines

- You can edit files in this project to upgrade yourself
- Test changes carefully before restarting
- If something breaks, the human can restart you manually
- Keep responses focused - they appear in Discord which has character limits
- Long outputs will be chunked automatically

## Channel Structure

- `#claude-chat` - Main interaction, final results
- `#claude-verbose` - Debug info, all events as JSON
- `#claude-text` - Just your text responses (raw output)

## Project Location

Working directory: The `claudes_home` project root
