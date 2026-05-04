#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-local.sh
#
# Build the plugin and copy the output artefacts directly into a local
# Obsidian vault's plugin directory.  Run this during development to test
# changes without publishing a GitHub release.
#
# Usage:
#   ./scripts/deploy-local.sh [/path/to/vault]
#
# If no vault path is given the script reads the OBSIDIAN_VAULT environment
# variable, or falls back to the first vault found under ~/Documents.
#
# Examples:
#   OBSIDIAN_VAULT=~/Documents/MyVault ./scripts/deploy-local.sh
#   ./scripts/deploy-local.sh ~/Documents/MyVault
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PLUGIN_ID=$(node -e "process.stdout.write(require('./manifest.json').id)")

# ── Resolve vault path ────────────────────────────────────────────────────────

VAULT="${1:-${OBSIDIAN_VAULT:-}}"

if [[ -z "$VAULT" ]]; then
  # Auto-detect: first directory under ~/Documents that contains .obsidian/
  VAULT=$(find ~/Documents -maxdepth 2 -name ".obsidian" -type d 2>/dev/null \
            | head -1 | xargs dirname 2>/dev/null || true)
fi

if [[ -z "$VAULT" || ! -d "$VAULT" ]]; then
  echo "❌  Could not find an Obsidian vault."
  echo "    Either pass the vault path as the first argument or set OBSIDIAN_VAULT."
  exit 1
fi

PLUGIN_DIR="$VAULT/.obsidian/plugins/$PLUGIN_ID"

echo "📦  Vault  : $VAULT"
echo "🔌  Plugin : $PLUGIN_ID"
echo "📂  Target : $PLUGIN_DIR"
echo ""

# ── Install dependencies ──────────────────────────────────────────────────────

echo "📥  Installing dependencies…"
npm install --prefer-offline 2>&1 | tail -1
echo ""

# ── Build ─────────────────────────────────────────────────────────────────────

echo "🔨  Building…"
npm run build  # type-checks then produces production bundle
echo ""

# ── Deploy ────────────────────────────────────────────────────────────────────

mkdir -p "$PLUGIN_DIR"

ARTEFACTS=(main.js manifest.json styles.css)

for f in "${ARTEFACTS[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "❌  Missing artefact: $f  (did the build fail?)"
    exit 1
  fi
  cp "$f" "$PLUGIN_DIR/$f"
done

echo "✅  Deployed to $PLUGIN_DIR"
echo ""
echo "   Files copied:"
for f in "${ARTEFACTS[@]}"; do
  SIZE=$(du -h "$PLUGIN_DIR/$f" | cut -f1)
  echo "   · $f  ($SIZE)"
done
echo ""
echo "💡  Reload the plugin in Obsidian:  Settings → Community Plugins → S3 Git Sync → Reload"
echo "    Or use the BRAT plugin to reload all beta plugins."
