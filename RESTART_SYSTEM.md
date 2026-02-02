# Restart System

This system allows Claude to restart itself without manual intervention.

## How It Works

### 1. Restart Daemon (`restart-daemon.sh`)

A background script that:
- Runs `npm run dev` continuously
- Monitors a signal file (`.restart-signal`)
- Automatically restarts the process when signaled
- Logs all activity to `/tmp/claude-restart-daemon.log`

### 2. Signal File

- Path: `/root/source/claudes_home/.restart-signal`
- When this file is created (touched), the daemon triggers a restart
- The file is automatically removed after restart

### 3. Kernel MCP Tool

Claude has a `restart_kernel` tool that:
- Creates the signal file
- Triggers the daemon to restart
- Allows Claude to restart itself programmatically

## Usage

### Starting the Daemon

```bash
cd /root/source/claudes_home
./restart-daemon.sh
```

Or in a tmux session:
```bash
tmux new-session -d -s claude './restart-daemon.sh'
```

### Manual Restart Trigger

```bash
touch /root/source/claudes_home/.restart-signal
```

### From Claude

Claude can restart itself using:
```typescript
await restart_kernel();
```

### Stopping the Daemon

Kill the daemon process:
```bash
pkill -f restart-daemon.sh
```

Or if you know the PID:
```bash
kill <PID>
```

## Features

- **Automatic Process Monitoring**: Restarts if npm dies unexpectedly
- **Graceful Shutdown**: Attempts SIGTERM first, then SIGKILL if needed
- **Logging**: All events logged to `/tmp/claude-restart-daemon.log`
- **Signal Handling**: Clean shutdown on SIGINT/SIGTERM

## Logs

View daemon logs:
```bash
tail -f /tmp/claude-restart-daemon.log
```

## Architecture

```
┌─────────────────────────────────────┐
│   restart-daemon.sh (bash script)   │
│                                     │
│  ┌──────────────┐  ┌──────────────┐│
│  │ Monitor Loop │  │ npm run dev  ││
│  │   (1s poll)  │──│   (process)  ││
│  └──────────────┘  └──────────────┘│
│         │                           │
│         ▼                           │
│  ┌──────────────┐                  │
│  │ Signal File  │                  │
│  │  .restart-   │                  │
│  │   signal     │                  │
│  └──────────────┘                  │
└─────────────────────────────────────┘
         ▲
         │ touch signal file
         │
┌─────────────────┐
│  restart_kernel │ (MCP tool in Claude)
│     tool        │
└─────────────────┘
```

## Benefits

1. **Self-Service Restarts**: Claude can restart itself
2. **Automatic Recovery**: Crashes are automatically handled
3. **Clean Process Management**: Proper signal handling
4. **Debugging**: All events are logged
5. **Simple Protocol**: Just touch a file to restart

## Integration with tmux

Recommended setup:
```bash
tmux new-session -s claude
tmux split-window -h

# In left pane - interactive shell
# In right pane - restart daemon
./restart-daemon.sh
```

This gives you:
- Left pane: Interactive shell for monitoring
- Right pane: Live daemon output
