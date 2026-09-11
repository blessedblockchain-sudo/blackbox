#!/usr/bin/env bash
# Build both program variants and refresh the SDK's IDL + types.
#   target/deploy/blackbox-local.so   `local-oracle` feature: also accepts the mock feeds used by the local stack
#   target/deploy/blackbox.so         devnet/mainnet: Pyth Lazer accounts only
set -euo pipefail
cd "$(dirname "$0")/.."
anchor build -p blackbox -- --features local-oracle
cp target/deploy/blackbox.so target/deploy/blackbox-local.so
anchor build -p blackbox
cp target/idl/blackbox.json packages/sdk/src/blackbox.idl.json
cp target/types/blackbox.ts packages/sdk/src/blackbox.types.ts
ls -la target/deploy/blackbox.so target/deploy/blackbox-local.so
