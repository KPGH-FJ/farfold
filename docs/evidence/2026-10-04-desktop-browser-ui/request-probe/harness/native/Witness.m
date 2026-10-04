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

// Test fixture only: two fixed strings in the one captured, ephemeral example.com page.
// No script, URL, selector or body is accepted from the caller.
void witness_change_body(int version, void *context, void (*callback)(void *, bool)) {
    if (!NSThread.isMainThread || !observedView || !observedView.superview ||
        observedView.configuration.websiteDataStore.persistent ||
        ![observedView.URL.absoluteString isEqualToString:@"https://example.com/"] ||
        (version != 1 && version != 2)) {
        callback(context, false);
        return;
    }
    NSString *script = version == 1
        ? @"document.title='Controlled public fixture';document.body.textContent='FARFOLD_PUBLIC_SHARED_BODY_ONE_20261004';true"
        : @"document.title='Controlled public fixture';document.body.textContent='FARFOLD_PUBLIC_SHARED_BODY_TWO_20261004';true";
    [observedView evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        callback(context, !error && [value boolValue]);
    }];
}

// Scratch-only offline fixture. Production WK creation, navigation attribution,
// DOM observation, grant checks, IPC commands and stdio transport stay intact.
// Replace the network response for exactly one synthetic URL using Apple's
// public WKWebView API; no server, DNS, HTTP request or account is involved.
#import <objc/runtime.h>
static IMP originalLoadRequest;
static unsigned simulatedLoads;
static WKNavigation *fixtureLoad(WKWebView *view, SEL selector, NSURLRequest *request) {
    if ([request.URL.scheme isEqualToString:@"https"] || [request.URL.scheme isEqualToString:@"http"]) {
        if (![request.URL.absoluteString isEqualToString:@"https://example.com/"]) return nil;
        if (@available(macOS 12.0, *)) {
            simulatedLoads++;
            return [view loadSimulatedRequest:request responseHTMLString:@"<!doctype html><meta charset='utf-8'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; connect-src 'none'; img-src 'none'; style-src 'none'; script-src 'none'; frame-src 'none'; form-action 'none'\"><title>Controlled public fixture</title><body>FARFOLD_PUBLIC_SHARED_BODY_ONE_20261004</body>"];
        }
        return nil;
    }
    if ([request.URL.scheme isEqualToString:@"tauri"] || [request.URL.scheme isEqualToString:@"about"]) {
        return ((WKNavigation *(*)(id, SEL, NSURLRequest *))originalLoadRequest)(view,selector,request);
    }
    return nil;
}
bool witness_install_simulated_page(void) {
    if (!NSThread.isMainThread || originalLoadRequest) return false;
    Method method = class_getInstanceMethod(WKWebView.class, @selector(loadRequest:));
    if (!method) return false;
    originalLoadRequest = method_setImplementation(method, (IMP)fixtureLoad);
    return originalLoadRequest != NULL;
}
unsigned witness_simulated_loads(void) { return simulatedLoads; }
