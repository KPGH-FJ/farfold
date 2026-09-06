#!/usr/bin/env bash
set -euo pipefail

PI_VERSION="0.84.3"
NODE_VERSION="22.22.3"
NODE_ARCHIVE="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_SHA256="0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207"
TARGET_TRIPLE="$(rustc --print host-tuple)"

if [[ "${TARGET_TRIPLE}" != "aarch64-apple-darwin" ]]; then
  echo "Gate 0 supports Apple Silicon macOS only; found ${TARGET_TRIPLE}." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_DIR="${ROOT_DIR}/src-tauri/capability-bridge"
RUNTIME_DIR="${BRIDGE_DIR}/runtime"
NODE_PATH="${RUNTIME_DIR}/node"
DEPLOY_DIR="${ROOT_DIR}/src-tauri/resources/pi-capabilities"
PI_MARKER="${ROOT_DIR}/src-tauri/resources/pi-runtime/.version"

if [[ ! -f "${PI_MARKER}" ]] || [[ "$(<"${PI_MARKER}")" != "${PI_VERSION} "* ]]; then
  echo "Prepare the pinned Pi ${PI_VERSION} sidecar before the capability bridge." >&2
  exit 1
fi

corepack pnpm --dir "${BRIDGE_DIR}" install --frozen-lockfile --prod

RESOLVED_SDK_VERSION="$(cd "${BRIDGE_DIR}" && node -e 'import("@earendil-works/pi-coding-agent").then(async()=>{const u=new URL("../package.json",import.meta.resolve("@earendil-works/pi-coding-agent"));process.stdout.write(JSON.parse(await (await import("node:fs/promises")).readFile(u,"utf8")).version)})')"
if [[ "${RESOLVED_SDK_VERSION}" != "${PI_VERSION}" ]]; then
  echo "Pi SDK mismatch: expected ${PI_VERSION}, found ${RESOLVED_SDK_VERSION}." >&2
  exit 1
fi

if rg -q '@earendil-works\+[^@]+@(?!0\.84\.3)' "${BRIDGE_DIR}/pnpm-lock.yaml" --pcre2; then
  echo "A transitive Pi SDK package drifted away from ${PI_VERSION}." >&2
  exit 1
fi

if [[ ! -x "${NODE_PATH}" ]]; then
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TEMP_DIR}"' EXIT
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
    --output "${TEMP_DIR}/${NODE_ARCHIVE}"
  ACTUAL_SHA256="$(shasum -a 256 "${TEMP_DIR}/${NODE_ARCHIVE}" | awk '{print $1}')"
  if [[ "${ACTUAL_SHA256}" != "${NODE_SHA256}" ]]; then
    echo "Node checksum mismatch: expected ${NODE_SHA256}, found ${ACTUAL_SHA256}." >&2
    exit 1
  fi
  tar -xzf "${TEMP_DIR}/${NODE_ARCHIVE}" -C "${TEMP_DIR}"
  mkdir -p "${RUNTIME_DIR}"
  install -m 0755 "${TEMP_DIR}/node-v${NODE_VERSION}-darwin-arm64/bin/node" "${NODE_PATH}"
fi

mkdir -p "${DEPLOY_DIR}"
install -m 0644 "${BRIDGE_DIR}/package.json" "${DEPLOY_DIR}/package.json"
install -m 0644 "${BRIDGE_DIR}/pnpm-lock.yaml" "${DEPLOY_DIR}/pnpm-lock.yaml"
install -m 0644 "${BRIDGE_DIR}/bridge.mjs" "${DEPLOY_DIR}/bridge.mjs"
corepack pnpm --dir "${DEPLOY_DIR}" install --frozen-lockfile --prod --config.node-linker=hoisted
mkdir -p "${DEPLOY_DIR}/runtime"
install -m 0755 "${NODE_PATH}" "${DEPLOY_DIR}/runtime/node"
bash "${ROOT_DIR}/scripts/pi-capability-wrapper.sh" </dev/null >/dev/null
echo "Prepared Pi capability bridge ${PI_VERSION} with Node ${NODE_VERSION}."
