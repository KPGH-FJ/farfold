#!/bin/sh
set -eu
cd /Users/tw/Documents/Codex/2026-10-03/task-3/browser-running-page-probe
xcrun clang -fobjc-arc -mmacosx-version-min=11.0 -Wall -Wextra -Werror -Wno-unused-parameter -c native/BrowserWorkspace.m -o native/BrowserWorkspace.o
xcrun clang -fobjc-arc -mmacosx-version-min=11.0 -Wall -Wextra -Werror -Wno-unused-parameter -c native/RunningPage.m -o native/RunningPage.o
xcrun ar rcs native/librunning_native.a native/BrowserWorkspace.o native/RunningPage.o
CARGO_PKG_NAME=running-page-probe rustc --edition=2024 probe.rs \
 -L dependency=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps \
 -L native=native -l static=running_native -l framework=AppKit -l framework=WebKit \
 --extern tauri=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libtauri-d531b6af9c1a1abc.rlib \
 --extern serde=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libserde-fdec50919a33418e.rlib \
 --extern serde_json=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libserde_json-5705a60d2ac33a2e.rlib \
 -o running-page-probe
