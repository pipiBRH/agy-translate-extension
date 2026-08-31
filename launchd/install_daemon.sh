#!/bin/bash
set -e

PLIST_NAME="com.agy.translate.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$TARGET_DIR"

# 1. Detect Python 3 path
PYTHON_BIN="$(which python3 || echo /usr/bin/python3)"
if [ ! -x "$PYTHON_BIN" ]; then
  echo "❌ Error: python3 not found. Please install Python 3."
  exit 1
fi

# 2. Prefer self-contained server.py inside extension repo
SERVER_PATH="$SCRIPT_DIR/server/server.py"
if [ ! -f "$SERVER_PATH" ]; then
  echo "❌ Error: Could not find server.py at $SERVER_PATH"
  exit 1
fi

echo "📍 Python interpreter: $PYTHON_BIN"
echo "📍 Daemon script:     $SERVER_PATH"

# 3. Synchronize with Alfred workflow if present on this machine
ALFRED_AGYTRANS=$(find "$HOME/Alfred" "$HOME/Library/Application Support/Alfred" -name "agytrans.py" 2>/dev/null || true)
if [ -n "$ALFRED_AGYTRANS" ]; then
  for af in $ALFRED_AGYTRANS; do
    if [ -f "$af" ]; then
      echo "🔄 Syncing updated daemon to Alfred: $af"
      cp "$SERVER_PATH" "$af"
    fi
  done
fi

# 4. Force kill ANY old process occupying port 47821
echo "🧹 Releasing port 47821..."
lsof -ti :47821 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
pkill -f "server.py serve" 2>/dev/null || true
pkill -f "agytrans.py serve" 2>/dev/null || true
sleep 1

# 5. Generate LaunchAgent plist dynamically
cat <<EOF > "$TARGET_DIR/$PLIST_NAME"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agy.translate</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
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

# 6. Reload LaunchAgent
launchctl unload "$TARGET_DIR/$PLIST_NAME" 2>/dev/null || true
launchctl load "$TARGET_DIR/$PLIST_NAME"

# 7. Verify daemon health
sleep 1
PING_RES=$(curl -s http://127.0.0.1:47821/ping || true)
if [[ "$PING_RES" == *"agy-translate"* ]]; then
  echo "✅ Daemon service is running successfully on port 47821!"
else
  echo "⚠️ Daemon starting... checking logs in /tmp/agytrans.stderr.log:"
  tail -n 10 /tmp/agytrans.stderr.log 2>/dev/null || true
fi

# 8. Check Google Login status
LOGIN_CHECK=$("$PYTHON_BIN" -c "
import sys, os
sys.path.insert(0, os.path.dirname('$SERVER_PATH'))
import server as s
print('LOGGED_IN' if s.logged_in() else 'NEEDS_LOGIN')
" 2>/dev/null || echo "UNKNOWN")

if [ "$LOGIN_CHECK" = "NEEDS_LOGIN" ]; then
  echo ""
  echo "⚠️ Google Authentication Required!"
  echo "Run this command to sign in with your Google Antigravity account:"
  echo "👉 $PYTHON_BIN \"$SERVER_PATH\" login"
  echo ""
else
  echo "🔑 Google Antigravity authentication verified!"
fi
