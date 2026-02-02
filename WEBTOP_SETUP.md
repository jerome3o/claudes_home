# Webtop Desktop Environment Setup

This document describes the improved desktop environment setup for Claude.

## Architecture

- **Base Image**: LinuxServer.io Webtop (Ubuntu 24.04 + XFCE)
- **MCP Integration**: computer-use-mcp for desktop control
- **Discord Integration**: Automatic screenshot posting to Discord

## Features

### 1. Persistent Storage

The desktop environment now has three persistent storage areas:

- **Browser Data**: Firefox profile, cookies, and login sessions persist across restarts
- **Shared Folder**: `./shared/` - for exchanging files between host and container
- **Downloads**: `./downloads/` - persistent downloads folder

### 2. Improved Display

- **Resolution**: Set to 1920x1080 (standard HD)
- **Shared Memory**: 2GB allocated for better browser performance

### 3. Automatic Screenshot Posting

When Claude takes a screenshot using the computer-use tools:
1. The screenshot is automatically detected
2. Posted to the `#claude-chat` Discord channel
3. Tagged with 🖥️ emoji

## Usage

### Starting the Desktop Environment

```bash
docker-compose up -d
```

### Stopping

```bash
docker-compose down
```

### Accessing the Desktop

Open browser to: http://localhost:3000

### File Exchange

- Place files in `./shared/` on host
- They appear in `/shared` inside the container
- Downloads go to `./downloads/` on host

### Rebuilding with Changes

```bash
docker-compose down
docker-compose up -d
```

## Customization

### Change Resolution

Edit `docker-compose.yml`:

```yaml
environment:
  - CUSTOM_RES_W=1280
  - CUSTOM_RES_H=720
```

Common resolutions:
- 1920x1080 (Full HD)
- 1280x720 (HD)
- 1024x768 (Classic)

### Add Pre-installed Applications

Modify the Dockerfile to install additional packages before building `webtop-mcp` image.

## Technical Details

### Screenshot Detection

The kernel monitors `tool_result` events from the orchestrator. When it detects a computer-use tool result containing `output_image`, it:

1. Extracts the base64-encoded image
2. Creates a Discord attachment
3. Posts to the chat channel

See `src/index.ts` for implementation.

### Volume Mounts

- `webtop-config`: Named volume for persistent browser state
- `./shared`: Bind mount for file exchange
- `./downloads`: Bind mount for downloads

## Troubleshooting

### Screenshots Not Posting

1. Check Discord bot has permission to send attachments
2. Check logs: `docker-compose logs -f`
3. Verify computer-use-mcp is installed in container

### Resolution Not Applying

1. Stop container: `docker-compose down`
2. Start fresh: `docker-compose up -d`
3. Wait 30 seconds for desktop to initialize
4. Refresh browser

### Files Not Appearing in /shared

1. Check folder exists: `ls -la ./shared`
2. Check permissions: `chmod 755 ./shared`
3. Restart container
