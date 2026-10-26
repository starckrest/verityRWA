#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SAMPLES="$ROOT/fabric-dev/fabric-samples"
export PATH="$SAMPLES/bin:$PATH"

cd "$SAMPLES/test-network"
./network.sh up
