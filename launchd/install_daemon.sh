#!/bin/bash
set -e

PLIST_NAME="com.agy.translate.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$TARGET_DIR"

# Dynamically find agytrans.py in Alfred workflows or local environment
AGYTRANS_PATH=""

# 1. Search in Alfred Workflows
FOUND=$(find "$HOME/Alfred" "$HOME/Library/Application Support/Alfred" -name "agytrans.py" 2>/dev/null | head -n 1 || true)
if [ -n "$FOUND" ] && [ -f "$FOUND" ]; then
  AGYTRANS_PATH="$FOUND"
fi

# 2. Search in common development folders
if [ -z "$AGYTRANS_PATH" ]; then
  FOUND=$(find "$HOME" -maxdepth 4 -name "agytrans.py" 2>/dev/null | head -n 1 || true)
  if [ -n "$FOUND" ] && [ -f "$FOUND" ]; then
    AGYTRANS_PATH="$FOUND"
  fi
fi

if [ -z "$AGYTRANS_PATH" ]; then
  echo "❌ Error: Could not automatically locate agytrans.py."
  echo "Please specify the path to agytrans.py manually."
  exit 1
fi

echo "📍 Found agytrans.py at: $AGYTRANS_PATH"

# Generate plist dynamically without hardcoded usernames
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
        <string>$AGYTRANS_PATH</string>
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
