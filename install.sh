#!/bin/bash
set -e

APP_NAME="DocGen"
DMG_URL="https://github.com/c3-jack/docgen/releases/download/v0.2.0/DocGen-1.0.0-arm64.dmg"
DMG_PATH="/tmp/DocGen-install.dmg"
MOUNT_POINT=""

echo "Installing $APP_NAME..."

# Kill running instance
if pgrep -x "$APP_NAME" > /dev/null 2>&1; then
  echo "Closing running $APP_NAME..."
  pkill -x "$APP_NAME" || true
  sleep 1
fi

# Download
echo "Downloading..."
curl -L -o "$DMG_PATH" "$DMG_URL"

# Mount
echo "Mounting..."
MOUNT_POINT=$(hdiutil attach "$DMG_PATH" -nobrowse -noautoopen 2>/dev/null | grep '/Volumes/' | sed 's/.*\(\/Volumes\/.*\)/\1/' | head -1)

if [ -z "$MOUNT_POINT" ]; then
  echo "Error: Failed to mount DMG"
  exit 1
fi

# Remove old version
if [ -d "/Applications/$APP_NAME.app" ]; then
  echo "Removing old version..."
  rm -rf "/Applications/$APP_NAME.app"
fi

# Copy
echo "Installing to /Applications..."
cp -R "$MOUNT_POINT/$APP_NAME.app" /Applications/

# Unmount
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
rm -f "$DMG_PATH"

# Clear quarantine
xattr -cr "/Applications/$APP_NAME.app"

echo "Done. Launching $APP_NAME..."
open "/Applications/$APP_NAME.app"
