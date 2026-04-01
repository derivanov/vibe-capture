#!/bin/bash
set -e

echo ""
echo "  Vibe Capture — Setup"
echo "  ===================="
echo ""

# Check macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "  !! This tool is built for macOS. Other systems are not tested."
  echo ""
fi

# Install Homebrew if missing
if ! command -v brew &>/dev/null; then
  echo "  Installing Homebrew (macOS package manager)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to path for Apple Silicon Macs
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
  echo ""
fi

# Install Node.js if missing
if ! command -v node &>/dev/null; then
  echo "  Installing Node.js..."
  brew install node
  echo ""
else
  echo "  Node.js $(node --version) — OK"
fi

# Install ffmpeg if missing
if ! command -v ffmpeg &>/dev/null; then
  echo "  Installing ffmpeg..."
  brew install ffmpeg
  echo ""
else
  echo "  ffmpeg — OK"
fi

# Install npm dependencies
echo "  Installing dependencies (this downloads Chromium, ~200 MB)..."
npm install
echo ""

echo "  ====================="
echo "  Setup complete!"
echo ""
echo "  To start: npm start"
echo ""
