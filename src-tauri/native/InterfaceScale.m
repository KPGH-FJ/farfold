#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <math.h>

double ff_interface_scale_apply(void *pointer, double factor) {
    if (!pointer || ![NSThread isMainThread] ||
        !(factor == 1.0 || factor == 1.1 || factor == 1.25 || factor == 1.5)) return NAN;
    WKWebView *view = (__bridge WKWebView *)pointer;
    if (![view isKindOfClass:[WKWebView class]]) return NAN;
    view.pageZoom = factor;
    return view.pageZoom;
}
