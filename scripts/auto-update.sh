#!/usr/bin/env bash
# Convenient wrapper to run dependency & engine update across all workspaces.
# Usage:
#   ./scripts/auto-update.sh            (apply safe in-range updates & tests)
#   ./scripts/auto-update.sh --major    (allow major upgrades where compatible)
#   ./scripts/auto-update.sh --no-test  (skip test run)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "==> Running dependency & engine updater..."
node scripts/update-dependencies.cjs --apply "$@"
