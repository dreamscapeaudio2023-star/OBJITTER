#!/bin/bash
# Objitter launcher for macOS (Apple Silicon and Intel). Double-click in Finder.
# First run: if macOS blocks it, right-click → Open, or run:  xattr -dr com.apple.quarantine <this folder>
cd "$(dirname "$0")" || exit 1

pause_exit() {
  echo
  read -r -p "Press Enter to close this window… " _
  exit "${1:-1}"
}

# Finder-launched shells don't read ~/.zshrc, so Node from Homebrew / Volta / nvm is not on PATH.
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    nvm use --silent default >/dev/null 2>&1 || true
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  latest=$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -n 1)
  [ -n "$latest" ] && PATH="$latest:$PATH"
fi
export PATH

need=$(sed -n 's/.*"node": *">= *\([0-9][0-9]*\).*/\1/p' package.json | head -n 1)
need=${need:-18}
if ! command -v node >/dev/null 2>&1; then
  echo "[objitter] Node.js $need or newer is required."
  echo "  Install it from https://nodejs.org (LTS, macOS Installer) or with Homebrew:  brew install node"
  pause_exit 1
fi
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$have" -lt "$need" ] 2>/dev/null; then
  echo "[objitter] Node.js $(node -v) is too old — version $need or newer is required (https://nodejs.org)."
  pause_exit 1
fi

if [ ! -d node_modules/ws ]; then
  echo "[objitter] Installing dependencies (first run)…"
  if ! command -v npm >/dev/null 2>&1; then
    echo "[objitter] npm was not found next to node ($(command -v node))."
    pause_exit 1
  fi
  npm install --omit=dev || { echo "[objitter] npm install failed (check the network connection)."; pause_exit 1; }
fi

PORT="${PORT:-8080}"
case "$PORT" in
  '' | *[!0-9]*) echo "[objitter] PORT=\"$PORT\" is not a number — using 8080."; PORT=8080 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "[objitter] PORT=$PORT is out of range — using 8080."
  PORT=8080
fi
export PORT

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -fs --max-time 2 "http://127.0.0.1:$PORT/manifest.webmanifest" 2>/dev/null | grep -q '"Objitter'; then
    echo "[objitter] Objitter is already running on port $PORT — opening the browser."
    open "http://localhost:$PORT"
    exit 0
  fi
  echo "[objitter] Port $PORT is already used by another program:"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sed -n '1,5p'
  echo "  Quit that program, or start Objitter on another port, e.g.:  PORT=8081 ./start-mac.command"
  pause_exit 1
fi

# Open the browser only once the server answers (avoids a "can't connect" page on slow starts).
(
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"; then
      open "http://localhost:$PORT"
      exit 0
    fi
    sleep 0.5
  done
) &
opener=$!

node server/index.js &
srv=$!
stop_all() {
  trap - INT TERM HUP
  kill "$opener" 2>/dev/null
  kill -TERM "$srv" 2>/dev/null
  wait "$srv" 2>/dev/null
  echo
  echo "[objitter] Stopped."
  exit 0
}
trap stop_all INT TERM HUP
wait "$srv"
code=$?
kill "$opener" 2>/dev/null
if [ "$code" -ne 0 ]; then
  echo "[objitter] The server exited with code $code."
  pause_exit "$code"
fi
