#!/usr/bin/env bash
# ============================================================================
# DjinnBot One-Shot Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/BaseDatum/djinnbot/main/install.sh | bash
# ============================================================================
set -euo pipefail

# ── Colors & helpers ────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()    { echo -e "${BLUE}[info]${NC}  $*"; }
success() { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
error()   { echo -e "${RED}[error]${NC} $*"; }
fatal()   { error "$*"; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}--- $* ---${NC}"; }

# ── Platform detection ──────────────────────────────────────────────────────

detect_platform() {
    local os arch

    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Linux)   OS="linux" ;;
        Darwin)  OS="macos" ;;
        *)       fatal "Unsupported operating system: $os. DjinnBot requires Linux or macOS." ;;
    esac

    case "$arch" in
        x86_64|amd64)  ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)             fatal "Unsupported architecture: $arch. DjinnBot requires amd64 or arm64." ;;
    esac

    # Detect Linux distro
    DISTRO="unknown"
    if [ "$OS" = "linux" ]; then
        if [ -f /etc/os-release ]; then
            # shellcheck disable=SC1091
            . /etc/os-release
            DISTRO="${ID:-unknown}"
        elif [ -f /etc/redhat-release ]; then
            DISTRO="rhel"
        fi
    fi

    info "Platform: ${BOLD}$OS${NC} ($ARCH)"
    [ "$OS" = "linux" ] && info "Distribution: ${BOLD}$DISTRO${NC}"
}

# ── Privilege helper ────────────────────────────────────────────────────────

check_root_or_sudo() {
    if [ "$(id -u)" -eq 0 ]; then
        SUDO=""
    elif command -v sudo &>/dev/null; then
        SUDO="sudo"
        info "Will use sudo for privileged operations"
    else
        fatal "This script requires root or sudo. Please run as root or install sudo."
    fi
}

# ── Git ─────────────────────────────────────────────────────────────────────

install_git() {
    if command -v git &>/dev/null; then
        return
    fi

    step "Installing git"

    case "$OS" in
        linux)
            case "$DISTRO" in
                ubuntu|debian|pop|linuxmint|elementary|zorin)
                    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git >/dev/null ;;
                centos|rhel|rocky|almalinux|ol|fedora|amzn)
                    local pkg_mgr="yum"
                    command -v dnf &>/dev/null && pkg_mgr="dnf"
                    $SUDO $pkg_mgr install -y -q git >/dev/null ;;
                arch|manjaro)
                    $SUDO pacman -Sy --noconfirm git >/dev/null ;;
                *)
                    fatal "Please install git manually and re-run this script." ;;
            esac
            ;;
        macos)
            xcode-select --install 2>/dev/null || true
            ;;
    esac

    command -v git &>/dev/null || fatal "git installation failed."
    success "Git installed"
}

# ── Docker ──────────────────────────────────────────────────────────────────

install_docker() {
    step "Checking Docker"

    if command -v docker &>/dev/null; then
        success "Docker already installed: $(docker --version 2>/dev/null)"

        if docker compose version &>/dev/null; then
            success "Docker Compose plugin available"
        else
            warn "Docker Compose plugin not found. Attempting install..."
            _install_compose_plugin
        fi
        _ensure_docker_group
        return
    fi

    info "Docker not found. Installing..."

    case "$OS" in
        linux)  _install_docker_linux ;;
        macos)  _install_docker_macos ;;
    esac

    if ! command -v docker &>/dev/null; then
        fatal "Docker installation failed. Install manually: https://docs.docker.com/get-docker/"
    fi

    success "Docker installed: $(docker --version)"
    _ensure_docker_group
}

_install_docker_linux() {
    case "$DISTRO" in
        ubuntu|debian|pop|linuxmint|elementary|zorin)
            info "Installing Docker via official apt repository..."
            $SUDO apt-get update -qq
            $SUDO apt-get install -y -qq ca-certificates curl gnupg >/dev/null

            $SUDO install -m 0755 -d /etc/apt/keyrings

            # Use upstream distro for derivatives
            local distro_id="ubuntu"
            [ "$DISTRO" = "debian" ] && distro_id="debian"

            curl -fsSL "https://download.docker.com/linux/$distro_id/gpg" \
                | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
            $SUDO chmod a+r /etc/apt/keyrings/docker.gpg

            # shellcheck disable=SC1091
            local codename
            codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"

            echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/$distro_id $codename stable" \
                | $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null

            $SUDO apt-get update -qq
            $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
                docker-buildx-plugin docker-compose-plugin >/dev/null
            ;;

        centos|rhel|rocky|almalinux|ol)
            info "Installing Docker via official yum repository..."
            $SUDO yum install -y -q yum-utils >/dev/null 2>&1 || true
            $SUDO yum-config-manager --add-repo \
                https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null || true
            $SUDO yum install -y -q docker-ce docker-ce-cli containerd.io \
                docker-buildx-plugin docker-compose-plugin >/dev/null
            ;;

        fedora)
            info "Installing Docker via official dnf repository..."
            $SUDO dnf -y install dnf-plugins-core >/dev/null 2>&1 || true
            $SUDO dnf config-manager --add-repo \
                https://download.docker.com/linux/fedora/docker-ce.repo 2>/dev/null || true
            $SUDO dnf install -y -q docker-ce docker-ce-cli containerd.io \
                docker-buildx-plugin docker-compose-plugin >/dev/null
            ;;

        amzn)
            info "Installing Docker on Amazon Linux..."
            $SUDO yum install -y -q docker >/dev/null
            _install_compose_plugin
            ;;

        arch|manjaro)
            info "Installing Docker via pacman..."
            $SUDO pacman -Sy --noconfirm docker docker-compose >/dev/null
            ;;

        *)
            warn "Unknown distro '$DISTRO'. Trying Docker convenience script..."
            curl -fsSL https://get.docker.com | $SUDO sh
            ;;
    esac

    # Enable and start
    if command -v systemctl &>/dev/null; then
        $SUDO systemctl enable docker 2>/dev/null || true
        $SUDO systemctl start docker 2>/dev/null || true
    fi
}

_install_docker_macos() {
    if command -v brew &>/dev/null; then
        info "Installing Docker Desktop via Homebrew..."
        brew install --cask docker 2>/dev/null || true
        echo ""
        warn "Docker Desktop must be running on macOS."
        warn "Please open Docker Desktop from Applications and wait for it to start."
        echo ""
        read -rp "Press Enter once Docker Desktop is running... "
        if ! docker info &>/dev/null 2>&1; then
            fatal "Docker is not running. Start Docker Desktop and re-run this script."
        fi
    else
        fatal "Homebrew not found. Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/"
    fi
}

_install_compose_plugin() {
    if docker compose version &>/dev/null; then return; fi
    info "Installing Docker Compose plugin..."
    local compose_arch="x86_64"
    [ "$ARCH" = "arm64" ] && compose_arch="aarch64"
    $SUDO mkdir -p /usr/local/lib/docker/cli-plugins
    $SUDO curl -fsSL \
        "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${compose_arch}" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose
    $SUDO chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    docker compose version &>/dev/null && success "Docker Compose plugin installed" \
        || warn "Compose plugin install may have failed — continuing anyway"
}

_ensure_docker_group() {
    [ "$OS" != "linux" ] && return
    local current_user
    current_user="$(whoami)"
    [ "$current_user" = "root" ] && return

    if groups "$current_user" 2>/dev/null | grep -qw docker; then
        success "User '$current_user' is in the docker group"
        return
    fi

    info "Adding '$current_user' to the docker group..."
    $SUDO usermod -aG docker "$current_user" 2>/dev/null || true
    NEEDS_NEWGRP=true
    warn "Added to 'docker' group — takes effect on next login."
}

# ── Python ──────────────────────────────────────────────────────────────────

install_python() {
    step "Checking Python"

    local python_cmd=""

    for cmd in python3.13 python3.12 python3.11 python3 python; do
        if command -v "$cmd" &>/dev/null; then
            local ver major minor
            ver="$($cmd -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)" || continue
            major="${ver%%.*}"
            minor="${ver##*.}"
            if [ "${major}" -ge 3 ] && [ "${minor}" -ge 11 ]; then
                python_cmd="$cmd"
                break
            fi
        fi
    done

    if [ -n "$python_cmd" ]; then
        success "Python found: $($python_cmd --version 2>&1)"
        PYTHON="$python_cmd"
        _ensure_pip
        return
    fi

    info "Python 3.11+ not found. Installing..."
    case "$OS" in
        linux)  _install_python_linux ;;
        macos)  _install_python_macos ;;
    esac

    # Re-detect
    python_cmd=""
    for cmd in python3.13 python3.12 python3.11 python3; do
        if command -v "$cmd" &>/dev/null; then
            local ver major minor
            ver="$($cmd -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)" || continue
            major="${ver%%.*}"
            minor="${ver##*.}"
            if [ "${major}" -ge 3 ] && [ "${minor}" -ge 11 ]; then
                python_cmd="$cmd"
                break
            fi
        fi
    done

    [ -z "$python_cmd" ] && fatal "Failed to install Python 3.11+. Install manually: https://python.org/downloads"

    PYTHON="$python_cmd"
    success "Python installed: $($PYTHON --version 2>&1)"
    _ensure_pip
}

_install_python_linux() {
    case "$DISTRO" in
        ubuntu|debian|pop|linuxmint)
            $SUDO apt-get update -qq
            $SUDO apt-get install -y -qq python3 python3-venv python3-pip >/dev/null 2>&1 || true
            ;;
        centos|rhel|rocky|almalinux|ol|fedora|amzn)
            local pkg_mgr="yum"; command -v dnf &>/dev/null && pkg_mgr="dnf"
            $SUDO $pkg_mgr install -y -q python3 python3-pip >/dev/null 2>&1 || true
            ;;
        arch|manjaro)
            $SUDO pacman -Sy --noconfirm python python-pip >/dev/null 2>&1 || true
            ;;
        *)
            warn "Cannot auto-install Python on '$DISTRO'. Install Python 3.11+ manually."
            ;;
    esac
}

_install_python_macos() {
    if command -v brew &>/dev/null; then
        brew install python@3.12 2>/dev/null || brew install python@3.11 2>/dev/null || true
    else
        fatal "Homebrew not found. Install Python 3.11+: https://python.org/downloads"
    fi
}

_ensure_pip() {
    if "$PYTHON" -m pip --version &>/dev/null 2>&1; then return; fi
    info "Installing pip..."
    "$PYTHON" -m ensurepip --upgrade 2>/dev/null \
        || curl -fsSL https://bootstrap.pypa.io/get-pip.py | "$PYTHON" - 2>/dev/null \
        || warn "Could not install pip. You may need to install it manually."
}

# ── Install djinn-bot-cli ──────────────────────────────────────────────────

install_cli() {
    step "Installing djinn-bot-cli"

    if command -v pipx &>/dev/null; then
        info "Installing via pipx..."
        if pipx install djinn-bot-cli --force 2>/dev/null; then
            success "djinn-bot-cli installed via pipx"
            _verify_djinn_in_path
            return
        fi
    fi

    info "Installing via pip..."
    "$PYTHON" -m pip install --user --upgrade --quiet djinn-bot-cli 2>/dev/null \
        || "$PYTHON" -m pip install --upgrade --quiet djinn-bot-cli 2>/dev/null \
        || $SUDO "$PYTHON" -m pip install --upgrade --quiet djinn-bot-cli 2>/dev/null \
        || fatal "Failed to install djinn-bot-cli. Try: pip install djinn-bot-cli"

    success "djinn-bot-cli installed"
    _verify_djinn_in_path
}

_verify_djinn_in_path() {
    if command -v djinn &>/dev/null; then return; fi

    # Check common pip --user locations
    local user_bin="$HOME/.local/bin"
    if [ -x "$user_bin/djinn" ]; then
        export PATH="$user_bin:$PATH"
        warn "Added $user_bin to PATH for this session."
        warn "Make it permanent: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
        return
    fi

    # macOS brew/pip paths
    for p in "/opt/homebrew/bin" "/usr/local/bin" "$HOME/Library/Python/3.12/bin" "$HOME/Library/Python/3.11/bin"; do
        if [ -x "$p/djinn" ]; then
            export PATH="$p:$PATH"
            return
        fi
    done

    warn "'djinn' command not found in PATH. You may need to open a new terminal."
}

# ── Main ────────────────────────────────────────────────────────────────────

main() {
    echo ""
    echo -e "${BOLD}${CYAN}"
    cat << 'BANNER'
   ____  _ _             ____        _
  |  _ \(_|_)_ __  _ __ | __ )  ___ | |_
  | | | | | | '_ \| '_ \|  _ \ / _ \| __|
  | |_| | | | | | | | | | |_) | (_) | |_
  |____// |_|_| |_|_| |_|____/ \___/ \__|
       |__/
BANNER
    echo -e "  Autonomous AI Teams Platform${NC}"
    echo -e "  ${DIM}https://github.com/BaseDatum/djinnbot${NC}"
    echo ""

    NEEDS_NEWGRP=false
    SUDO=""

    detect_platform
    check_root_or_sudo
    install_git
    install_docker
    install_python
    install_cli

    echo ""
    echo -e "${GREEN}${BOLD}All prerequisites installed successfully.${NC}"
    echo ""
    info "The setup wizard will now guide you through:"
    info "  1. Cloning the DjinnBot repository"
    info "  2. Generating encryption keys"
    info "  3. Configuring your first model provider"
    info "  4. Starting the Docker stack"
    info "  5. Optional SSL/TLS setup with Traefik"
    echo ""

    # Find the djinn command
    local djinn_cmd=""
    if command -v djinn &>/dev/null; then
        djinn_cmd="djinn"
    else
        # Fall back to module invocation
        djinn_cmd="$PYTHON -m djinnbot.main"
    fi

    if [ "$NEEDS_NEWGRP" = true ]; then
        info "Activating docker group for this session..."
        exec sg docker -c "$djinn_cmd setup"
    else
        exec $djinn_cmd setup
    fi
}

main "$@"
