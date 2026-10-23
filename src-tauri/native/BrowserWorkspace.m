#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "BrowserWorkspace.h"

// All access is confined to the main thread. Shutdown is intentionally terminal.
static BOOL shutdownStarted;
static BOOL closingAll;
static NSUInteger closeDepth;
static NSMutableSet<NSUUID *> *clearingHTMLStores;

@interface FFReadRequest : NSObject
@property(nonatomic) void *context;
@property(nonatomic) FFBrowserRead callback;
@property(nonatomic) uint64_t operationID;
@property(nonatomic) BOOL retired;
- (void)finish:(NSString *)json error:(NSString *)error;
@end
@implementation FFReadRequest
- (void)finish:(NSString *)json error:(NSString *)error {
    FFBrowserRead callback = self.callback;
    void *context = self.context;
    self.callback = NULL;
    self.context = NULL;
    if (callback) callback(context, json.UTF8String, error.UTF8String);
}
@end

@class FFPublicBrowser;
@interface FFPreviewSchemeHandler : NSObject <WKURLSchemeHandler>
@property(nonatomic, weak) FFPublicBrowser *browser;
@property(nonatomic, copy) NSString *origin;
@property(nonatomic) FFBrowserResource resource;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, id<WKURLSchemeTask>> *tasks;
- (void)close;
- (BOOL)finish:(uint64_t)request bytes:(NSData *)bytes mime:(NSString *)mime headers:(NSDictionary *)headers;
@end

@interface FFPublicBrowser : NSObject <WKNavigationDelegate, WKUIDelegate>
@property(nonatomic, strong) WKWebView *view;
@property(nonatomic, weak) WKWebView *parent;
@property(nonatomic) void *context;
@property(nonatomic) FFBrowserPolicy policy;
@property(nonatomic) FFBrowserStatus status;
@property(nonatomic) FFBrowserRelease releaseContext;
@property(nonatomic) BOOL closed;
@property(nonatomic) BOOL localHTML;
@property(nonatomic) BOOL preview;
@property(nonatomic, strong) FFPreviewSchemeHandler *resourceHandler;
@property(nonatomic) NSRect cssBounds;
@property(nonatomic) BOOL hasBounds;
@property(nonatomic) BOOL geometryPending;
@property(nonatomic, strong) NSMutableArray<id> *geometryObservers;
@property(nonatomic, strong) id interactionMonitor;
@property(nonatomic) BOOL closeComplete;
@property(nonatomic, strong) FFReadRequest *readRequest;
@property(nonatomic, strong) NSMapTable<WKNavigation *, NSNumber *> *navigationTokens;
@property(nonatomic, strong) WKNavigation *currentNavigation;
@property(nonatomic, copy) NSString *pendingPolicyURL;
@property(nonatomic) uint64_t currentToken;
@property(nonatomic, copy) NSString *observationID;
@property(nonatomic, strong) WKNavigation *redirectNavigation;
- (BOOL)loadRequest:(NSURLRequest *)request token:(uint64_t)token;
- (void)emit:(int)event navigation:(WKNavigation *)navigation url:(NSURL *)url;
- (void)close;
- (void)observeGeometry;
- (void)observeInteraction;
- (void)userActivity:(NSEvent *)event;
- (void)geometryChanged;
@end

static BOOL resize(FFPublicBrowser *browser, double x, double y, double width, double height, BOOL requireInside);

@implementation FFPublicBrowser
- (void)observeInteraction {
    __weak FFPublicBrowser *weakBrowser = self;
    self.interactionMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:
        NSEventMaskKeyDown | NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown
        handler:^NSEvent *(NSEvent *event) {
            [weakBrowser userActivity:event];
            return event;
        }];
}
- (void)userActivity:(NSEvent *)event {
    // Observe ownership only: never inspect characters, key codes, clipboard,
    // menu content or field values. A click in the app's approval UI must not
    // count merely because this view still has keyboard focus.
    if (shutdownStarted || self.closed || !self.view.window || event.window != self.view.window ||
        self.view.hiddenOrHasHiddenAncestor) return;
    if (event.type == NSEventTypeKeyDown) {
        NSResponder *responder = self.view.window.firstResponder;
        if (![responder isKindOfClass:NSView.class] || ![(NSView *)responder isDescendantOf:self.view]) return;
    } else if (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeRightMouseDown || event.type == NSEventTypeOtherMouseDown) {
        NSPoint point = [self.view convertPoint:event.locationInWindow fromView:nil];
        if (!NSPointInRect(point,self.view.bounds)) return;
    } else return;
    self.observationID = nil;
    FFReadRequest *request = self.readRequest;
    // Manual activity withdraws the receiver, but does not prove already queued
    // JavaScript has stopped. Keep its execution slot until completion/close.
    request.retired = YES;
    uint64_t token = self.status ? self.status(self.context,6,self.currentToken,self.view.URL.absoluteString.UTF8String) : 0;
    if (token) self.currentToken = token;
    [request finish:nil error:@"你已操作此网页，请重新确认分享范围"];
}
- (void)observeGeometry {
    // These are notifications for the exact app-owned parent and window only.
    self.parent.postsFrameChangedNotifications = YES;
    self.parent.postsBoundsChangedNotifications = YES;
    self.geometryObservers = [NSMutableArray new];
    __weak FFPublicBrowser *weakBrowser = self;
    void (^changed)(NSNotification *) = ^(NSNotification *notification) {
        [weakBrowser geometryChanged];
    };
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    for (NSNotificationName name in @[NSViewFrameDidChangeNotification, NSViewBoundsDidChangeNotification]) {
        [self.geometryObservers addObject:[center addObserverForName:name object:self.parent queue:NSOperationQueue.mainQueue usingBlock:changed]];
    }
    NSWindow *window = self.parent.window;
    if (window) {
        for (NSNotificationName name in @[NSWindowDidResizeNotification, NSWindowDidEndLiveResizeNotification,
                                          NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification]) {
            [self.geometryObservers addObject:[center addObserverForName:name object:window queue:NSOperationQueue.mainQueue usingBlock:changed]];
        }
    }
}
- (void)geometryChanged {
    if (shutdownStarted || self.closed || !self.hasBounds || self.geometryPending) return;
    self.geometryPending = YES;
    __weak FFPublicBrowser *weakBrowser = self;
    // AppKit may notify before all frame/safe-area changes settle. Coalesce one
    // main-thread pass instead of relying on another identical DOM measurement.
    dispatch_async(dispatch_get_main_queue(), ^{
        FFPublicBrowser *browser = weakBrowser;
        if (!browser) return;
        browser.geometryPending = NO;
        if (shutdownStarted || browser.closed || !browser.hasBounds) return;
        NSRect bounds = browser.cssBounds;
        resize(browser, bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height, NO);
    });
}
- (void)emit:(int)event url:(NSURL *)url {
    if (!shutdownStarted && !self.closed && self.status) self.status(self.context, event, self.currentToken, url.absoluteString.UTF8String);
}
- (BOOL)loadRequest:(NSURLRequest *)request token:(uint64_t)token {
    if (shutdownStarted || self.closed || !token) return NO;
    self.observationID = nil;
    [self.resourceHandler close];
    self.currentToken = token;
    self.pendingPolicyURL = request.URL.absoluteString;
    self.redirectNavigation = nil;
    WKNavigation *navigation = [self.view loadRequest:request];
    if (!navigation) { self.pendingPolicyURL = nil; return NO; }
    self.currentNavigation = navigation;
    [self.navigationTokens setObject:@(token) forKey:navigation];
    return YES;
}
- (void)emit:(int)event navigation:(WKNavigation *)navigation url:(NSURL *)url {
    NSNumber *token = navigation ? [self.navigationTokens objectForKey:navigation] : nil;
    // Retire terminal navigation before calling Rust, which may reenter close.
    if (event == 1 || event == 2) [self.navigationTokens removeObjectForKey:navigation];
    if (!shutdownStarted && !self.closed && self.status && token) {
        self.status(self.context, event, token.unsignedLongLongValue, url.absoluteString.UTF8String);
    }
}
- (void)close {
    if (self.closed) return;
    self.closed = YES;
    self.observationID = nil;
    [self.resourceHandler close];
    if (self.interactionMonitor) [NSEvent removeMonitor:self.interactionMonitor];
    self.interactionMonitor = nil;
    for (id observer in self.geometryObservers) {
        [NSNotificationCenter.defaultCenter removeObserver:observer];
    }
    self.geometryObservers = nil;
    self.hasBounds = NO;
    FFReadRequest *request = self.readRequest;
    FFBrowserRelease release = self.releaseContext;
    void *context = self.context;
    // Clear ownership before any callback or WebKit operation can reenter.
    self.readRequest = nil;
    self.policy = NULL;
    self.status = NULL;
    self.releaseContext = NULL;
    self.context = NULL;
    [self.navigationTokens removeAllObjects];
    self.currentNavigation = nil;
    self.redirectNavigation = nil;
    self.pendingPolicyURL = nil;
    self.view.navigationDelegate = nil;
    self.view.UIDelegate = nil;
    [self.view stopLoading];
    [self.view removeFromSuperview];
    [request finish:nil error:@"网页已关闭，读取已取消"];
    if (release) release(context);
    self.closeComplete = YES;
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    if (action.targetFrame && !action.targetFrame.isMainFrame) { decisionHandler(WKNavigationActionPolicyCancel); return; }
    BOOL allowed = !self.closed && action.targetFrame != nil && self.policy &&
        self.policy(self.context, action.request.URL.absoluteString.UTF8String);
    allowed = allowed && !shutdownStarted && !self.closed;
    if (@available(macOS 11.3, *)) {
        if (action.shouldPerformDownload) allowed = NO;
    }
    if (allowed && action.navigationType == WKNavigationTypeLinkActivated) {
        // Convert user links to loadRequest so the returned WKNavigation is
        // known before any asynchronous start/finish/fail delegate callback.
        uint64_t token = self.status ? self.status(self.context, 4, 0, action.request.URL.absoluteString.UTF8String) : 0;
        decisionHandler(WKNavigationActionPolicyCancel);
        if (!token || ![self loadRequest:action.request token:token]) [self emit:3 url:nil];
        return;
    }
    BOOL expectedRequest = self.pendingPolicyURL && [self.pendingPolicyURL isEqualToString:action.request.URL.absoluteString];
    // Same-navigation redirects may continue during a controlled provisional
    // load. An unknown WKNavigation never gets a token or produces ready.
    BOOL controlledContinuation = self.redirectNavigation == self.currentNavigation &&
        self.redirectNavigation && [self.navigationTokens objectForKey:self.redirectNavigation].unsignedLongLongValue == self.currentToken;
    allowed = allowed && action.navigationType == WKNavigationTypeOther && (expectedRequest || controlledContinuation);
    // Keep the current request permit until its own didStart; older queued
    // actions for the same URL must not consume a newer request permit.
    if (controlledContinuation) self.redirectNavigation = nil;
    // Unattributed script/form policy callbacks must not overwrite a newer page.
    if (!allowed && (expectedRequest || controlledContinuation)) [self emit:3 url:nil];
    decisionHandler(allowed ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationResponse:(WKNavigationResponse *)response decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
    BOOL allowed = !self.closed && response.canShowMIMEType && self.policy && self.policy(self.context, response.response.URL.absoluteString.UTF8String);
    allowed = allowed && !shutdownStarted && !self.closed;
    decisionHandler(allowed ? WKNavigationResponsePolicyAllow : WKNavigationResponsePolicyCancel);
}
- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation {
    if (![self.navigationTokens objectForKey:navigation]) {
        // Never let a late, unattributed start stop/block a newer controlled load.
        // Unsupported script/form actions are cancelled by the action policy.
        return;
    }
    if (navigation == self.currentNavigation) self.pendingPolicyURL = nil;
    [self emit:0 navigation:navigation url:webView.URL];
}
- (void)webView:(WKWebView *)webView didReceiveServerRedirectForProvisionalNavigation:(WKNavigation *)navigation {
    NSNumber *token = [self.navigationTokens objectForKey:navigation];
    if (navigation == self.currentNavigation && token.unsignedLongLongValue == self.currentToken) {
        self.redirectNavigation = navigation;
        if (!self.policy || !self.policy(self.context, webView.URL.absoluteString.UTF8String)) {
            [self emit:3 navigation:navigation url:nil];
            [webView stopLoading];
        }
    }
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation { [self emit:1 navigation:navigation url:webView.URL]; }
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self emit:2 navigation:navigation url:nil]; }
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (error.code != NSURLErrorCancelled) [self emit:2 navigation:navigation url:nil];
    else {
        // A policy cancellation is terminal for THAT navigation, including
        // response MIME/origin rejection. Never use the current token here.
        [self emit:3 navigation:navigation url:nil];
        [self.navigationTokens removeObjectForKey:navigation];
    }
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView { [self emit:5 url:nil]; }

- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    [self emit:3 url:nil];
    return nil;
}
- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))completionHandler { completionHandler(nil); }
- (void)webView:(WKWebView *)webView requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision))decisionHandler API_AVAILABLE(macos(12.0)) { decisionHandler(WKPermissionDecisionDeny); }
- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler { completionHandler(); }
- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler { completionHandler(NO); }
- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt defaultText:(NSString *)defaultText initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSString *))completionHandler { completionHandler(nil); }
@end

static NSMutableDictionary<NSNumber *, FFPublicBrowser *> *registry;
static FFPublicBrowser *lookup(uint64_t browserID) {
    if (![NSThread isMainThread]) return nil;
    return registry[@(browserID)];
}
static NSString *previewOrigin(NSURL *url) {
    return url.scheme && url.host && !url.user && !url.password && !url.port ?
        [NSString stringWithFormat:@"%@://%@",url.scheme.lowercaseString,url.host.lowercaseString] : nil;
}
@implementation FFPreviewSchemeHandler
- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    FFPublicBrowser *browser = self.browser;
    NSURL *url = task.request.URL;
    if (shutdownStarted || !browser || browser.closed || !self.resource || !browser.context ||
        ![self.origin isEqual:previewOrigin(url)] || url.query || url.fragment ||
        ![task.request.HTTPMethod isEqualToString:@"GET"] || !browser.policy ||
        !browser.policy(browser.context,url.absoluteString.UTF8String)) {
        [task didFailWithError:[NSError errorWithDomain:@"FarfoldPreview" code:1 userInfo:nil]];
        return;
    }
    static uint64_t nextRequest = 1;
    uint64_t request = nextRequest++;
    if (!request) { [task didFailWithError:[NSError errorWithDomain:@"FarfoldPreview" code:1 userInfo:nil]]; return; }
    self.tasks[@(request)] = task;
    self.resource(browser.context,request,url.absoluteString.UTF8String);
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {
    for (NSNumber *key in self.tasks.allKeys) if (self.tasks[key] == task) [self.tasks removeObjectForKey:key];
}
- (void)close {
    NSArray *tasks = self.tasks.allValues;
    [self.tasks removeAllObjects];
    for (id<WKURLSchemeTask> task in tasks) [task didFailWithError:[NSError errorWithDomain:@"FarfoldPreview" code:2 userInfo:nil]];
}
- (BOOL)finish:(uint64_t)request bytes:(NSData *)bytes mime:(NSString *)mime headers:(NSDictionary *)headers {
    NSNumber *key = @(request);
    id<WKURLSchemeTask> task = self.tasks[key];
    if (!task || !self.browser || self.browser.closed || shutdownStarted) return NO;
    if (!bytes || !mime || !headers) {
        [self.tasks removeObjectForKey:key];
        [task didFailWithError:[NSError errorWithDomain:@"FarfoldPreview" code:3 userInfo:nil]];
        return YES;
    }
    NSMutableDictionary *fields = [headers mutableCopy];
    fields[@"Content-Type"] = mime;
    fields[@"Content-Length"] = [NSString stringWithFormat:@"%lu",(unsigned long)bytes.length];
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:task.request.URL statusCode:200 HTTPVersion:@"HTTP/1.1" headerFields:fields];
    [task didReceiveResponse:response];
    if (self.tasks[key] != task || self.browser.closed) return NO;
    [task didReceiveData:bytes];
    if (self.tasks[key] != task || self.browser.closed) return NO;
    [self.tasks removeObjectForKey:key];
    [task didFinish];
    return YES;
}
@end

bool ff_browser_resource_finish(uint64_t browserID, uint64_t request, const uint8_t *bytes,
                               uintptr_t length, const char *mime, const char *headersJSON) {
    if (![NSThread isMainThread]) return false;
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || !browser.resourceHandler || length > 9 * 1024 * 1024) return false;
    if (!mime) return [browser.resourceHandler finish:request bytes:nil mime:nil headers:nil];
    NSString *type = [NSString stringWithUTF8String:mime];
    NSString *json = headersJSON ? [NSString stringWithUTF8String:headersJSON] : nil;
    NSDictionary *headers = json ? [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL] : nil;
    if (![headers isKindOfClass:NSDictionary.class] || !type || (!bytes && length)) return false;
    for (id key in headers) if (![key isKindOfClass:NSString.class] || ![headers[key] isKindOfClass:NSString.class]) return false;
    return [browser.resourceHandler finish:request bytes:[NSData dataWithBytes:bytes length:length] mime:type headers:headers];
}
static BOOL boundsValid(double x, double y, double width, double height) {
    return isfinite(x) && isfinite(y) && isfinite(width) && isfinite(height) &&
        x >= 0 && y >= 0 && width >= 1 && height >= 1 && width <= 10000 && height <= 10000;
}
static BOOL resize(FFPublicBrowser *browser, double x, double y, double width, double height, BOOL requireInside) {
    WKWebView *parent = browser.parent;
    if (!parent || !parent.superview || !boundsValid(x,y,width,height)) return NO;
    // DOM client coordinates start in WK's unobscured content viewport, not
    // the complete NSView (which can also extend behind the window title bar).
    // Re-read the safe area on every placement, including fullscreen changes.
    NSRect viewport = parent.safeAreaRect;
    CGFloat zoom = parent.pageZoom;
    if (!isfinite(zoom) || zoom <= 0) return NO;
    NSRect cssBounds = NSMakeRect(x, y, width, height);
    x *= zoom; y *= zoom; width *= zoom; height *= zoom;
    if (!isfinite(x) || !isfinite(y) || !isfinite(width) || !isfinite(height) ||
        !isfinite(x + width) || !isfinite(y + height)) return NO;
    // Creation/restoration must fit the current content area. An ordinary
    // resize may carry the previous layout after AppKit shrank the window;
    // keep that live page until the next layout update supplies fresh bounds.
    if (requireInside && (x + width > viewport.size.width + 1 ||
                          y + height > viewport.size.height + 1)) return NO;
    CGFloat localX = NSMinX(viewport) + x;
    CGFloat localY = parent.isFlipped ? NSMinY(viewport) + y : NSMaxY(viewport) - y - height;
    browser.view.frame = [parent convertRect:NSMakeRect(localX, localY, width, height) toView:parent.superview];
    browser.cssBounds = cssBounds;
    browser.hasBounds = YES;
    return YES;
}

static bool createBrowser(uint64_t browserID, void *parent_wk_view, double x, double y,
                       double width, double height, void *context,
                       FFBrowserPolicy policy, FFBrowserStatus status,
                       FFBrowserRelease release, NSString *storageIdentifier,
                       NSString *origin, FFBrowserResource resource) {
    if (![NSThread isMainThread] || shutdownStarted || closeDepth || !parent_wk_view || !boundsValid(x,y,width,height)) return false;
    WKWebView *parent = (__bridge WKWebView *)parent_wk_view;
    if (![parent isKindOfClass:WKWebView.class] || !parent.superview) return false;
    if (!registry) registry = [NSMutableDictionary new];
    if (registry[@(browserID)]) return false;
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    if (storageIdentifier) {
        NSUUID *identifier = [[NSUUID alloc] initWithUUIDString:storageIdentifier];
        if (!identifier || [identifier.UUIDString isEqualToString:@"00000000-0000-0000-0000-000000000000"] ||
            [clearingHTMLStores containsObject:identifier]) return false;
        if (@available(macOS 14.0, *)) {
            configuration.websiteDataStore = [WKWebsiteDataStore dataStoreForIdentifier:identifier];
        } else {
            configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        }
    } else {
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
    }
    configuration.userContentController = [WKUserContentController new];
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = NO;
    FFPublicBrowser *browser = [FFPublicBrowser new];
    browser.preview = origin != nil;
    if (resource) {
        NSURL *url = [NSURL URLWithString:origin];
        if (![url.scheme isEqualToString:@"ff-preview"] || !previewOrigin(url)) return false;
        FFPreviewSchemeHandler *handler = [FFPreviewSchemeHandler new];
        handler.browser = browser; handler.origin = previewOrigin(url); handler.resource = resource;
        handler.tasks = [NSMutableDictionary new]; browser.resourceHandler = handler;
        [configuration setURLSchemeHandler:handler forURLScheme:@"ff-preview"];
    }
    browser.navigationTokens = [NSMapTable strongToStrongObjectsMapTable];
    browser.parent = parent;
    browser.localHTML = storageIdentifier != nil && !browser.preview;
    browser.view = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    // Creation never presents a page. Explicit selected-page show owns visibility.
    browser.view.hidden = YES;
    browser.view.navigationDelegate = browser;
    browser.view.UIDelegate = browser;
    browser.context = context;
    browser.policy = policy;
    browser.status = status;
    browser.releaseContext = release;
    if (!resize(browser,x,y,width,height,YES)) {
        // Caller retains context ownership on creation failure.
        browser.releaseContext = NULL;
        return false;
    }
    registry[@(browserID)] = browser;
    [parent.superview addSubview:browser.view positioned:NSWindowAbove relativeTo:parent];
    [browser observeGeometry];
    [browser observeInteraction];
    return true;
}

bool ff_browser_create(uint64_t browserID, void *parent_wk_view, double x, double y,
                       double width, double height, void *context,
                       FFBrowserPolicy policy, FFBrowserStatus status,
                       FFBrowserRelease release) {
    return createBrowser(browserID,parent_wk_view,x,y,width,height,context,policy,status,release,nil,nil,NULL);
}

bool ff_browser_create_html(uint64_t browserID, void *parent_wk_view, double x, double y,
                       double width, double height, void *context,
                       FFBrowserPolicy policy, FFBrowserStatus status,
                       FFBrowserRelease release, const char *storage_identifier) {
    NSString *identifier = storage_identifier ? [NSString stringWithUTF8String:storage_identifier] : nil;
    return identifier && createBrowser(browserID,parent_wk_view,x,y,width,height,context,policy,status,release,identifier,nil,NULL);
}

bool ff_browser_create_preview(uint64_t browserID, void *parent_wk_view, double x, double y,
                       double width, double height, void *context, FFBrowserPolicy policy,
                       FFBrowserStatus status, FFBrowserRelease release, const char *storageIdentifier,
                       const char *origin, FFBrowserResource resource) {
    NSString *storage = storageIdentifier ? [NSString stringWithUTF8String:storageIdentifier] : nil;
    NSString *text = origin ? [NSString stringWithUTF8String:origin] : nil;
    NSURL *url = text ? [NSURL URLWithString:text] : nil;
    if ((resource && !storage) || !url || url.user || url.password || url.query || url.fragment) return false;
    if (!resource && (![@[@"http",@"https"] containsObject:url.scheme.lowercaseString] ||
        ![@[@"127.0.0.1",@"[::1]",@"::1"] containsObject:url.host] ||
        (url.path.length && ![url.path isEqualToString:@"/"]))) return false;
    // Only selected offline directories have durable page data. Development
    // applications get a fresh temporary store even if a caller passes an ID.
    return createBrowser(browserID,parent_wk_view,x,y,width,height,context,policy,status,release,
                         resource ? storage : nil,text,resource);
}

bool ff_browser_navigate_preview(uint64_t browserID, uint64_t navigation, const char *url) {
    if (![NSThread isMainThread] || shutdownStarted) return false;
    FFPublicBrowser *browser = lookup(browserID);
    NSString *text = url ? [NSString stringWithUTF8String:url] : nil;
    NSURL *target = text ? [NSURL URLWithString:text] : nil;
    if (!browser || browser.closed || !browser.preview || !target || !browser.policy || !browser.policy(browser.context,url)) return false;
    return [browser loadRequest:[NSURLRequest requestWithURL:target] token:navigation];
}

bool ff_browser_persistent_html_supported(void) {
    if (@available(macOS 14.0, *)) return true;
    return false;
}

bool ff_browser_clear_html_storage(const char *storage_identifier, void *context, FFBrowserRead callback) {
    if (![NSThread isMainThread] || shutdownStarted || closeDepth || !storage_identifier || !callback) return false;
    NSString *text = [NSString stringWithUTF8String:storage_identifier];
    NSUUID *identifier = text ? [[NSUUID alloc] initWithUUIDString:text] : nil;
    if (!identifier || [identifier.UUIDString isEqualToString:@"00000000-0000-0000-0000-000000000000"]) return false;
    if (@available(macOS 14.0, *)) {
        if ([clearingHTMLStores containsObject:identifier]) return false;
        for (FFPublicBrowser *browser in registry.allValues) {
            if ([browser.view.configuration.websiteDataStore.identifier isEqual:identifier]) return false;
        }
        // WebKit can retain the closed view's store while finishing its own
        // asynchronous work. Removing the whole store then reports "in use".
        // Clear data through this exact dedicated store instead; keeping the
        // opaque store identity does not preserve the file's page storage.
        WKWebsiteDataStore *store = [WKWebsiteDataStore dataStoreForIdentifier:identifier];
        if (!clearingHTMLStores) clearingHTMLStores = [NSMutableSet new];
        [clearingHTMLStores addObject:identifier];
        [store removeDataOfTypes:WKWebsiteDataStore.allWebsiteDataTypes
                  modifiedSince:NSDate.distantPast completionHandler:^{
            dispatch_async(dispatch_get_main_queue(), ^{
                // Keep this gate even if the Rust caller's wait timed out: a
                // late clear must never remove a newly opened page's writes.
                [clearingHTMLStores removeObject:identifier];
                callback(context, "{}", NULL);
            });
        }];
        return true;
    }
    return false;
}

bool ff_browser_navigate(uint64_t browserID, uint64_t navigation, const char *url) {
    if (![NSThread isMainThread] || shutdownStarted) return false;
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || browser.closed || browser.localHTML || browser.preview || !url) return false;
    NSString *text = [NSString stringWithUTF8String:url];
    NSURL *target = text ? [NSURL URLWithString:text] : nil;
    if (!target || !browser.policy || !browser.policy(browser.context,url)) return false;
    return [browser loadRequest:[NSURLRequest requestWithURL:target] token:navigation];
}

bool ff_browser_load_html(uint64_t browserID, uint64_t navigation, const char *html, const char *base_url) {
    if (![NSThread isMainThread] || shutdownStarted || !navigation) return false;
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || browser.closed || browser.currentToken || !html || !base_url) return false;
    NSString *document = [NSString stringWithUTF8String:html];
    NSString *baseText = [NSString stringWithUTF8String:base_url];
    NSURL *base = baseText ? [NSURL URLWithString:baseText] : nil;
    if (!document || !base || !browser.policy || !browser.policy(browser.context, base_url)) return false;
    browser.localHTML = YES;
    browser.currentToken = navigation;
    browser.pendingPolicyURL = baseText;
    browser.redirectNavigation = nil;
    WKNavigation *request = [browser.view loadHTMLString:document baseURL:base];
    if (!request) { browser.pendingPolicyURL = nil; return false; }
    browser.currentNavigation = request;
    [browser.navigationTokens setObject:@(navigation) forKey:request];
    return true;
}

bool ff_browser_resize(uint64_t browserID, double x, double y, double width, double height) {
    if (![NSThread isMainThread] || shutdownStarted) return false;
    FFPublicBrowser *browser = lookup(browserID);
    return browser && !browser.closed && resize(browser,x,y,width,height,NO);
}

bool ff_browser_set_visible(uint64_t browserID, bool visible, double x, double y, double width, double height) {
    if (![NSThread isMainThread] || shutdownStarted) return false;
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || browser.closed || !browser.view) return false;
    // Never show at stale coordinates, including failure to restore the parent.
    browser.view.hidden = YES;
    if (!visible) return browser.view.hidden;
    if (browser.view.superview != browser.parent.superview || !resize(browser,x,y,width,height,YES)) return false;
    browser.view.hidden = NO;
    return !browser.view.hidden;
}

int32_t ff_browser_read(uint64_t browserID, uint64_t operationID, const char *expectedURL, void *context, FFBrowserRead callback) {
    if (![NSThread isMainThread] || shutdownStarted || !operationID) return false;
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || browser.closed || browser.localHTML || browser.view.loading || browser.readRequest || !callback) return false;
    if (expectedURL) {
        NSString *expected = [NSString stringWithUTF8String:expectedURL];
        if (!expected || ![browser.view.URL.absoluteString isEqualToString:expected]) return 2;
    }
    FFReadRequest *request = [FFReadRequest new];
    request.operationID = operationID;
    request.context = context;
    request.callback = callback;
    browser.readRequest = request;
    NSString *script = @"(()=>{if(document.querySelector('input[type=password],input[autocomplete=one-time-code],input[autocomplete=current-password],input[autocomplete=new-password]'))return {blocked:true};const copy=document.body?.cloneNode(true);copy?.querySelectorAll('script,style,noscript,input,textarea,select,form,[contenteditable],iframe').forEach(n=>n.remove());return {blocked:false,url:location.href.slice(0,4096),title:document.title.slice(0,512),text:(copy ? copy.textContent : '').slice(0,65536)}})()";
    __weak FFPublicBrowser *weakBrowser = browser;
    [browser.view evaluateJavaScript:script inFrame:nil inContentWorld:[WKContentWorld worldWithName:@"FarfoldPublicReadOnly"] completionHandler:^(id value, NSError *error) {
        FFPublicBrowser *active = weakBrowser;
        if (!active || active.closed || active.readRequest != request) return;
        active.readRequest = nil;
        // Receiver retirement cannot cancel JavaScript. Its actual callback is
        // the point at which this old execution slot can be released safely.
        if (request.retired) return;
        if (shutdownStarted) {
            [request finish:nil error:@"网页已关闭，读取已取消"];
            return;
        }
        if (error || ![NSJSONSerialization isValidJSONObject:value]) {
            [request finish:nil error:@"未能读取网页，请重新打开后再试"];
            return;
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
        if (!data || data.length > 300000) { [request finish:nil error:@"网页返回内容过大"]; return; }
        [request finish:[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] error:nil];
    }];
    return true;
}

// These are documented public macOS 27 selectors. The local declarations keep
// the existing deployment target/older SDK build; never use the private _WK API.
// https://developer.apple.com/documentation/webkit/wkcontentworld/configuration
@protocol FFClosedRootConfiguration <NSObject>
@property(nonatomic) BOOL allowAccessingClosedShadowRoots;
@end
@protocol FFConfiguredWorldFactory <NSObject>
+ (WKContentWorld *)worldWithConfiguration:(id)configuration;
@end
static BOOL observationInspectsClosedRoots;

// The executable program is fixed here. WebKit arguments carry data only.
static WKContentWorld *observationWorld(void) {
    // A name is a debugging label, not an identity. Retain the same world so
    // follow-up checks/actions see the exact isolated node map we created.
    static WKContentWorld *world;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        if (@available(macOS 27.0, *)) {
            Class configurationClass = NSClassFromString(@"WKContentWorldConfiguration");
            Class factory = WKContentWorld.class;
            id configuration = configurationClass ? [configurationClass new] : nil;
            if ([configuration respondsToSelector:@selector(setAllowAccessingClosedShadowRoots:)] &&
                [configuration respondsToSelector:@selector(allowAccessingClosedShadowRoots)] &&
                [factory respondsToSelector:@selector(worldWithConfiguration:)]) {
                id<FFClosedRootConfiguration> options = configuration;
                options.allowAccessingClosedShadowRoots = YES;
                if (options.allowAccessingClosedShadowRoots) {
                    world = [(Class<FFConfiguredWorldFactory>)factory worldWithConfiguration:options];
                    observationInspectsClosedRoots = [world isKindOfClass:WKContentWorld.class];
                }
            }
        }
        // Older systems still support text/actions, but cannot request pixels.
        if (!observationInspectsClosedRoots) world = [WKContentWorld worldWithName:@"FarfoldObservation"];
    });
    return world;
}
static NSString *observationProgram(void) {
    return
#include <BrowserObservation.inc>
    ;
}

static BOOL operationLive(FFPublicBrowser *browser, FFReadRequest *request, uint64_t navigation, NSString *url) {
    return browser && !browser.closed && !shutdownStarted && browser.readRequest == request &&
        browser.currentToken == navigation && !browser.view.loading && [browser.view.URL.absoluteString isEqualToString:url];
}
static void finishOperation(FFPublicBrowser *browser, FFReadRequest *request, NSDictionary *value, NSString *error) {
    if (!browser || browser.readRequest != request) return;
    browser.readRequest = nil;
    if (request.retired) return;
    if (error) { [request finish:nil error:error]; return; }
    NSData *data = [NSJSONSerialization isValidJSONObject:value] ? [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL] : nil;
    if (!data || data.length > 550000) { [request finish:nil error:@"网页返回内容过大"]; return; }
    [request finish:[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] error:nil];
}
static NSDictionary *unknownAction(NSString *observationID, BOOL changed) {
    return @{@"applied":NSNull.null,@"outcome":@"unknown",@"reason":@"操作结果未确认，请查看页面后再决定下一步",
             @"pageChanged":@(changed),@"navigationChanged":@(changed),@"observationId":observationID};
}
static void takeObservationSnapshot(FFPublicBrowser *browser, FFReadRequest *request, uint64_t navigation, NSString *url, NSMutableDictionary *result) {
    WKSnapshotConfiguration *configuration = [WKSnapshotConfiguration new];
    NSRect bounds = browser.view.bounds;
    configuration.rect = bounds;
    CGFloat scale = MAX(1.0,browser.view.window.backingScaleFactor);
    configuration.snapshotWidth = @(bounds.size.width * MIN(1.0, 1024.0 / MAX(1.0,MAX(bounds.size.width,bounds.size.height))) / scale);
    configuration.afterScreenUpdates = YES;
    __weak FFPublicBrowser *weakBrowser = browser;
    [browser.view takeSnapshotWithConfiguration:configuration completionHandler:^(NSImage *image, NSError *error) {
        FFPublicBrowser *active = weakBrowser;
        if (!active || active.readRequest != request) return;
        if (request.retired) { finishOperation(active,request,nil,nil); return; }
        if (!operationLive(active,request,navigation,url) || active.view.hidden || !active.view.window || !NSEqualRects(active.view.bounds,bounds)) { finishOperation(active,request,nil,@"网页已变化，请重新观察"); return; }
        NSData *png = nil;
        NSBitmapImageRep *bitmap = image ? [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation] : nil;
        if (bitmap && !error && bitmap.pixelsWide <= 1024 && bitmap.pixelsHigh <= 1024) png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        NSDictionary *screenshot = png && png.length <= 300000 ?
            @{@"status":@"captured",@"mimeType":@"image/png",@"data":[png base64EncodedStringWithOptions:0],@"width":@(bitmap.pixelsWide),@"height":@(bitmap.pixelsHigh)} :
            @{@"status":@"unavailable",@"reason":@"截图未完成或超过大小限制"};
        [active.view callAsyncJavaScript:observationProgram() arguments:@{@"mode":@"check",@"epochSeed":NSUUID.UUID.UUIDString,@"inspectClosedRoots":@YES} inFrame:nil inContentWorld:observationWorld() completionHandler:^(id checked, NSError *checkError) {
            FFPublicBrowser *current = weakBrowser;
            if (!current || current.readRequest != request) return;
            if (request.retired) { finishOperation(current,request,nil,nil); return; }
            if (!operationLive(current,request,navigation,url) || current.view.hidden || !current.view.window || !NSEqualRects(current.view.bounds,bounds) || checkError || ![checked isKindOfClass:NSDictionary.class]) { finishOperation(current,request,nil,@"网页已变化，请重新观察"); return; }
            if ([checked[@"blocked"] boolValue]) { current.observationID = nil; finishOperation(current,request,@{@"blocked":@YES,@"reason":@"页面含敏感输入，请改用公开页面"},nil); return; }
            if (![checked[@"closedRootInspection"] boolValue] ||
                ![checked[@"documentVersion"] isEqual:result[@"documentVersion"]] ||
                ![checked[@"viewport"] isEqual:result[@"viewport"]] || ![checked[@"url"] isEqual:url]) { current.observationID = nil; finishOperation(current,request,nil,@"网页已变化，请重新观察"); return; }
            result[@"screenshot"] = [checked[@"screenshotReason"] isKindOfClass:NSString.class] ? @{@"status":@"unavailable",@"reason":checked[@"screenshotReason"]} : screenshot;
            finishOperation(current,request,result,nil);
        }];
    }];
}
static int32_t startObservation(uint64_t browserID, uint64_t operationID, uint64_t navigation, const char *expectedURL, BOOL screenshot,
                                NSString *observationID, NSString *nodeRef, NSString *kind, NSString *inputText,
                                void *context, FFBrowserRead callback) {
    if (![NSThread isMainThread] || shutdownStarted || !operationID) return 0;
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || browser.closed || browser.localHTML || browser.view.loading || browser.readRequest || !callback) return 0;
    NSString *url = browser.view.URL.absoluteString;
    NSString *expected = expectedURL ? [NSString stringWithUTF8String:expectedURL] : nil;
    if (!navigation || browser.currentToken != navigation || !expected || ![url isEqualToString:expected]) return 2;
    BOOL action = kind != nil;
    if (action && (!browser.observationID || ![browser.observationID isEqual:observationID])) return 3;
    browser.observationID = nil;
    FFReadRequest *request = [FFReadRequest new]; request.operationID = operationID; request.context = context; request.callback = callback; browser.readRequest = request;
    // WebKit supplies these shared-program bindings only. Trusted DOM activity
    // is checked by the program's own captured revision; AppKit userActivity:
    // still cancels the request and advances the page token independently.
    WKContentWorld *world = observationWorld();
    NSMutableDictionary *arguments = [@{@"mode":action ? @"act" : @"observe",@"epochSeed":NSUUID.UUID.UUIDString,@"observationSeed":NSUUID.UUID.UUIDString,@"navigation":[NSString stringWithFormat:@"%llu",(unsigned long long)navigation]} mutableCopy];
    if (action) [arguments addEntriesFromDictionary:@{@"observationId":observationID,@"nodeRef":nodeRef,@"kind":kind,@"inputText":inputText ?: @"",@"deadline":@([NSDate.date timeIntervalSince1970]*1000+5000)}];
    [arguments addEntriesFromDictionary:@{@"inspectClosedRoots":@(screenshot && observationInspectsClosedRoots)}];
    __weak FFPublicBrowser *weakBrowser = browser;
    [browser.view callAsyncJavaScript:observationProgram() arguments:arguments inFrame:nil inContentWorld:world completionHandler:^(id value, NSError *error) {
        FFPublicBrowser *active = weakBrowser;
        if (!active || active.readRequest != request) return;
        if (request.retired) { finishOperation(active,request,nil,nil); return; }
        BOOL live = operationLive(active,request,navigation,url);
        if (action) {
            NSDictionary *result = live && !error && [value isKindOfClass:NSDictionary.class] ? value : unknownAction(observationID,!live);
            finishOperation(active,request,result,nil); return;
        }
        if (!live || error || ![value isKindOfClass:NSDictionary.class]) { finishOperation(active,request,nil,@"网页观察未完成，请查看页面后再试"); return; }
        if (screenshot && (active.view.hidden || !active.view.window)) { finishOperation(active,request,nil,@"网页显示区域已变化，请重新观察"); return; }
        NSMutableDictionary *result = [value mutableCopy];
        if ([result[@"blocked"] boolValue]) { finishOperation(active,request,result,nil); return; }
        active.observationID = result[@"observationId"];
        NSString *reason = [result[@"screenshotReason"] isKindOfClass:NSString.class] ? result[@"screenshotReason"] : nil;
        if (screenshot && (!observationInspectsClosedRoots || ![result[@"closedRootInspection"] boolValue]))
            reason = @"当前系统尚不能可靠检查页面的封闭内容，暂不提供截图";
        [result removeObjectForKey:@"screenshotReason"];
        result[@"screenshot"] = @{@"status":@"unavailable",@"reason":reason ?: @"本次未请求截图"};
        if (!screenshot || reason) finishOperation(active,request,result,nil);
        else takeObservationSnapshot(active,request,navigation,url,result);
    }];
    return 1;
}
int32_t ff_browser_observe(uint64_t browserID, uint64_t operationID, uint64_t navigation, const char *expectedURL, bool screenshot, void *context, FFBrowserRead callback) {
    return startObservation(browserID,operationID,navigation,expectedURL,screenshot,nil,nil,nil,nil,context,callback);
}
int32_t ff_browser_act(uint64_t browserID, uint64_t operationID, uint64_t navigation, const char *expectedURL, const char *observationID,
                      const char *nodeRef, int32_t kind, const char *inputText, void *context, FFBrowserRead callback) {
    NSString *observation = observationID ? [NSString stringWithUTF8String:observationID] : nil;
    NSString *node = nodeRef ? [NSString stringWithUTF8String:nodeRef] : nil;
    NSString *input = inputText ? [NSString stringWithUTF8String:inputText] : @"";
    if (!observation.length || observation.length > 128 || !node.length || node.length > 64 || !input ||
        [input lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 8192 || (kind != 1 && kind != 2)) return 0;
    return startObservation(browserID,operationID,navigation,expectedURL,NO,observation,node,kind == 1 ? @"click" : @"input",input,context,callback);
}

bool ff_browser_cancel_operation(uint64_t browserID, uint64_t operationID) {
    if (![NSThread isMainThread] || !operationID) return false;
    FFPublicBrowser *browser = lookup(browserID);
    FFReadRequest *request = browser.readRequest;
    if (!browser || browser.closed || !request || request.operationID != operationID) return false;
    if (!request.retired) {
        // Retire before invoking a possibly reentrant callback. Keep readRequest
        // while WebKit may still execute: a cancelled receiver is not JS abort.
        request.retired = YES;
        browser.observationID = nil;
        [request finish:nil error:@"网页操作结果未确认，请等待或关闭网页后重新打开"];
    }
    return true;
}

bool ff_browser_close(uint64_t browserID) {
    if (![NSThread isMainThread]) return false;
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser) return true;
    closeDepth++;
    [browser close];
    closeDepth--;
    BOOL acknowledged = browser.closeComplete && !browser.view.superview && !browser.readRequest &&
        !browser.releaseContext && !browser.context;
    if (acknowledged && registry[@(browserID)] == browser) {
        [registry removeObjectForKey:@(browserID)];
    }
    return acknowledged;
}

bool ff_browser_close_all(void) {
    if (![NSThread isMainThread] || closingAll || closeDepth) return false;
    shutdownStarted = YES;
    closingAll = YES;
    // A strong snapshot keeps only our registry owners alive across callbacks.
    // Never enumerate windows, other views, data stores or filesystem profiles.
    NSArray<FFPublicBrowser *> *owners = registry.allValues;
    BOOL acknowledged = YES;
    for (FFPublicBrowser *browser in owners) {
        closeDepth++;
        [browser close];
        closeDepth--;
        if (!browser.closeComplete || browser.view.superview || browser.readRequest ||
            browser.releaseContext || browser.context) acknowledged = NO;
    }
    if (acknowledged) [registry removeAllObjects];
    closingAll = NO;
    return acknowledged && registry.count == 0;
}

// No Tauri script, WKScriptMessageHandler, custom URL scheme, raw eval command,
// browser profile reuse, cookie export or listening port is installed here.
