#include <stdbool.h>
#include <stdint.h>

typedef bool (*FFBrowserPolicy)(void *context, const char *url);
typedef uint64_t (*FFBrowserStatus)(void *context, int event, uint64_t navigation, const char *url);
typedef void (*FFBrowserRelease)(void *context);
typedef void (*FFBrowserRead)(void *context, const char *json, const char *error);

// All entry points run on the main thread. IDs address only this module's
// registry; no raw view, IPC object, eval function or port is returned to JS.
bool ff_browser_create(uint64_t id, void *parent_wk_view, double x, double y,
                       double width, double height, void *context,
                       FFBrowserPolicy policy, FFBrowserStatus status,
                       FFBrowserRelease release);
bool ff_browser_navigate(uint64_t id, uint64_t navigation, const char *url);
bool ff_browser_resize(uint64_t id, double x, double y, double width, double height);
bool ff_browser_read(uint64_t id, void *context, FFBrowserRead callback);
bool ff_browser_close(uint64_t id);

