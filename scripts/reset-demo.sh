#!/usr/bin/env bash
# Resets demo personas to their freshly seeded state (accounts, goals, mandates, conversations) in the running stack.
# Usage: ./scripts/reset-demo.sh [personas]   (comma-separated keys, default andrei; keys: andrei, maria, ion, elena)
# Run before every demo or rehearsal. Their demo API keys are recreated with the same values.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T -e SEED_RESET="${1:-andrei}" api node dist/seed/seed.js | grep -E '^seed:|reset|failed' || true
