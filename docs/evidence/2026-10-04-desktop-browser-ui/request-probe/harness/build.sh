#!/bin/sh
set -eu
cd /Users/tw/Documents/Codex/2026-10-03/task-3/backend-share-wait-20261004/probe
python3 -B manifest.py before
xcrun clang -fobjc-arc -arch arm64 -mmacosx-version-min=11.0 -Wall -Wextra -Werror -Wno-unused-parameter -c /Users/tw/Desktop/farfold/src-tauri/native/BrowserWorkspace.m -o native/BrowserWorkspace.o
xcrun clang -fobjc-arc -arch arm64 -mmacosx-version-min=11.0 -Wall -Wextra -Werror -Wno-unused-parameter -c native/Witness.m -o native/Witness.o
xcrun ar rcs native/libsharing_native.a native/BrowserWorkspace.o native/Witness.o
CARGO_PKG_NAME=sharing-probe rustc --edition=2024 -D warnings probe.rs \
 -L dependency=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps \
 -L native=native -l static=sharing_native -l framework=AppKit -l framework=WebKit \
 --extern tauri=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libtauri-d531b6af9c1a1abc.rlib \
 --extern serde=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libserde-fdec50919a33418e.rlib \
 --extern serde_json=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libserde_json-5705a60d2ac33a2e.rlib \
 --extern tokio=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libtokio-05b121993fce641c.rlib \
 --extern libc=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/liblibc-749532ac7a5311b5.rlib \
 --extern agent_client_protocol=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libagent_client_protocol-0790fe4967dfd623.rlib \
 --extern tempfile=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libtempfile-7032167c1ffeaae9.rlib \
 -o sharing-probe
python3 -B manifest.py after
