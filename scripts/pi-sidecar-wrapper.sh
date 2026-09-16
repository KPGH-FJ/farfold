#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${FARFOLD_PI_RUNTIME_BINARY:-}" && -x "${FARFOLD_PI_RUNTIME_BINARY}" ]]; then
  PI_RUNTIME="${FARFOLD_PI_RUNTIME_BINARY}"
elif [[ -x "${SCRIPT_DIR}/../pi-runtime/pi" ]]; then
  PI_RUNTIME="${SCRIPT_DIR}/../pi-runtime/pi"
elif [[ -x "${SCRIPT_DIR}/../src-tauri/resources/pi-runtime/pi" ]]; then
  PI_RUNTIME="${SCRIPT_DIR}/../src-tauri/resources/pi-runtime/pi"
else
  echo "Farfold cannot locate its bundled Pi runtime." >&2
  exit 1
fi

exec "${PI_RUNTIME}" "$@"
