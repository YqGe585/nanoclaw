#!/bin/bash
# NanoClaw Startup Script (Fallback for non-systemd systems)

PROJECT_ROOT="/workspace/nanoclaw"
PIDFILE="/workspace/nanoclaw/nanoclaw.pid"

start() {
    if [[ -f "$PIDFILE" ]]; then
        local pid=$(cat "$PIDFILE" 2>/dev/null)
        if kill -0 "$pid" 2>/dev/null; then
            echo "NanoClaw is already running (PID: $pid)"
            return 1
        fi
    fi

    echo "Starting NanoClaw..."
    cd "$PROJECT_ROOT"
    export AGENT_RUNTIME=local
    nohup "/root/miniforge/bin/node" "$PROJECT_ROOT/dist/index.js"         >> "$PROJECT_ROOT/logs/nanoclaw.log"         2>> "$PROJECT_ROOT/logs/nanoclaw.error.log" &

    echo $! > "$PIDFILE"
    echo "NanoClaw started (PID: $!)"
    echo "Logs: tail -f $PROJECT_ROOT/logs/nanoclaw.log"
}

stop() {
    if [[ -f "$PIDFILE" ]]; then
        local pid=$(cat "$PIDFILE" 2>/dev/null)
        if kill -0 "$pid" 2>/dev/null; then
            echo "Stopping NanoClaw (PID: $pid)..."
            kill "$pid"
            rm -f "$PIDFILE"
            echo "Stopped"
        else
            echo "NanoClaw is not running"
            rm -f "$PIDFILE"
        fi
    else
        echo "NanoClaw is not running"
    fi
}

status() {
    if [[ -f "$PIDFILE" ]]; then
        local pid=$(cat "$PIDFILE" 2>/dev/null)
        if kill -0 "$pid" 2>/dev/null; then
            echo "NanoClaw is running (PID: $pid)"
            return 0
        fi
    fi
    echo "NanoClaw is not running"
    return 1
}

restart() {
    stop
    sleep 2
    start
}

case "$1" in
    start) start ;;
    stop) stop ;;
    restart) restart ;;
    status) status ;;
    *) echo "Usage: $0 {start|stop|restart|status}" ;;
esac
