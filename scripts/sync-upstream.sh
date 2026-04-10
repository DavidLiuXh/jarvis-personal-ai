#!/bin/bash
# Sync packages/core and packages/cli from upstream gemini-cli
# Usage: ./scripts/sync-upstream.sh

set -e

echo "🔄 Fetching upstream gemini-cli..."
git fetch upstream

UPSTREAM_VERSION=$(git show upstream/main:package.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")
echo "📦 Upstream version: $UPSTREAM_VERSION"

echo "📥 Syncing packages/core and packages/cli..."
git checkout upstream/main -- packages/core packages/cli

CHANGED=$(git status --short | grep -E "^M|^A|^D" | wc -l | tr -d ' ')
if [ "$CHANGED" -eq "0" ]; then
  echo "✅ Already up to date, nothing to commit."
  exit 0
fi

echo "📝 Committing $CHANGED changed files..."
git add packages/core packages/cli
git commit --no-verify -m "chore: sync packages/core and packages/cli from upstream gemini-cli

Upstream version: $UPSTREAM_VERSION
Source: https://github.com/google-gemini/gemini-cli"

echo "📦 Installing dependencies (--ignore-scripts to skip build steps)..."
npm install --ignore-scripts

echo "🚀 Pushing to origin..."
git push

echo "✅ Done! Synced to upstream version: $UPSTREAM_VERSION"
echo ""
echo "ℹ️  Note: npm install was run with --ignore-scripts."
echo "   Jarvis uses tsx at runtime and does not require pre-compilation."
