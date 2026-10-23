#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef bool (*FFBrowserPolicy)(void *context, const char *url);
typedef uint64_t (*FFBrowserStatus)(void *context, int event, uint64_t navigation, const char *url);
typedef void (*FFBrowserRelease)(void *context);
typedef void (*FFBrowserRead)(void *context, const char *json, const char *error);
typedef void (*FFBrowserResource)(void *context, uint64_t request_id, const char *url);

// All entry points run on the main thread. IDs address only this module's
// registry; no raw view, IPC object, eval function or port is returned to JS.
bool ff_browser_create(uint64_t id, void *parent_wk_view, double x, double y,
                       double width, double height, void *context,
                       FFBrowserPolicy policy, FFBrowserStatus status,
                       FFBrowserRelease release);
// Offline HTML only. The caller supplies a stable, opaque project/file UUID.
// macOS 14+ persists in that dedicated store; older systems remain temporary.
bool ff_browser_create_html(uint64_t id, void *parent_wk_view, double x, double y,
                       double width, double height, void *context,
                       FFBrowserPolicy policy, FFBrowserStatus status,
                       FFBrowserRelease release, const char *storage_identifier);
// resource is non-NULL only for an exact ff-preview:// source. NULL selects an
// explicit loopback development origin and always uses a fresh temporary store.
// Neither mode grants an application bridge.
bool ff_browser_create_preview(uint64_t id, void *parent_wk_view, double x, double y,
                       double width, double height, void *context,
                       FFBrowserPolicy policy, FFBrowserStatus status,
                       FFBrowserRelease release, const char *storage_identifier,
                       const char *origin, FFBrowserResource resource);
bool ff_browser_navigate_preview(uint64_t id, uint64_t navigation, const char *url);
// Final resource delivery must occur under the source's live lease. A cancelled
// request ID is ignored. NULL mime denotes a bounded, non-path-revealing failure.
bool ff_browser_resource_finish(uint64_t id, uint64_t request_id, const uint8_t *bytes,
                               uintptr_t length, const char *mime, const char *headers_json);
bool ff_browser_persistent_html_supported(void);
// Read-only prerequisite probe on the main thread: no page, observation or
// capture is started. True never replaces the per-page capture guards.
bool ff_browser_screenshot_supported(void);
// Requires every view for this exact store to be closed; callback acknowledges
// clearing its page data. Reopening is blocked until completion, including after
// a caller timeout. Never enumerate or clear other stores.
bool ff_browser_clear_html_storage(const char *storage_identifier, void *context, FFBrowserRead callback);
bool ff_browser_navigate(uint64_t id, uint64_t navigation, const char *url);
// A self-contained, verified document with a generated isolated HTTPS origin.
// Loads bytes only; never passes a file URL or read-access directory to WebKit.
bool ff_browser_load_html(uint64_t id, uint64_t navigation, const char *html, const char *base_url);
bool ff_browser_resize(uint64_t id, double x, double y, double width, double height);
// Presentation only. Hide preserves the page; showing requires fresh valid bounds.
// A failed show leaves the view hidden. True acknowledges the actual NSView state.
bool ff_browser_set_visible(uint64_t id, bool visible, double x, double y, double width, double height);
// 0: unavailable, 1: started (callback owns context), 2: expected URL changed.
// expected_url is NULL for the manual preview; a shared read requires its exact URL.
// operation_id is nonzero and never reused by the caller in this process.
int32_t ff_browser_read(uint64_t id, uint64_t operation_id, const char *expected_url, void *context, FFBrowserRead callback);
// Fixed observation/action programs only. Navigation, URL and one-use node refs
// are checked again inside WebKit; no caller-supplied script is accepted.
int32_t ff_browser_observe(uint64_t id, uint64_t operation_id, uint64_t navigation, const char *expected_url,
                          bool screenshot, void *context, FFBrowserRead callback);
// kind 1 = click, 2 = replace ordinary text field. No submit/key/script API.
int32_t ff_browser_act(uint64_t id, uint64_t operation_id, uint64_t navigation, const char *expected_url,
                      const char *observation_id, const char *node_ref, int32_t kind,
                      const char *input_text, void *context, FFBrowserRead callback);
// Retires only the exact request's receiver, with one error callback. True is
// NOT proof that WebKit execution stopped or that a dispatched action had no
// effect. Keep the execution slot until its actual completion or view close;
// subsequent operations remain busy. Zero/unknown tokens never affect a request.
bool ff_browser_cancel_operation(uint64_t id, uint64_t operation_id);
bool ff_browser_close(uint64_t id);
// Shutdown only: permanently rejects new create/navigate/resize/read operations
// in this process and closes this module's owners. Call on the main thread.
// True acknowledges detached views, cancelled reads and released owner contexts.
// A reentrant call while any close callbacks are executing returns false.
bool ff_browser_close_all(void);
