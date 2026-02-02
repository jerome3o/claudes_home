#!/bin/bash

# Restart daemon for Claude Discord Harness
# Monitors a signal file and restarts npm run dev when triggered

SIGNAL_FILE="/root/source/claudes_home/.restart-signal"
NPM_PID=""
LOG_FILE="/tmp/claude-restart-daemon.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

cleanup() {
    log "Daemon shutting down..."
    if [ -n "$NPM_PID" ] && kill -0 "$NPM_PID" 2>/dev/null; then
        log "Killing npm process $NPM_PID"
        kill -TERM "$NPM_PID" 2>/dev/null
        wait "$NPM_PID" 2>/dev/null
    fi
    rm -f "$SIGNAL_FILE"
    exit 0
}

# Trap signals for clean shutdown
trap cleanup SIGINT SIGTERM

start_npm() {
    log "Starting npm run dev..."
    cd /root/source/claudes_home || exit 1
    npm run dev &
    NPM_PID=$!
    log "npm run dev started with PID $NPM_PID"
}

restart_npm() {
    log "Restart triggered!"

    if [ -n "$NPM_PID" ] && kill -0 "$NPM_PID" 2>/dev/null; then
        log "Stopping existing npm process $NPM_PID..."
        kill -TERM "$NPM_PID" 2>/dev/null

        # Wait up to 10 seconds for graceful shutdown
        for i in {1..10}; do
            if ! kill -0 "$NPM_PID" 2>/dev/null; then
                log "Process stopped gracefully"
                break
            fi
            sleep 1
        done

        # Force kill if still running
        if kill -0 "$NPM_PID" 2>/dev/null; then
            log "Force killing process..."
            kill -9 "$NPM_PID" 2>/dev/null
        fi

        wait "$NPM_PID" 2>/dev/null
    fi

    # Small delay before restart
    sleep 2

    # Start fresh
    start_npm

    # Remove signal file
    rm -f "$SIGNAL_FILE"
}

log "Restart daemon started"
log "Monitoring signal file: $SIGNAL_FILE"
log "To trigger restart: touch $SIGNAL_FILE"
log "To stop daemon: kill $$"

# Remove any existing signal file
rm -f "$SIGNAL_FILE"

# Start npm initially
start_npm

# Monitor loop
while true; do
    # Check if signal file exists
    if [ -f "$SIGNAL_FILE" ]; then
        restart_npm
    fi

    # Check if npm process is still running
    if [ -n "$NPM_PID" ] && ! kill -0 "$NPM_PID" 2>/dev/null; then
        log "npm process died unexpectedly! Restarting..."
        start_npm
    fi

    # Sleep before next check
    sleep 1
done
