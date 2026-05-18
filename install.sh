#!/bin/bash
set -e

APP_NAME="DocGen"
VERSION="0.2.0"
DMG_URL="https://github.com/c3-jack/docgen/releases/download/v${VERSION}/DocGen-1.0.0-arm64.dmg"
DMG_PATH="/tmp/DocGen-install.dmg"
MOUNT_POINT=""

# Check architecture
ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
  echo "Error: DocGen requires Apple Silicon (M1/M2/M3). This Mac is $ARCH."
  exit 1
fi

# Cleanup on exit, error, or interrupt
cleanup() {
  if [ -n "$MOUNT_POINT" ] && [ -d "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  fi
  rm -f "$DMG_PATH"
}
trap cleanup EXIT

# Pick install dir — /Applications if writable, else ~/Applications
INSTALL_DIR="/Applications"
if ! touch "$INSTALL_DIR/.docgen-write-test" 2>/dev/null; then
  INSTALL_DIR="$HOME/Applications"
  mkdir -p "$INSTALL_DIR"
  echo "Note: Installing to ~/Applications (no write access to /Applications)"
else
  rm -f "$INSTALL_DIR/.docgen-write-test"
fi

echo "Installing $APP_NAME v$VERSION to $INSTALL_DIR..."

# Warn about running instance
if pgrep -x "$APP_NAME" > /dev/null 2>&1; then
  echo "Closing running $APP_NAME (save any open work first — waiting 3s)..."
  sleep 3
  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 2
fi

# Download
echo "Downloading from GitHub..."
if ! curl -L --fail --progress-bar -o "$DMG_PATH" "$DMG_URL"; then
  echo ""
  echo "Error: Download failed. Possible causes:"
  echo "  - No internet connection"
  echo "  - GitHub is blocked (VPN/firewall)"
  echo "  - Release v$VERSION doesn't exist"
  echo ""
  echo "Try opening this URL in your browser:"
  echo "  $DMG_URL"
  exit 1
fi

# Mount
echo "Mounting disk image..."
MOUNT_POINT=$(hdiutil attach "$DMG_PATH" -nobrowse -noautoopen 2>/dev/null | awk -F'\t' '/\/Volumes\//{print $NF}')

if [ -z "$MOUNT_POINT" ] || [ ! -d "$MOUNT_POINT" ]; then
  echo "Error: Failed to mount DMG. The download may be corrupted."
  echo "Try running this command again."
  exit 1
fi

# Backup old version before removing
if [ -d "$INSTALL_DIR/$APP_NAME.app" ]; then
  echo "Backing up old version..."
  mv "$INSTALL_DIR/$APP_NAME.app" "$INSTALL_DIR/$APP_NAME.app.bak"
fi

# Copy new version
echo "Installing..."
if ! cp -R "$MOUNT_POINT/$APP_NAME.app" "$INSTALL_DIR/"; then
  echo "Error: Failed to copy app."
  # Restore backup if copy failed
  if [ -d "$INSTALL_DIR/$APP_NAME.app.bak" ]; then
    echo "Restoring previous version..."
    mv "$INSTALL_DIR/$APP_NAME.app.bak" "$INSTALL_DIR/$APP_NAME.app"
  fi
  exit 1
fi

# Remove backup after successful copy
rm -rf "$INSTALL_DIR/$APP_NAME.app.bak"

# Clear quarantine
xattr -cr "$INSTALL_DIR/$APP_NAME.app" 2>/dev/null || true

echo ""
echo "DocGen v$VERSION installed successfully."
echo "Location: $INSTALL_DIR/$APP_NAME.app"
echo "Launching..."
open "$INSTALL_DIR/$APP_NAME.app"
