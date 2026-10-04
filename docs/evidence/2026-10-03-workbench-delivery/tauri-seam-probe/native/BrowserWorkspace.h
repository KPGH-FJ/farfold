#include <stdbool.h>
#include <stdint.h>

typedef bool (*FFBrowserPolicy)(void *context, const char *url);
typedef void (*FFBrowserStatus)(void *context, int event, const char *url);
typedef void (*FFBrowserRelease)(void *context);
typedef void (*FFBrowserRead)(void *context, const char *json, const char *error);

// All entry points run on the main thread. IDs address only this module's
// registry; no raw view, IPC object, eval function or port is returned to JS.
bool ff_browser_create(uint64_t id, void *parent_wk_view, double x, double y,
                       double width, double height, void *context,
                       FFBrowserPolicy policy, FFBrowserStatus status,
                       FFBrowserRelease release);
bool ff_browser_navigate(uint64_t id, const char *url);
bool ff_browser_resize(uint64_t id, double x, double y, double width, double height);
bool ff_browser_read(uint64_t id, void *context, FFBrowserRead callback);
void ff_browser_close(uint64_t id);

