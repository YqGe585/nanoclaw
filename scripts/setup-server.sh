#!/bin/bash
# NanoClaw Server Setup Script
# Sets up NanoClaw as a systemd service with proper logging and management

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="nanoclaw"
USER_MODE="--user"
RUN_AS_USER=""

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        log_warn "Running as root - will install system-wide service"
        USER_MODE=""
        RUN_AS_USER="root"
    else
        log_info "Running as user - will install user-level service"
        USER_MODE="--user"
        RUN_AS_USER="$USER"
    fi
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed. Please install Node.js first."
        exit 1
    fi

    local node_version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [[ "$node_version" -lt 18 ]]; then
        log_error "Node.js 18+ required. Found: $(node --version)"
        exit 1
    fi
    log_success "Node.js $(node --version) found"

    # Check if .env exists
    if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
        log_warn ".env file not found. Creating from template..."
        create_env_template
    fi

    # Check for API key
    if ! grep -q "ANTHROPIC_API_KEY\|ANTHROPIC_AUTH_TOKEN" "$PROJECT_ROOT/.env" 2>/dev/null; then
        log_error "No API credentials found in .env file"
        log_info "Please add ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN to $PROJECT_ROOT/.env"
        exit 1
    fi

    # Check systemd
    if ! command -v systemctl &> /dev/null; then
        log_warn "systemd not found. Will create fallback startup script."
        return 1
    fi

    return 0
}

# Create .env template
create_env_template() {
    cat > "$PROJECT_ROOT/.env" << 'EOF'
# NanoClaw Configuration

# Assistant Settings
ASSISTANT_NAME=Andy
ASSISTANT_HAS_OWN_NUMBER=false

# Anthropic API (Required - get from https://console.anthropic.com/)
ANTHROPIC_API_KEY=your_api_key_here

# Optional: Custom base URL (for proxies)
# ANTHROPIC_BASE_URL=https://api.anthropic.com

# Agent Runtime: 'local' (no Docker) or 'docker' (containerized)
AGENT_RUNTIME=local

# Timezone
TZ=Asia/Shanghai

# Timeouts (milliseconds)
CONTAINER_TIMEOUT=1800000
MAX_CONCURRENT_CONTAINERS=5
EOF
    chmod 600 "$PROJECT_ROOT/.env"
    log_info "Created .env template at $PROJECT_ROOT/.env"
    log_warn "Please edit the file and add your API key!"
}

# Build the project
build_project() {
    log_info "Building NanoClaw..."
    cd "$PROJECT_ROOT"

    if ! npm run build; then
        log_error "Build failed"
        exit 1
    fi

    log_success "Build successful"
}

# Create necessary directories
create_directories() {
    log_info "Creating directories..."

    mkdir -p "$PROJECT_ROOT/logs"
    mkdir -p "$PROJECT_ROOT/store"
    mkdir -p "$PROJECT_ROOT/data"
    mkdir -p "$HOME/.config/nanoclaw"

    # Create mount allowlist if not exists
    if [[ ! -f "$HOME/.config/nanoclaw/mount-allowlist.json" ]]; then
        cat > "$HOME/.config/nanoclaw/mount-allowlist.json" << 'EOF'
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    },
    {
      "path": "~/workspace",
      "allowReadWrite": true,
      "description": "Workspace directory"
    }
  ],
  "blockedPatterns": [
    "password",
    "secret",
    "token",
    ".env"
  ],
  "nonMainReadOnly": true
}
EOF
        log_success "Created mount allowlist"
    fi
}

# Setup systemd service
setup_systemd() {
    log_info "Setting up systemd service..."

    local node_path=$(which node)
    local unit_dir
    local unit_path

    if [[ -z "$USER_MODE" ]]; then
        # System-wide service (root)
        unit_dir="/etc/systemd/system"
        unit_path="$unit_dir/$SERVICE_NAME.service"
    else
        # User service
        unit_dir="$HOME/.config/systemd/user"
        unit_path="$unit_dir/$SERVICE_NAME.service"
        mkdir -p "$unit_dir"
    fi

    # Create systemd unit file
    cat > "$unit_path" << EOF
[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=$node_path $PROJECT_ROOT/dist/index.js
WorkingDirectory=$PROJECT_ROOT
Restart=always
RestartSec=5
Environment=HOME=$HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
Environment=AGENT_RUNTIME=local
StandardOutput=append:$PROJECT_ROOT/logs/nanoclaw.log
StandardError=append:$PROJECT_ROOT/logs/nanoclaw.error.log

[Install]
WantedBy=${USER_MODE:+default.target}${USER_MODE:-multi-user.target}
EOF

    log_success "Created systemd unit at $unit_path"

    # Reload systemd
    if [[ -n "$USER_MODE" ]]; then
        systemctl --user daemon-reload
    else
        systemctl daemon-reload
    fi

    # Enable service
    if systemctl $USER_MODE enable "$SERVICE_NAME"; then
        log_success "Service enabled"
    else
        log_warn "Failed to enable service"
    fi
}

# Setup fallback script (for systems without systemd)
setup_fallback() {
    log_info "Setting up fallback startup script..."

    local wrapper_path="$PROJECT_ROOT/start-nanoclaw.sh"
    local node_path=$(which node)

    cat > "$wrapper_path" << EOF
#!/bin/bash
# NanoClaw Startup Script (Fallback for non-systemd systems)

PROJECT_ROOT="$PROJECT_ROOT"
PIDFILE="$PROJECT_ROOT/nanoclaw.pid"

start() {
    if [[ -f "\$PIDFILE" ]]; then
        local pid=\$(cat "\$PIDFILE" 2>/dev/null)
        if kill -0 "\$pid" 2>/dev/null; then
            echo "NanoClaw is already running (PID: \$pid)"
            return 1
        fi
    fi

    echo "Starting NanoClaw..."
    cd "\$PROJECT_ROOT"
    nohup "$node_path" "\$PROJECT_ROOT/dist/index.js" \
        >> "\$PROJECT_ROOT/logs/nanoclaw.log" \
        2>> "\$PROJECT_ROOT/logs/nanoclaw.error.log" &

    echo \$! > "\$PIDFILE"
    echo "NanoClaw started (PID: \$!)"
    echo "Logs: tail -f \$PROJECT_ROOT/logs/nanoclaw.log"
}

stop() {
    if [[ -f "\$PIDFILE" ]]; then
        local pid=\$(cat "\$PIDFILE" 2>/dev/null)
        if kill -0 "\$pid" 2>/dev/null; then
            echo "Stopping NanoClaw (PID: \$pid)..."
            kill "\$pid"
            rm -f "\$PIDFILE"
            echo "Stopped"
        else
            echo "NanoClaw is not running"
            rm -f "\$PIDFILE"
        fi
    else
        echo "NanoClaw is not running"
    fi
}

status() {
    if [[ -f "\$PIDFILE" ]]; then
        local pid=\$(cat "\$PIDFILE" 2>/dev/null)
        if kill -0 "\$pid" 2>/dev/null; then
            echo "NanoClaw is running (PID: \$pid)"
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

case "\$1" in
    start) start ;;
    stop) stop ;;
    restart) restart ;;
    status) status ;;
    *) echo "Usage: \$0 {start|stop|restart|status}" ;;
esac
EOF

    chmod +x "$wrapper_path"
    log_success "Created fallback script at $wrapper_path"
}

# Start the service
start_service() {
    log_info "Starting NanoClaw service..."

    if command -v systemctl &> /dev/null; then
        if systemctl $USER_MODE start "$SERVICE_NAME" 2>/dev/null; then
            sleep 2
            if systemctl $USER_MODE is-active "$SERVICE_NAME" &> /dev/null; then
                log_success "Service started successfully"
            else
                log_warn "Service may not have started properly"
            fi
        else
            log_error "Failed to start service"
            log_info "Check logs: journalctl $USER_MODE -u $SERVICE_NAME -n 50"
        fi
    else
        "$PROJECT_ROOT/start-nanoclaw.sh" start
    fi
}

# Create management helper script
create_manage_script() {
    log_info "Creating management script..."

    local manage_path="$PROJECT_ROOT/nanoclaw"

    cat > "$manage_path" << 'EOF'
#!/bin/bash
# NanoClaw Management Script

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="nanoclaw"

# Detect if running as user or root
if [[ $EUID -eq 0 ]]; then
    USER_MODE=""
else
    USER_MODE="--user"
fi

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

show_help() {
    echo "NanoClaw Server Management"
    echo ""
    echo "Usage: ./nanoclaw <command>"
    echo ""
    echo "Commands:"
    echo "  start       Start the NanoClaw service"
    echo "  stop        Stop the NanoClaw service"
    echo "  restart     Restart the NanoClaw service"
    echo "  status      Check service status"
    echo "  logs        View service logs (follow mode)"
    echo "  logs-error  View error logs"
    echo "  update      Pull latest changes and restart"
    echo "  cli         Start interactive CLI chat"
    echo "  backup      Backup database and config"
    echo "  health      Check service health"
    echo "  help        Show this help message"
}

case "$1" in
    start)
        if command -v systemctl &> /dev/null; then
            systemctl $USER_MODE start $SERVICE_NAME
            echo -e "${GREEN}Started${NC}"
        else
            $PROJECT_ROOT/start-nanoclaw.sh start
        fi
        ;;
    stop)
        if command -v systemctl &> /dev/null; then
            systemctl $USER_MODE stop $SERVICE_NAME
            echo -e "${RED}Stopped${NC}"
        else
            $PROJECT_ROOT/start-nanoclaw.sh stop
        fi
        ;;
    restart)
        if command -v systemctl &> /dev/null; then
            systemctl $USER_MODE restart $SERVICE_NAME
            echo -e "${YELLOW}Restarted${NC}"
        else
            $PROJECT_ROOT/start-nanoclaw.sh restart
        fi
        ;;
    status)
        if command -v systemctl &> /dev/null; then
            systemctl $USER_MODE status $SERVICE_NAME --no-pager
        else
            $PROJECT_ROOT/start-nanoclaw.sh status
        fi
        ;;
    logs)
        if command -v journalctl &> /dev/null; then
            journalctl $USER_MODE -u $SERVICE_NAME -f
        else
            tail -f $PROJECT_ROOT/logs/nanoclaw.log
        fi
        ;;
    logs-error)
        if command -v journalctl &> /dev/null; then
            journalctl $USER_MODE -u $SERVICE_NAME -f --priority=err
        else
            tail -f $PROJECT_ROOT/logs/nanoclaw.error.log
        fi
        ;;
    update)
        echo "Updating NanoClaw..."
        cd $PROJECT_ROOT
        git pull
        npm run build
        if command -v systemctl &> /dev/null; then
            systemctl $USER_MODE restart $SERVICE_NAME
        else
            $PROJECT_ROOT/start-nanoclaw.sh restart
        fi
        echo -e "${GREEN}Updated and restarted${NC}"
        ;;
    cli)
        AGENT_RUNTIME=local npm run chat
        ;;
    backup)
        backup_dir="$PROJECT_ROOT/backups/$(date +%Y%m%d_%H%M%S)"
        mkdir -p "$backup_dir"
        cp -r "$PROJECT_ROOT/store" "$backup_dir/" 2>/dev/null || true
        cp "$PROJECT_ROOT/.env" "$backup_dir/" 2>/dev/null || true
        echo "Backup created at: $backup_dir"
        ;;
    health)
        echo "Checking health..."
        if command -v systemctl &> /dev/null; then
            if systemctl $USER_MODE is-active $SERVICE_NAME &> /dev/null; then
                echo -e "${GREEN}Service is running${NC}"
            else
                echo -e "${RED}Service is not running${NC}"
            fi
        fi
        if [[ -f "$PROJECT_ROOT/store/messages.db" ]]; then
            db_size=$(du -h "$PROJECT_ROOT/store/messages.db" | cut -f1)
            echo "Database size: $db_size"
        fi
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo "Unknown command: $1"
        show_help
        exit 1
        ;;
esac
EOF

    chmod +x "$manage_path"
    log_success "Created management script at $manage_path"
}

# Print summary
print_summary() {
    echo ""
    echo "=========================================="
    echo -e "${GREEN}NanoClaw Server Setup Complete!${NC}"
    echo "=========================================="
    echo ""
    echo "Management commands:"
    echo "  ./nanoclaw start      - Start service"
    echo "  ./nanoclaw stop       - Stop service"
    echo "  ./nanoclaw restart    - Restart service"
    echo "  ./nanoclaw status     - Check status"
    echo "  ./nanoclaw logs       - View logs"
    echo "  ./nanoclaw logs-error - View error logs"
    echo "  ./nanoclaw cli        - Interactive chat"
    echo "  ./nanoclaw health     - Health check"
    echo ""
    echo "Log locations:"
    echo "  $PROJECT_ROOT/logs/nanoclaw.log"
    echo "  $PROJECT_ROOT/logs/nanoclaw.error.log"
    echo ""

    if command -v systemctl &> /dev/null; then
        echo "Systemd commands:"
        echo "  systemctl $USER_MODE status $SERVICE_NAME"
        echo "  journalctl $USER_MODE -u $SERVICE_NAME -f"
        echo ""
    fi
}

# Main
main() {
    echo "=========================================="
    echo "NanoClaw Server Setup"
    echo "=========================================="
    echo ""

    check_root

    if ! check_prerequisites; then
        NO_SYSTEMD=1
    fi

    create_directories
    build_project

    if [[ "${NO_SYSTEMD:-}" == "1" ]]; then
        setup_fallback
    else
        setup_systemd
    fi

    create_manage_script
    start_service
    print_summary
}

# Run main
main "$@"
