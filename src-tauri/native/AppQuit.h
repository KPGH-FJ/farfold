#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef uint64_t (*FFAppQuitOwner)(void);
typedef void (*FFAppQuitRequest)(void);
// Main-thread registration, after AppKit installs its default launch handlers.
bool ff_app_quit_initialize(FFAppQuitOwner owner, FFAppQuitRequest request);
// Only a matching, verified save/cancel owner may resume suspended requests.
void ff_app_quit_complete(uint64_t owner, bool saved);
