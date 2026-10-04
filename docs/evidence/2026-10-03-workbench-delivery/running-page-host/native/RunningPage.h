#pragma once

#include "BrowserWorkspace.h"

// Fixed synthetic fixture only. Not a product API and never exposed to JS.
// All calls and callbacks execute on the main thread. The caller owns context.
// Strings passed to callbacks are borrowed only for the duration of the call.
typedef void (*RunningPageEvent)(void *context, int event, const char *json);
enum {
    RR_EVENT_READY = 1,
    RR_EVENT_MUTATED = 2,
    RR_EVENT_CLOSED = 3,
    RR_EVENT_ERROR = 9
};

// At most one creation attempt per process. No caller-controlled URL, JS or path.
// The actual controlled navigation is about:blank with navigation token 71.
bool rr_create(void *parent_wk_view, void *context, RunningPageEvent callback);
// Mutates the same WK DOM from version one to two, once; true means accepted.
bool rr_mutate(void);
// Forwards directly to ff_browser_read(2801,...). No snapshot cache or wrapping.
// false means rejected and no read callback will be issued for that call.
bool rr_read(void *context, FFBrowserRead callback);
// True is an actual synchronous detach/cancel ACK. Idempotent after creation;
// CLOSED is emitted once. The view cannot be recreated after close or failure.
bool rr_close(void);
uint64_t rr_create_count(void);
uint64_t rr_read_count(void);
bool rr_same_instance(void);
bool rr_is_ephemeral(void);
