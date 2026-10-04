#!/bin/sh
set -eu
cd /Users/tw/Documents/Codex/2026-10-03/task-3/browser-seam-validation
xcrun clang -fobjc-arc -mmacosx-version-min=11.0 -Wall -Wextra -Werror -Wno-unused-parameter -c native/SeamProbe.m -o native/SeamProbe.o
xcrun ar rcs native/libseam_native.a native/SeamProbe.o
CARGO_PKG_NAME=seam-probe rustc --edition=2024 probe.rs \
  -L dependency=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps \
  -L native=native -l static=seam_native -l framework=AppKit -l framework=WebKit \
  --extern tauri=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libtauri-d531b6af9c1a1abc.rlib \
  --extern serde=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libserde-fdec50919a33418e.rlib \
  --extern serde_json=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libserde_json-5705a60d2ac33a2e.rlib \
  -o seam-probe
