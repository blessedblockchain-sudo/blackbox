#!/usr/bin/env bash
# Local MagicBlock stack for BLACKBOX development.
#
#   base L1        mb-test-validator            host   :8899/:8900
#   ephemeral ER   ephemeral-validator (docker) host   :7799/:7800   (needs RLIMIT_NOFILE 1e6)
#   TEE emulation  query-filtering-service      host   :6699/:6700
#   VRF oracle     vrf-oracle (base + ER)       host
#
# Usage: scripts/local-stack.sh up|down|status|logs
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
MB="$ROOT/.mb"
mkdir -p "$MB"
PKG="$(npm root -g)/@magicblock-labs/ephemeral-validator/node_modules/@magicblock-labs"
ER_BIN_DIR="$PKG/ephemeral-validator-linux-x64/bin"
QFS_BIN="$PKG/query-filtering-service-linux-x64/bin/query-filtering-service"
VRF_BIN="$PKG/vrf-oracle-linux-x64/bin/vrf-oracle"

rpc_ok() { curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "http://127.0.0.1:$1" | grep -q '"ok"'; }
wait_rpc() { for _ in $(seq 1 60); do rpc_ok "$1" && return 0; sleep 1; done; echo "port $1 not healthy" >&2; return 1; }

up() {
  down >/dev/null 2>&1 || true
  echo "[base] starting mb-test-validator"
  local extra=()
  # MagicBlock committor program (needed to commit large accounts via buffers); dumped from devnet once.
  [ -f "$MB/programs/committor.so" ] || solana program dump ComtrB2KEaWgXsW1dhr1xYL4Ht4Bjj3gXnnL6KMdABq "$MB/programs/committor.so" -u devnet >/dev/null
  extra+=(--bpf-program ComtrB2KEaWgXsW1dhr1xYL4Ht4Bjj3gXnnL6KMdABq "$MB/programs/committor.so")
  # BLACKBOX local-oracle build, preloaded so no deploy is needed after a reset.
  if [ -f "$ROOT/target/deploy/blackbox-local.so" ]; then
    extra+=(--upgradeable-program BXAbfrYjTM7WQ7K6Rrj1epcQwd6jT3TTXs3yqTp1dx27 "$ROOT/target/deploy/blackbox-local.so" "$(solana address)")
  fi
  (cd "$MB" && nohup mb-test-validator --reset --rpc-port 8899 "${extra[@]}" "$@" > "$MB/base.log" 2>&1 < /dev/null &)
  wait_rpc 8899
  echo "[er] starting ephemeral-validator in docker"
  docker run -d --name mb-er --network host \
    --ulimit nofile=1048576:1048576 \
    -e RUST_LOG=${ER_LOG:-warn} \
    -v "$ER_BIN_DIR":/mb:ro \
    ubuntu:24.04 /mb/ephemeral-validator --no-tui \
      --listen 127.0.0.1:7799 \
      --remotes http://127.0.0.1:8899 --remotes ws://127.0.0.1:8900 \
      --lifecycle ephemeral --reset --storage /storage >/dev/null
  wait_rpc 7799
  echo "[qfs] starting query-filtering-service"
  (nohup env RUST_LOG=info "$QFS_BIN" --listen-addr 127.0.0.1:6699 --listen-addr-ws 127.0.0.1:6700 \
     --ephemeral-url http://127.0.0.1:7799 --ephemeral-url-ws ws://127.0.0.1:7800 \
     --token-expiry-days 180 --add-cors-headers > "$MB/qfs.log" 2>&1 < /dev/null &)
  sleep 2
  echo "[vrf] starting vrf-oracle (base + ER)"
  (nohup env VRF_ORACLE_SKIP_PREFLIGHT=true RPC_URL=http://127.0.0.1:8899 WEBSOCKET_URL=ws://127.0.0.1:8900 RUST_LOG=info "$VRF_BIN" > "$MB/vrf-base.log" 2>&1 < /dev/null &)
  (nohup env VRF_ORACLE_SKIP_PREFLIGHT=true RPC_URL=http://127.0.0.1:7799 WEBSOCKET_URL=ws://127.0.0.1:7800 RUST_LOG=info "$VRF_BIN" > "$MB/vrf-er.log" 2>&1 < /dev/null &)
  status
}

down() {
  docker rm -f mb-er >/dev/null 2>&1 || true
  pkill -f query-filtering-service || true
  pkill -f vrf-oracle || true
  pkill -f mb-test-validator || true
  pkill -f solana-test-validator || true
  sleep 1
}

status() {
  for p in 8899 7799 6699; do printf "port %s: " "$p"; rpc_ok "$p" && echo ok || echo DOWN; done
  docker ps --filter name=mb-er --format '  er container: {{.Status}}'
  pgrep -af vrf-oracle | sed 's/^/  /' | cut -c1-80 || true
}

logs() { docker logs --tail 50 mb-er; tail -20 "$MB/qfs.log"; }

cmd=${1:-status}; shift || true
case "$cmd" in up) up "$@";; down) down;; status) status;; logs) logs;; *) echo "usage: $0 up|down|status|logs"; exit 1;; esac
