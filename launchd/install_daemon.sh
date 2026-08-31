#!/bin/bash
set -e

PLIST_NAME="com.agy.translate.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$TARGET_DIR"

# Dynamically locate daemon script
SERVER_PATH=""

# 1. Prefer self-contained server.py inside extension repo
if [ -f "$SCRIPT_DIR/server/server.py" ]; then
  SERVER_PATH="$SCRIPT_DIR/server/server.py"
fi

# 2. Fallback: Search in Alfred Workflows
if [ -z "$SERVER_PATH" ]; then
  FOUND=$(find "$HOME/Alfred" "$HOME/Library/Application Support/Alfred" -name "agytrans.py" 2>/dev/null | head -n 1 || true)
  if [ -n "$FOUND" ] && [ -f "$FOUND" ]; then
    SERVER_PATH="$FOUND"
  fi
fi

if [ -z "$SERVER_PATH" ]; then
  echo "❌ Error: Could not automatically locate server.py or agytrans.py."
  echo "Please specify the server path manually."
  exit 1
fi

echo "📍 Using daemon script at: $SERVER_PATH"

# Generate LaunchAgent plist dynamically
cat <<EOF > "$TARGET_DIR/$PLIST_NAME"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agy.translate</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>$SERVER_PATH</string>
        <string>serve</string>
        <string>47821</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/agytrans.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/agytrans.stderr.log</string>
</dict>
</plist>
EOF

launchctl unload "$TARGET_DIR/$PLIST_NAME" 2>/dev/null || true
launchctl load "$TARGET_DIR/$PLIST_NAME"

echo "✅ agytrans background service is running and configured for automatic startup!"
echo "Test connection: curl http://127.0.0.1:47821/ping"
