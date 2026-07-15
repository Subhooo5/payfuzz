#!/usr/bin/env bash
# Drives the payfuzz demo recorded by demo.tape: boot the naive victim, run
# payfuzz against it (red, ₹5,000 phantom money), then the hardened victim
# (green, ₹0). Runs fully offline — payfuzz signs its own deliveries.
set -euo pipefail
cd "$(dirname "$0")/.."

export PAYFUZZ_WHSEC="${PAYFUZZ_WHSEC:-whsec_demo_offline_value}"
unset NO_COLOR   # the demo wants colour

[ -f dist/cli.js ] || npm run build >/dev/null 2>&1

run_against() {
  local victim="$1" port="$2"
  npx tsx "victims/$victim/index.ts" >/dev/null 2>&1 &
  local pid=$!
  until curl -sf "http://localhost:$port/__payfuzz/state" >/dev/null 2>&1; do sleep 0.2; done
  node dist/cli.js run --target "http://localhost:$port" || true
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

printf '\n\033[1m# the naive handler — the way everyone writes it\033[0m\n'
run_against naive 4242

printf '\n\033[1m# the hardened handler — same app, correct\033[0m\n'
run_against hardened 4343
printf '\n'
