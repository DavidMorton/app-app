#!/usr/bin/env bash
set -euo pipefail

# AppApp Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/<owner>/AppApp/main/install.sh | bash

REPO="https://github.com/DavidMorton/app-app.git"
INSTALL_DIR="${APPAPP_DIR:-$HOME/AppApp}"

# Colors
bold="\033[1m"
red="\033[31m"
green="\033[32m"
yellow="\033[33m"
cyan="\033[36m"
reset="\033[0m"

info()  { printf "${bold}${green}==>${reset} ${bold}%s${reset}\n" "$*"; }
warn()  { printf "${bold}${yellow}warning:${reset} %s\n" "$*"; }
error() { printf "${bold}${red}error:${reset} %s\n" "$*" >&2; }
die()   { error "$@"; exit 1; }

# ── Pre-flight checks ──────────────────────────────────────────────

info "Checking prerequisites..."

# Check for git
if ! command -v git &>/dev/null; then
    echo ""
    error "git is not installed."
    echo ""
    case "$(uname -s)" in
        Darwin*)
            echo "  Install it by running:"
            echo "    xcode-select --install"
            ;;
        Linux*)
            echo "  Install it with your package manager, e.g.:"
            echo "    sudo apt install git      # Debian/Ubuntu"
            echo "    sudo dnf install git      # Fedora"
            echo "    sudo pacman -S git        # Arch"
            ;;
        *)
            echo "  Install git from: https://git-scm.com/downloads"
            ;;
    esac
    echo ""
    die "Install git and try again."
fi

# Check for uv, offer to install if missing
if ! command -v uv &>/dev/null; then
    warn "uv is not installed."
    echo "  uv is a fast Python package manager that handles Python + dependencies for you."

    # When piped from curl, stdin is the script itself — can't read interactively.
    # Auto-install uv since the user already opted in by running the install script.
    if [[ ! -t 0 ]]; then
        info "Installing uv automatically..."
        curl -LsSf https://astral.sh/uv/install.sh | sh
    else
        printf "  Install it now? [Y/n] "
        read -r answer
        if [[ "${answer:-Y}" =~ ^[Yy]$ ]]; then
            info "Installing uv..."
            curl -LsSf https://astral.sh/uv/install.sh | sh
        else
            die "uv is required. Install it from https://docs.astral.sh/uv/ and try again."
        fi
    fi

    # Source the env so uv is available in this session
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    if ! command -v uv &>/dev/null; then
        echo ""
        error "uv was installed but can't be found on PATH."
        echo "  Try restarting your terminal and running this script again."
        echo ""
        die "Could not find uv after installation."
    fi
    info "uv installed successfully."
fi

# Check Python availability (uv can install it, but let's verify)
if ! uv python find ">=3.11" &>/dev/null; then
    info "Python 3.11+ not found. Installing via uv..."
    uv python install 3.11
    if ! uv python find ">=3.11" &>/dev/null; then
        die "Failed to install Python 3.11. Install it manually and try again."
    fi
    info "Python installed successfully."
fi

# Check for Claude Code CLI
CLAUDE_FOUND=false
if command -v claude &>/dev/null; then
    CLAUDE_FOUND=true
else
    # Check common install locations
    for p in "$HOME/.local/bin/claude" "/usr/local/bin/claude" "$HOME/.npm-global/bin/claude"; do
        if [[ -x "$p" ]]; then
            warn "Found claude at $p but it's not on your PATH."
            echo "  Add this to your shell config:"
            echo "    export PATH=\"$(dirname "$p"):\$PATH\""
            CLAUDE_FOUND=true
            break
        fi
    done
fi

if ! $CLAUDE_FOUND; then
    echo ""
    warn "Claude Code CLI is not installed (or not on your PATH)."
    echo ""
    echo "  AppApp needs the Claude Code CLI to work. You can install it after"
    echo "  this setup finishes, but it must be available before you start the app."
    echo ""
    echo "  Install guide: ${cyan}https://docs.anthropic.com/en/docs/claude-code${reset}"
    echo ""
    printf "  Continue installation anyway? [Y/n] "
    if [[ -t 0 ]]; then
        read -r answer
        [[ "${answer:-Y}" =~ ^[Yy]$ ]] || die "Install Claude Code first, then re-run this script."
    fi
fi

info "Prerequisites checked."

# ── Clone / update repo ────────────────────────────────────────────

if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "AppApp already exists at $INSTALL_DIR, pulling latest..."
    git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || warn "Could not pull latest. Using existing version."
else
    if [[ -d "$INSTALL_DIR" ]]; then
        die "$INSTALL_DIR exists but is not an AppApp installation. Remove it or set APPAPP_DIR to a different path."
    fi
    info "Downloading AppApp to $INSTALL_DIR..."
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

# ── Install dependencies ───────────────────────────────────────────

cd "$INSTALL_DIR"
info "Installing Python dependencies..."
uv sync --quiet

# ── Create launcher script ─────────────────────────────────────────

LAUNCHER="$INSTALL_DIR/start.sh"
cat > "$LAUNCHER" << 'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
APPAPP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APPAPP_DIR/src/web_app"
exec uv run --project "$APPAPP_DIR" python app.py "$@"
SCRIPT
chmod +x "$LAUNCHER"

# ── Shell alias ─────────────────────────────────────────────────────

add_alias() {
    local shell_rc="$1"
    local alias_line="alias appapp='$LAUNCHER'"
    if [[ -f "$shell_rc" ]] && grep -qF "alias appapp=" "$shell_rc"; then
        # Update existing alias
        sed -i.bak "s|alias appapp=.*|$alias_line|" "$shell_rc" && rm -f "${shell_rc}.bak"
    else
        printf '\n# AppApp launcher\n%s\n' "$alias_line" >> "$shell_rc"
    fi
}

ALIAS_ADDED=false
if [[ "$SHELL" == */zsh ]]; then
    add_alias "$HOME/.zshrc"
    ALIAS_ADDED=true
elif [[ "$SHELL" == */bash ]]; then
    add_alias "$HOME/.bashrc"
    ALIAS_ADDED=true
fi

# ── Done ────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
info "AppApp installed!"
echo ""
echo "  Start it:"
echo "    ${bold}$LAUNCHER${reset}"
echo ""
if $ALIAS_ADDED; then
    echo "  Or restart your terminal and run:"
    echo "    ${bold}appapp${reset}"
    echo ""
fi
echo "  Then open ${cyan}http://127.0.0.1:5050${reset} in your browser."
if ! $CLAUDE_FOUND; then
    echo ""
    warn "Remember to install Claude Code before starting!"
    echo "  ${cyan}https://docs.anthropic.com/en/docs/claude-code${reset}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
