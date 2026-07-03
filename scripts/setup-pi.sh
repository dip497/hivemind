#!/usr/bin/env bash
# Verify + explain hivemind's pi (pi.dev) integration.
#
# hivemind drives pi as a first-class worker: it auto-writes a lifecycle-bridge
# extension into its userData dir and injects `pi -e <ext>` + HCP env into every
# pi spawn, so pi tiles report turn/status/reply through hive — no manual install.
# This script just checks pi is on PATH and reports the bridge extension status.
set -euo pipefail

echo "== hivemind ⇄ pi integration =="
echo

# 1. Is pi installed?
if ! command -v pi >/dev/null 2>&1; then
  echo "✗ pi not found on PATH."
  echo "  Install pi first — see https://pi.dev — then re-run this script."
  exit 0
fi
echo "✓ pi found: $(command -v pi)"
echo "  version: $(pi --version 2>/dev/null || echo 'unknown')"
echo

# 2. Explain: no manual install needed.
echo "hivemind integration is automatic:"
echo "  • On launch / first pi spawn, the app writes a pi lifecycle-bridge"
echo "    extension to its userData dir (~/.config/hivemind/hive-pi-ext.mjs)."
echo "  • Every pi tile is spawned with '-e <that ext>' plus HCP env"
echo "    (HIVE_HCP_SOCK / HCP_TOKEN / HIVEMIND_TILE), so it reports"
echo "    turn-completion, status, and its reply to hive."
echo "  • No manual extension install is required."
echo

# 3. Is the bridge extension already present?
ext="${HOME}/.config/hivemind/hive-pi-ext.mjs"
if [[ -f "$ext" ]]; then
  echo "✓ pi bridge extension present: $ext"
else
  echo "• pi bridge extension not written yet — it lands on the next app launch"
  echo "  or first pi spawn (expected at: $ext)."
fi

exit 0
