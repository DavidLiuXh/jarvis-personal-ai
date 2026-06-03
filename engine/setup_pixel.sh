#!/data/data/com.termux/files/usr/bin/bash
# FORGE ENGINE — Pixel 9 Pro XL setup
# Run this once in Termux. Does everything.
set -e

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; NC='\033[0m'
say(){ echo -e "${GRN}▶ $1${NC}"; }
err(){ echo -e "${RED}✗ $1${NC}"; exit 1; }
warn(){ echo -e "${YLW}⚠ $1${NC}"; }

echo ""
echo -e "${RED}  ████████╗ ██████╗ ██████╗  ██████╗ ███████╗${NC}"
echo -e "${RED}  ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝${NC}"
echo -e "${RED}  █████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ${NC}"
echo -e "${RED}  ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ${NC}"
echo -e "${RED}  ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗${NC}"
echo -e "${RED}  ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝${NC}"
echo ""
echo "  Local AI engine — Pixel 9 Pro XL setup"
echo "  No cloud. No API. No phone home."
echo ""

# ── 1. packages ────────────────────────────────────────────
say "Updating packages..."
pkg update -y -o Dpkg::Options::="--force-confold" 2>/dev/null || warn "Update had warnings, continuing"
pkg install -y wget curl python git 2>/dev/null || err "Package install failed. Check your internet connection."

say "Installing Python requests..."
pip install -q requests || err "pip install requests failed"

# ── 2. ollama ──────────────────────────────────────────────
say "Installing Ollama (ARM64)..."
OLLAMA_BIN="$PREFIX/bin/ollama"
if [ -f "$OLLAMA_BIN" ]; then
  warn "Ollama already installed at $OLLAMA_BIN — skipping download"
else
  wget -q --show-progress \
    "https://github.com/ollama/ollama/releases/latest/download/ollama-linux-arm64" \
    -O "$OLLAMA_BIN" || err "Ollama download failed. Check internet."
  chmod +x "$OLLAMA_BIN"
  say "Ollama installed"
fi

# ── 3. clone repo ──────────────────────────────────────────
FORGE_DIR="$HOME/forge"
if [ -d "$FORGE_DIR/.git" ]; then
  say "Repo already cloned — pulling latest..."
  git -C "$FORGE_DIR" pull --ff-only || warn "Pull failed, using existing files"
else
  say "Cloning repo..."
  git clone https://github.com/Guffalo/jarvis-personal-ai.git "$FORGE_DIR" \
    || err "Git clone failed. Check internet and repo access."
fi

# ── 4. start script ────────────────────────────────────────
say "Creating start script..."
cat > "$HOME/start_forge.sh" << 'STARTEOF'
#!/data/data/com.termux/files/usr/bin/bash
cd ~/forge/engine

# start ollama if not running
if ! pgrep -x ollama > /dev/null; then
  OLLAMA_HOST=0.0.0.0 ollama serve > /tmp/ollama.log 2>&1 &
  echo "Starting Ollama..."
  sleep 3
fi

# start engine server
echo "Starting FORGE ENGINE on http://127.0.0.1:7331"
python agent.py --server
STARTEOF
chmod +x "$HOME/start_forge.sh"

# ── 5. termux-boot auto-start (optional) ──────────────────
BOOT_DIR="$HOME/.termux/boot"
if [ -d "$BOOT_DIR" ]; then
  say "Termux:Boot detected — setting up auto-start..."
  cat > "$BOOT_DIR/forge.sh" << 'BOOTEOF'
#!/data/data/com.termux/files/usr/bin/bash
# auto-start FORGE ENGINE on boot
termux-wake-lock
sleep 10  # wait for wifi
cd ~/forge/engine
OLLAMA_HOST=0.0.0.0 ollama serve > /tmp/ollama.log 2>&1 &
sleep 5
python agent.py --server > /tmp/forge.log 2>&1 &
BOOTEOF
  chmod +x "$BOOT_DIR/forge.sh"
  say "Auto-start configured"
else
  warn "Termux:Boot not installed — engine won't auto-start on reboot"
  warn "Install Termux:Boot from F-Droid if you want that"
fi

# ── 6. pull model ─────────────────────────────────────────
say "Starting Ollama to pull model..."
if ! pgrep -x ollama > /dev/null; then
  OLLAMA_HOST=0.0.0.0 ollama serve > /tmp/ollama.log 2>&1 &
  # wait until Ollama is actually listening (up to 30s)
  for i in $(seq 1 15); do
    sleep 2
    if curl -sf http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
      say "Ollama ready"
      break
    fi
    [ "$i" -eq 15 ] && warn "Ollama slow to start — pull may fail, retry manually"
  done
else
  say "Ollama already running"
fi

say "Pulling qwen2.5-coder:3b (small, fast on mobile)..."
ollama pull qwen2.5-coder:3b || {
  warn "Model pull failed — you can do it manually later: ollama pull qwen2.5-coder:3b"
}

# verify model is present before launching
if ! ollama list 2>/dev/null | grep -q "qwen2.5-coder:3b"; then
  warn "Model not confirmed — run 'ollama pull qwen2.5-coder:3b' before starting engine"
fi

# ── done ──────────────────────────────────────────────────
echo ""
echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GRN}  FORGE ENGINE READY${NC}"
echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  To start the engine:"
echo "    bash ~/start_forge.sh"
echo ""
echo "  Then open in Vanadium:"
echo "    http://127.0.0.1:7331/launch.html"
echo ""
echo "  Add to home screen:"
echo "    Vanadium menu → Add to Home Screen → FORGE"
echo ""
echo "  Starting engine now..."
echo ""
bash "$HOME/start_forge.sh"
