#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "Witness.h"

// Retain only the observed browser so removal can be checked after the owner
// releases it. This fixture has no access to the browser's registry or methods.
static WKWebView *observedView;

bool witness_capture(void *parent_wk_view) {
    if (!NSThread.isMainThread) return false;
    observedView = nil;
    if (!parent_wk_view) return false;
    WKWebView *parent = (__bridge WKWebView *)parent_wk_view;
    if (![parent isKindOfClass:WKWebView.class] || !parent.superview) return false;
    WKWebView *candidate = nil;
    NSUInteger count = 0;
    for (NSView *view in parent.superview.subviews) {
        if (view != parent && [view isKindOfClass:WKWebView.class]) {
            candidate = (WKWebView *)view;
            count++;
        }
    }
    if (count != 1) return false;
    observedView = candidate;
    return true;
}

bool witness_attached(void) {
    return NSThread.isMainThread && observedView && observedView.superview != nil;
}

bool witness_ephemeral(void) {
    return NSThread.isMainThread && observedView &&
        !observedView.configuration.websiteDataStore.persistent;
}

bool witness_has_no_user_scripts(void) {
    return NSThread.isMainThread && observedView &&
        observedView.configuration.userContentController.userScripts.count == 0;
}

void witness_release(void) {
    if (!NSThread.isMainThread) return;
    observedView = nil;
}
