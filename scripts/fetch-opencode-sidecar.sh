#!/usr/bin/env bash
set -euo pipefail

OPENCODE_VERSION="1.15.13"
OPENCODE_ARCHIVE="opencode-darwin-arm64.zip"
OPENCODE_ARCHIVE_SHA256="be369a38d15a22e83fad34874d1bc7ddead8084e07df292b28d079287d54ab0c"
TARGET_TRIPLE="$(rustc --print host-tuple)"

if [[ "${TARGET_TRIPLE}" != "aarch64-apple-darwin" ]]; then
  echo "OpenCode D3 supports Apple Silicon macOS only; found ${TARGET_TRIPLE}." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/src-tauri/resources/opencode-runtime"
DESTINATION="${RUNTIME_DIR}/opencode"
VERSION_MARKER="${RUNTIME_DIR}/.version"

if [[ -x "${DESTINATION}" ]] && [[ -f "${VERSION_MARKER}" ]]; then
  read -r MARKER_VERSION MARKER_ARCHIVE_SHA256 MARKER_BINARY_SHA256 < "${VERSION_MARKER}"
  ACTUAL_BINARY_SHA256="$(shasum -a 256 "${DESTINATION}" | awk '{print $1}')"
  if [[ "${MARKER_VERSION}" == "${OPENCODE_VERSION}" ]] \
    && [[ "${MARKER_ARCHIVE_SHA256}" == "${OPENCODE_ARCHIVE_SHA256}" ]] \
    && [[ "${MARKER_BINARY_SHA256}" == "${ACTUAL_BINARY_SHA256}" ]]; then
    exit 0
  fi
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

curl --fail --location --silent --show-error \
  "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${OPENCODE_ARCHIVE}" \
  --output "${TEMP_DIR}/${OPENCODE_ARCHIVE}"

ACTUAL_ARCHIVE_SHA256="$(shasum -a 256 "${TEMP_DIR}/${OPENCODE_ARCHIVE}" | awk '{print $1}')"
if [[ "${ACTUAL_ARCHIVE_SHA256}" != "${OPENCODE_ARCHIVE_SHA256}" ]]; then
  echo "OpenCode checksum mismatch: expected ${OPENCODE_ARCHIVE_SHA256}, found ${ACTUAL_ARCHIVE_SHA256}." >&2
  exit 1
fi

mkdir -p "${TEMP_DIR}/unpacked"
unzip -q "${TEMP_DIR}/${OPENCODE_ARCHIVE}" -d "${TEMP_DIR}/unpacked"
OPENCODE_SOURCE="$(find "${TEMP_DIR}/unpacked" -type f -name opencode -print -quit)"
if [[ -z "${OPENCODE_SOURCE}" ]]; then
  echo "The OpenCode archive did not contain the expected executable." >&2
  exit 1
fi

mkdir -p "${RUNTIME_DIR}"
rm -f "${DESTINATION}" "${VERSION_MARKER}"
install -m 0755 "${OPENCODE_SOURCE}" "${DESTINATION}"
FOUND_VERSION="$("${DESTINATION}" --version | tr -d '[:space:]')"
if [[ "${FOUND_VERSION}" != "${OPENCODE_VERSION}" ]]; then
  echo "OpenCode version mismatch: expected ${OPENCODE_VERSION}, found ${FOUND_VERSION}." >&2
  exit 1
fi

BINARY_SHA256="$(shasum -a 256 "${DESTINATION}" | awk '{print $1}')"
printf '%s %s %s\n' "${OPENCODE_VERSION}" "${OPENCODE_ARCHIVE_SHA256}" "${BINARY_SHA256}" > "${VERSION_MARKER}"
echo "Prepared OpenCode ${OPENCODE_VERSION} for ${TARGET_TRIPLE}."
