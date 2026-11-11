#!/usr/bin/env bash
# Lightweight macOS .app wrapper for the OHLC Viewer.
#
# Runs the viewer with the SYSTEM python3 (polars / webview / tkinter must be
# installed there). No PyInstaller, no bundled interpreter, no standalone
# installer. The Python source + static assets are copied into the bundle so
# the app is self-contained except for the python libraries.
#
#   bash build_macos.sh
#
# Result: /Applications/OHLC Viewer.app  (also registered to open .parquet)
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="OHLC Viewer"
APP="/Applications/$APP_NAME.app"
RES="$APP/Contents/Resources"
MACOS="$APP/Contents/MacOS"

# System python that has the required packages.
PYTHON_BIN="$(command -v python3 || true)"
if [ -z "$PYTHON_BIN" ]; then
  PYTHON_BIN="/opt/homebrew/bin/python3"
fi

# Files/folders the app needs at runtime (script + static assets).
ASSETS=(
  ohlc_viewer.py
  index.html
  app.js
  klinecharts.min.js
  indicators
  OHLC Viewer.webp
)

rm -rf "$APP"
mkdir -p "$RES" "$MACOS"

# Copy the viewer + assets into the bundle so it is self-contained
# (only the python libraries stay external, as requested).
for a in "${ASSETS[@]}"; do
  cp -R "$a" "$RES/"
done

# App icon: convert the project's OHLV Viewer.webp -> Icon.icns (Pillow reads
# webp; falls back to sips for other formats). Skipped if no icon source.
ICON_SRC="OHLC Viewer.webp"
if [ -f "$ICON_SRC" ]; then
  TMPIC="$(mktemp -d)"
  /opt/homebrew/bin/python3 - "$ICON_SRC" "$TMPIC/icon.png" <<'PY' >/dev/null 2>&1 || \
  /usr/bin/sips -s format png "$ICON_SRC" --out "$TMPIC/icon.png" >/dev/null 2>&1
from PIL import Image
import sys
Image.open(sys.argv[1]).convert("RGBA").save(sys.argv[2])
PY
  /usr/bin/sips -z 1024 1024 "$TMPIC/icon.png" --out "$TMPIC/icon.png" >/dev/null 2>&1 || true
  mkdir -p "$TMPIC/icns.iconset"
  for s in 16 32 64 128 256 512; do
    /usr/bin/sips -z "$s" "$s" "$TMPIC/icon.png" --out "$TMPIC/icns.iconset/icon_${s}x${s}.png" >/dev/null 2>&1
    /usr/bin/sips -z "$((s*2))" "$((s*2))" "$TMPIC/icon.png" --out "$TMPIC/icns.iconset/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  /usr/bin/iconutil -c icns -o "$RES/Icon.icns" "$TMPIC/icns.iconset" >/dev/null 2>&1 && echo "icon embedded"
fi

# Launcher: run the bundled script with the system python.
# Output is logged so any failure is visible in /tmp/OHLC Viewer.log.
cat > "$MACOS/launcher.sh" <<EOF
#!/bin/bash
export PYTHONUNBUFFERED=1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\$PATH"
exec "$PYTHON_BIN" "$RES/ohlc_viewer.py" "\$@" >>"/tmp/$APP_NAME.log" 2>&1
EOF
chmod +x "$MACOS/launcher.sh"

# Info.plist — mirrors the proven ParquetViewer layout (extension-based
# document type + top-level LSHandlerRank) so Finder passes the opened
# .parquet to the script as argv[1] on double-click / Open With.
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>com.personal.ohlcviewer</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher.sh</string>
  <key>CFBundleIconFile</key><string>Icon</string>
  <key>LSHandlerRank</key><string>Owner</string>
  <key>CFBundleDocumentTypes</key>
  <array><dict>
    <key>CFBundleTypeName</key><string>Parquet File</string>
    <key>LSHandlerRank</key><string>Owner</string>
    <key>CFBundleTypeExtensions</key><array><string>parquet</string></array>
  </dict></array>
</dict></plist>
EOF

# Clear Gatekeeper quarantine so double-clicking actually launches.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

# Register the .parquet "Open With" association with Finder.
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -R -f "$APP" 2>/dev/null || true

echo "Built $APP"
echo "Runtime log: /tmp/$APP_NAME.log"
