#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -x "${SCRIPT_DIR}/../resources/pi-runtime/pi" ]]; then
  PI_RUNTIME="${SCRIPT_DIR}/../resources/pi-runtime/pi"
elif [[ -x "${SCRIPT_DIR}/../Resources/pi-runtime/pi" ]]; then
  PI_RUNTIME="${SCRIPT_DIR}/../Resources/pi-runtime/pi"
else
  echo "Farfold cannot locate its bundled Pi runtime." >&2
  exit 1
fi

exec "${PI_RUNTIME}" "$@"
