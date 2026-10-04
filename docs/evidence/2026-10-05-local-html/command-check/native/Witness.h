#pragma once

#include <stdbool.h>

// Standalone validation witness only; never include in the product build.
// Main thread only. parent must be the genuine main WK pointer obtained from
// this harness's own Tauri with_webview callback. No pointer is returned.
// Capture clears the previous observation, then retains exactly one sibling.
bool witness_capture(void *parent_wk_view);
bool witness_attached(void);
bool witness_ephemeral(void);
// Only checks the script count; does not inspect script source or imply that
// no message handlers / other IPC surfaces exist.
bool witness_has_no_user_scripts(void);
void witness_release(void);
