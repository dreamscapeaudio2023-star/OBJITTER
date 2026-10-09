#!/bin/bash
# Builds "Objitter.app" — a Dock/Launchpad-friendly launcher for this Objitter folder (macOS only).
# Usage (from the project folder):   bash scripts/make-mac-app.sh [destination folder]
# The app opens Terminal and runs start-mac.command, so the server log stays visible and Ctrl+C stops it.
# If the project folder is moved, run this script again.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script only runs on macOS (it needs sips and iconutil)." >&2
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${1:-$PROJECT_DIR}"
APP="$DEST_DIR/Objitter.app"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PROJECT_DIR/package.json" | head -n 1)
VERSION=${VERSION:-0.0.0}

echo "Building $APP (Objitter $VERSION)…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ---- icon (.icns) ----
SRC_ICON="$PROJECT_DIR/public/assets/icon-source.png"
[ -f "$SRC_ICON" ] || SRC_ICON="$PROJECT_DIR/public/assets/icon-512.png"
TMP=$(mktemp -d)
ICONSET="$TMP/Objitter.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -s format png -z "$s" "$s" "$SRC_ICON" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -s format png -z "$d" "$d" "$SRC_ICON" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Objitter.icns"
rm -rf "$TMP"

# ---- Info.plist ----
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Objitter</string>
  <key>CFBundleDisplayName</key><string>Objitter</string>
  <key>CFBundleIdentifier</key><string>app.objitter.launcher</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>objitter</string>
  <key>CFBundleIconFile</key><string>Objitter</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>© 2026 DREAMSCAPE Inc. All rights reserved. Internal use only.</string>
  <key>CFBundleGetInfoString</key><string>Objitter $VERSION · Made by DREAMSCAPE</string>
</dict>
</plist>
PLIST

# ---- launcher ----
ESCAPED_DIR=$(printf '%q' "$PROJECT_DIR")
cat > "$APP/Contents/MacOS/objitter" <<LAUNCH
#!/bin/bash
PROJECT_DIR=$ESCAPED_DIR
if [ ! -f "\$PROJECT_DIR/start-mac.command" ]; then
  osascript -e 'display alert "Objitter" message "The Objitter folder was moved or deleted. Run scripts/make-mac-app.sh again in the new location."'
  exit 1
fi
chmod +x "\$PROJECT_DIR/start-mac.command" 2>/dev/null
open -a Terminal "\$PROJECT_DIR/start-mac.command"
LAUNCH
chmod +x "$APP/Contents/MacOS/objitter" "$PROJECT_DIR/start-mac.command"

# Locally built bundles carry no quarantine flag, but clear it in case the folder was downloaded.
xattr -cr "$APP" 2>/dev/null || true
touch "$APP"
echo "Done: $APP"
echo "Drag it to the Dock or /Applications. First launch: right-click → Open if macOS asks."
