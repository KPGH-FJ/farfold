#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "RunningPage.h"

static const uint64_t RRBrowserID = 2801;
static const uint64_t RRNavigation = 71;

static BOOL attempted;
static BOOL active;
static BOOL closed;
static BOOL initializationStarted;
static BOOL ready;
static BOOL mutationPending;
static BOOL mutated;
static BOOL closeEventSent;
static uint64_t createCount;
static uint64_t readCount;
static void *eventContext;
static RunningPageEvent eventCallback;
static __weak WKWebView *originalView;
static __weak WKWebView *originalParent;
static __weak NSView *originalContainer;

static BOOL onMainThread(void) {
    return NSThread.isMainThread;
}

static void emitEvent(int event, const char *json) {
    if (!onMainThread()) return;
    RunningPageEvent callback = eventCallback;
    if (callback) callback(eventContext, event, json);
}

static void emitError(const char *json) {
    ready = NO;
    mutationPending = NO;
    emitEvent(RR_EVENT_ERROR, json);
}

static bool allowBlank(void *context, const char *url) {
    (void)context;
    return onMainThread() && active && !closed && url && strcmp(url, "about:blank") == 0;
}

bool rr_same_instance(void) {
    if (!onMainThread() || !active || closed || !originalView || !originalParent || !originalContainer) return false;
    WKWebView *initial = originalView;
    WKWebView *parent = originalParent;
    NSView *container = originalContainer;
    if (initial == parent || parent.superview != container || initial.superview != container ||
        initial.window != parent.window || !initial.window) return false;
    // Compare the actual current view object in the original hierarchy with
    // the object discovered immediately after the sole successful creation.
    for (NSView *candidate in container.subviews) {
        if (candidate == initial) return true;
    }
    return false;
}

bool rr_is_ephemeral(void) {
    if (!rr_same_instance()) return false;
    WKWebView *view = originalView;
    WKWebView *parent = originalParent;
    return !view.configuration.websiteDataStore.persistent &&
        view.configuration.websiteDataStore != parent.configuration.websiteDataStore &&
        view.configuration.userContentController != parent.configuration.userContentController;
}

static uint64_t browserStatus(void *context, int event, uint64_t navigation, const char *url) {
    (void)context;
    (void)url;
    if (!onMainThread() || !active || closed) return 0;
    // No user-driven navigation is authorized by this fixture.
    if (event == 4) return 0;
    if (event == 0) return 0;
    if (event == 1 && navigation == RRNavigation && !initializationStarted) {
        initializationStarted = YES;
        if (!rr_same_instance() || !rr_is_ephemeral()) {
            emitError("{\"code\":\"initial-instance-check-failed\"}");
            return 0;
        }
        WKWebView *view = originalView;
        // Fixed fixture script. No caller-supplied script, data, URL or path.
        NSString *script = @"(()=>{document.title='Running controlled page';const main=document.createElement('main');main.id='running-page-content';main.textContent='Running page version one';const input=document.createElement('input');input.type='text';input.value='SYNTHETIC_SECRET_INPUT';input.setAttribute('value','SYNTHETIC_SECRET_INPUT');input.setAttribute('aria-label','Synthetic input excluded from reads');document.body.replaceChildren(main,input);return document.title==='Running controlled page'&&main.textContent==='Running page version one'})()";
        [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
            if (!active || closed || view != originalView) return;
            if (error || ![value isKindOfClass:NSNumber.class] || ![value boolValue] || !rr_same_instance()) {
                emitError("{\"code\":\"initialization-eval-failed\"}");
                return;
            }
            ready = YES;
            emitEvent(RR_EVENT_READY, "{\"pageVersion\":1}");
        }];
    } else if (event == 2 || event == 3 || event == 5) {
        emitError("{\"code\":\"controlled-navigation-failed\"}");
    } else if (event == 1 && navigation != RRNavigation) {
        emitError("{\"code\":\"unexpected-navigation-token\"}");
    }
    return 0;
}

bool rr_create(void *parent_wk_view, void *context, RunningPageEvent callback) {
    if (!onMainThread() || attempted || !parent_wk_view || !callback) return false;
    attempted = YES;
    eventContext = context;
    eventCallback = callback;
    WKWebView *parent = (__bridge WKWebView *)parent_wk_view;
    if (![parent isKindOfClass:WKWebView.class] || !parent.superview || !parent.window) {
        emitError("{\"code\":\"parent-view-unavailable\"}");
        return false;
    }
    NSView *container = parent.superview;
    NSSet<NSView *> *before = [NSSet setWithArray:container.subviews];
    double width = MIN(720.0, parent.bounds.size.width - 48.0);
    double height = MIN(380.0, parent.bounds.size.height - 134.0);
    if (width < 1 || height < 1) {
        emitError("{\"code\":\"parent-view-too-small\"}");
        return false;
    }
    active = YES;
    closed = NO;
    if (!ff_browser_create(RRBrowserID, parent_wk_view, 24, 110, width, height,
                           NULL, allowBlank, browserStatus, NULL)) {
        active = NO;
        emitError("{\"code\":\"native-create-failed\"}");
        return false;
    }
    createCount++;
    WKWebView *created = nil;
    NSUInteger createdCount = 0;
    for (NSView *candidate in container.subviews) {
        if (![before containsObject:candidate] && [candidate isKindOfClass:WKWebView.class]) {
            created = (WKWebView *)candidate;
            createdCount++;
        }
    }
    if (createdCount != 1 || !created || created == parent) {
        active = NO;
        closed = YES;
        ff_browser_close(RRBrowserID);
        emitError("{\"code\":\"created-view-identity-ambiguous\"}");
        return false;
    }
    originalView = created;
    originalParent = parent;
    originalContainer = container;
    if (!rr_is_ephemeral()) {
        active = NO;
        closed = YES;
        ff_browser_close(RRBrowserID);
        emitError("{\"code\":\"ephemeral-store-check-failed\"}");
        return false;
    }
    if (!ff_browser_navigate(RRBrowserID, RRNavigation, "about:blank")) {
        active = NO;
        closed = YES;
        ff_browser_close(RRBrowserID);
        emitError("{\"code\":\"controlled-navigation-rejected\"}");
        return false;
    }
    return true;
}

bool rr_mutate(void) {
    if (!onMainThread() || !ready || mutated || mutationPending || !rr_same_instance()) return false;
    mutationPending = YES;
    WKWebView *view = originalView;
    NSString *script = @"(()=>{const main=document.getElementById('running-page-content');if(!main||main.textContent!=='Running page version one')return false;main.textContent='Running page version two';return document.title==='Running controlled page'&&main.textContent==='Running page version two'})()";
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        if (!active || closed || view != originalView) return;
        mutationPending = NO;
        if (error || ![value isKindOfClass:NSNumber.class] || ![value boolValue] || !rr_same_instance()) {
            emitError("{\"code\":\"mutation-eval-failed\"}");
            return;
        }
        mutated = YES;
        emitEvent(RR_EVENT_MUTATED, "{\"pageVersion\":2}");
    }];
    return true;
}

bool rr_read(void *context, FFBrowserRead callback) {
    if (!onMainThread() || !ready || mutationPending || !callback || !rr_same_instance()) return false;
    bool accepted = ff_browser_read(RRBrowserID, context, callback);
    if (accepted) readCount++;
    return accepted;
}

bool rr_close(void) {
    if (!onMainThread() || !attempted) return false;
    if (closeEventSent) return true;
    active = NO;
    closed = YES;
    ready = NO;
    mutationPending = NO;
    if (!ff_browser_close(RRBrowserID)) return false;
    // ff_browser_close synchronously detaches and cancels a pending read.
    if (originalView && originalView.superview) return false;
    closeEventSent = YES;
    RunningPageEvent callback = eventCallback;
    void *context = eventContext;
    eventCallback = NULL;
    eventContext = NULL;
    if (callback) callback(context, RR_EVENT_CLOSED, "{}");
    return true;
}

uint64_t rr_create_count(void) {
    return onMainThread() ? createCount : 0;
}

uint64_t rr_read_count(void) {
    return onMainThread() ? readCount : 0;
}
