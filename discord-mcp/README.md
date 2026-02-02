# Discord MCP Server

A custom Discord MCP server built for Claude with comprehensive Discord API access.

## Features

### Tools Provided

1. **send_message** - Send messages to Discord channels
   - Text messages
   - Image attachments (base64 encoded)
   - Combined text + images

2. **read_messages** - Read recent messages from channels
   - Configurable limit (up to 100 messages)
   - Includes author info, content, attachments, reactions

3. **add_reaction** - Add emoji reactions to messages
   - Unicode emojis
   - Custom server emojis

4. **list_channels** - List all accessible text channels
   - Shows channel ID, name, and guild
   - Useful for discovering channel IDs

5. **get_message** - Get a specific message by ID
   - Full message details
   - Attachments and reactions included

## Configuration

The server requires the `DISCORD_BOT_TOKEN` environment variable.

In `.mcp.json`:
```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/root/source/claudes_home/discord-mcp/build/index.js"]
    }
  }
}
```

The bot token is read from the parent process environment (inherited from the kernel).

## Building

```bash
npm install
npm run build
```

## Bot Permissions Required

The Discord bot needs these intents:
- Guilds
- GuildMessages
- MessageContent
- GuildMessageReactions

And these permissions:
- View Channels
- Send Messages
- Read Message History
- Add Reactions
- Attach Files

## Usage Examples

### Send a text message
```typescript
await send_message({
  channel_id: "1467666918789087457",
  content: "Hello from Claude!"
});
```

### Send an image
```typescript
await send_message({
  channel_id: "1467843308221894686",
  image_base64: "iVBORw0KGgo...",
  image_filename: "screenshot.png"
});
```

### Read recent messages
```typescript
await read_messages({
  channel_id: "1467666918789087457",
  limit: 20
});
```

### React to a message
```typescript
await add_reaction({
  channel_id: "1467666918789087457",
  message_id: "1234567890",
  emoji: "✅"
});
```

## Architecture

- Built on `@modelcontextprotocol/sdk`
- Uses `discord.js` v14 for Discord API
- Stdio transport for MCP communication
- Channel caching for performance
- Comprehensive error handling
