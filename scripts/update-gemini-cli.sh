#!/usr/bin/env bash
# Update gemini-cli submodule and re-apply local patches.
#
# Usage:
#   ./scripts/update-gemini-cli.sh          # update to latest remote HEAD
#   ./scripts/update-gemini-cli.sh <sha>    # update to a specific commit
#
# After running this script, commit the updated submodule pointer:
#   git add gemini-cli && git commit -m "chore: update gemini-cli submodule"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBMODULE_DIR="$REPO_ROOT/gemini-cli"
PATCHES_DIR="$REPO_ROOT/patches"

cd "$SUBMODULE_DIR"

echo "==> Fetching gemini-cli updates..."
git fetch origin

if [[ $# -ge 1 ]]; then
  TARGET="$1"
  echo "==> Checking out $TARGET..."
  git checkout "$TARGET"
else
  echo "==> Updating to latest origin/main..."
  git checkout origin/main
fi

UPSTREAM_SHA=$(git rev-parse HEAD)
echo "==> Upstream HEAD: $UPSTREAM_SHA"

# Apply patches in order
PATCHES=("$PATCHES_DIR"/*.patch)
if [[ ${#PATCHES[@]} -eq 0 ]] || [[ ! -f "${PATCHES[0]}" ]]; then
  echo "==> No patches found in $PATCHES_DIR, done."
  exit 0
fi

echo "==> Applying ${#PATCHES[@]} patch(es)..."
for patch in "${PATCHES[@]}"; do
  echo "    Applying: $(basename "$patch")"
  if ! git am --3way "$patch"; then
    echo ""
    echo "ERROR: Patch failed to apply cleanly: $(basename "$patch")"
    echo ""
    echo "To resolve:"
    echo "  cd gemini-cli"
    echo "  # Fix conflicts, then: git add <files> && git am --continue"
    echo "  # Or abort with:       git am --abort"
    echo ""
    echo "After resolving, regenerate patches with:"
    echo "  cd gemini-cli && git format-patch $UPSTREAM_SHA..HEAD --output-directory ../patches/"
    exit 1
  fi
done

echo "==> All patches applied."
echo ""
echo "Verify the result, then commit the submodule pointer:"
echo "  cd $REPO_ROOT"
echo "  git add gemini-cli && git commit -m 'chore: update gemini-cli submodule'"
