#!/usr/bin/env bash
# Keep a live round on the arena for days at a time.
#
# `run-round.ts` runs one round end to end: create, register, go live, settle,
# commit back to L1. This wraps it in a loop so the site always has something
# live to show, and so one bad round costs one round rather than the demo.
#
# Ticking itself costs no L1 SOL — the Native Crank runs inside the rollup — so
# the spend is per round, not per tick. Long rounds are therefore both cheaper
# and less exposed to a devnet hiccup than many short ones.
#
#   scripts/keep-live.sh                  # 12-hour rounds, forever
#   HOURS=24 scripts/keep-live.sh         # 24-hour rounds
#   MAX_ROUNDS=14 scripts/keep-live.sh    # stop after 14 rounds
#
# Logs to .mb/keep-live.log. Stop it with: systemctl --user stop blackbox-rounds
# (or Ctrl-C when run in a terminal).
set -uo pipefail
cd "$(dirname "$0")/.."

HOURS="${HOURS:-12}"
TICK_MS="${TICK_MS:-500}"
GAP_SECS="${GAP_SECS:-60}"        # breathing room between rounds
MAX_ROUNDS="${MAX_ROUNDS:-0}"     # 0 = no limit
MIN_SOL="${MIN_SOL:-0.5}"         # refuse to start a round below this
LOG=".mb/keep-live.log"

mkdir -p .mb
DURATION_TICKS=$(python3 -c "print(int($HOURS * 3600 * 1000 / $TICK_MS))")
export DURATION_TICKS TICK_MS
export CLUSTER="${CLUSTER:-devnet}"

say() { echo "$(date -Is) $*" | tee -a "$LOG"; }

say "keep-live starting: ${HOURS}h rounds (${DURATION_TICKS} ticks x ${TICK_MS} ms) on ${CLUSTER}"

n=0
while :; do
  if [ "$MAX_ROUNDS" -gt 0 ] && [ "$n" -ge "$MAX_ROUNDS" ]; then
    say "reached MAX_ROUNDS=${MAX_ROUNDS}, stopping"
    break
  fi

  bal=$(solana balance -k ~/.config/solana/id.json -u "$CLUSTER" 2>/dev/null | awk '{print $1}')
  if [ -z "$bal" ]; then
    say "could not read the admin balance; retrying in ${GAP_SECS}s"
    sleep "$GAP_SECS"
    continue
  fi
  if python3 -c "import sys; sys.exit(0 if float('$bal') < float('$MIN_SOL') else 1)"; then
    say "admin holds ${bal} SOL, below MIN_SOL=${MIN_SOL} — not starting a round. Top up and it will pick up on its own."
    sleep 300
    continue
  fi

  # A round already running — because the machine came back, or the supervisor
  # was restarted mid-round — is re-attached and settled rather than abandoned.
  # Creating a competing round here would leave the old one ticking with nobody
  # to close it.
  resume=""
  if [ -f ".mb/round-${CLUSTER}.json" ]; then
    phase=$(python3 -c "import json;print(json.load(open('.mb/round-${CLUSTER}.json')).get('phase',''))" 2>/dev/null || echo "")
    case "$phase" in
      live|settling|delegating|registration) resume=1 ;;
    esac
  fi

  n=$((n + 1))
  if [ -n "$resume" ]; then
    say "round ${n}: re-attaching to the round already in progress (phase ${phase})"
  else
    say "round ${n}: starting (admin holds ${bal} SOL)"
  fi

  if RESUME="$resume" pnpm exec ts-node --transpile-only scripts/run-round.ts >> "$LOG" 2>&1; then
    say "round ${n}: settled"
  else
    code=$?
    say "round ${n}: run-round exited ${code} — see ${LOG}; a stranded round can also be closed from /arena"
  fi
  sleep "$GAP_SECS"
done
