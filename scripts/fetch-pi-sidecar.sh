#!/usr/bin/env bash
set -euo pipefail

PI_VERSION="0.84.3"
PI_ARCHIVE="pi-darwin-arm64.tar.gz"
PI_SHA256="0120c9f99ea05fe801e6e7c2c9d91dd65636563ca0803711b37b9f32920d4b63"
TARGET_TRIPLE="$(rustc --print host-tuple)"

if [[ "${TARGET_TRIPLE}" != "aarch64-apple-darwin" ]]; then
  echo "Gate 0 supports Apple Silicon macOS only; found ${TARGET_TRIPLE}." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINATION="${ROOT_DIR}/src-tauri/binaries/pi-${TARGET_TRIPLE}"
RUNTIME_DIR="${ROOT_DIR}/src-tauri/resources/pi-runtime"
VERSION_MARKER="${RUNTIME_DIR}/.version"
EXPECTED_MARKER="${PI_VERSION} ${PI_SHA256}"

if [[ -x "${DESTINATION}" ]] && [[ -x "${RUNTIME_DIR}/pi" ]] && [[ -f "${VERSION_MARKER}" ]] && [[ "$(<"${VERSION_MARKER}")" == "${EXPECTED_MARKER}" ]]; then
  exit 0
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

curl --fail --location --silent --show-error \
  "https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/${PI_ARCHIVE}" \
  --output "${TEMP_DIR}/${PI_ARCHIVE}"

ACTUAL_SHA256="$(shasum -a 256 "${TEMP_DIR}/${PI_ARCHIVE}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${PI_SHA256}" ]]; then
  echo "Pi checksum mismatch: expected ${PI_SHA256}, found ${ACTUAL_SHA256}." >&2
  exit 1
fi

tar -xzf "${TEMP_DIR}/${PI_ARCHIVE}" -C "${TEMP_DIR}"
PI_RUNTIME_SOURCE="${TEMP_DIR}/pi"
if [[ ! -x "${PI_RUNTIME_SOURCE}/pi" ]] || [[ ! -f "${PI_RUNTIME_SOURCE}/theme/dark.json" ]]; then
  echo "The Pi archive did not contain the expected runtime layout." >&2
  exit 1
fi

rm -rf "${RUNTIME_DIR}"
mkdir -p "${RUNTIME_DIR}"
cp -R "${PI_RUNTIME_SOURCE}/." "${RUNTIME_DIR}/"
install -m 0755 "${ROOT_DIR}/scripts/pi-sidecar-wrapper.sh" "${DESTINATION}"
printf '%s\n' "${EXPECTED_MARKER}" > "${VERSION_MARKER}"
"${RUNTIME_DIR}/pi" --help >/dev/null
echo "Prepared Pi ${PI_VERSION} for ${TARGET_TRIPLE}."
