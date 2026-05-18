#!/bin/bash
set -e

APP_NAME="DocGen"
DMG_URL="https://github.com/c3-jack/docgen/releases/download/v0.2.0/DocGen-1.0.0-arm64.dmg"
DMG_PATH="/tmp/DocGen-install.dmg"

# Pick install dir — /Applications if writable, else ~/Applications
INSTALL_DIR="/Applications"
if ! touch "$INSTALL_DIR/.docgen-write-test" 2>/dev/null; then
  INSTALL_DIR="$HOME/Applications"
  mkdir -p "$INSTALL_DIR"
else
  rm -f "$INSTALL_DIR/.docgen-write-test"
fi

echo "Installing $APP_NAME to $INSTALL_DIR..."

# Kill running instance
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 2

# Download
echo "Downloading..."
curl -L --fail -o "$DMG_PATH" "$DMG_URL"

# Mount
echo "Mounting..."
MOUNT_POINT=$(hdiutil attach "$DMG_PATH" -nobrowse -noautoopen 2>/dev/null | awk -F'\t' '/\/Volumes\//{print $NF}')

if [ -z "$MOUNT_POINT" ] || [ ! -d "$MOUNT_POINT" ]; then
  echo "Error: Failed to mount DMG"
  exit 1
fi

# Remove old version
if [ -d "$INSTALL_DIR/$APP_NAME.app" ]; then
  echo "Removing old version..."
  rm -rf "$INSTALL_DIR/$APP_NAME.app"
fi

# Copy
echo "Installing..."
cp -R "$MOUNT_POINT/$APP_NAME.app" "$INSTALL_DIR/"

# Unmount + cleanup
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
rm -f "$DMG_PATH"

# Clear quarantine
xattr -cr "$INSTALL_DIR/$APP_NAME.app"

echo "Done. Launching $APP_NAME..."
open "$INSTALL_DIR/$APP_NAME.app"
