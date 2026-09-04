#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -x "${SCRIPT_DIR}/../pi-capability-runtime/runtime/node" ]]; then
  BRIDGE_DIR="${SCRIPT_DIR}/../pi-capability-runtime"
elif [[ -x "${SCRIPT_DIR}/../src-tauri/resources/pi-capabilities/runtime/node" ]]; then
  BRIDGE_DIR="${SCRIPT_DIR}/../src-tauri/resources/pi-capabilities"
else
  echo "Farfold cannot locate its bundled Pi capability bridge." >&2
  exit 1
fi

exec "${BRIDGE_DIR}/runtime/node" "${BRIDGE_DIR}/bridge.mjs" "$@"
