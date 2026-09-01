#!/bin/bash
# Run: npm run service:install
#
# Makes Overlord start by itself when you log in, and restart if it crashes.
#
# WHAT THIS IS: a macOS LaunchAgent — a plist in ~/Library/LaunchAgents that
# launchd (the process that starts everything on a Mac) reads at login.
#
# WHAT IT IS NOT: a way to run when the laptop is off. Nothing runs on a
# powered-down machine. See "Sleep vs shutdown" in the README.
#
# A user LaunchAgent runs as YOU, only after YOU log in, and inherits your
# permissions — the same Microphone and Automation grants your terminal has.
# That is the correct place for a personal agent: not a system daemon with
# root, just your own program started automatically.

set -e

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
LABEL="com.kabir.overlord"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/Overlord"

if [ -z "$NODE" ]; then
  echo "node not found on PATH"; exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$PROJECT/src/index.js</string>
    <string>--wake</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT</string>

  <!-- Start at login. -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Restart if it dies. THROTTLE MATTERS: without it, a program that
       crashes instantly gets relaunched in a tight loop and pins a CPU
       core forever. Ten seconds turns a crash-loop into a slow retry. -->
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <!-- Homebrew is not on launchd's PATH by default, so sox and whisper-cli
       would be "not found" even though they work fine in your terminal.
       This is the single most common reason a LaunchAgent behaves
       differently from the same command run by hand. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>$LOGDIR/overlord.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGDIR/overlord.error.log</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo ""
echo "  Installed. Overlord now starts automatically when you log in."
echo ""
echo "  logs:     tail -f $LOGDIR/overlord.log"
echo "  stop:     npm run service:stop"
echo "  restart:  npm run service:restart"
echo ""
echo "  First run may ask for Microphone permission — approve it."
echo ""
