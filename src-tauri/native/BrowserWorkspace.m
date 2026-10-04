#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "BrowserWorkspace.h"

// All access is confined to the main thread. Shutdown is intentionally terminal.
static BOOL shutdownStarted;
static BOOL closingAll;
static NSUInteger closeDepth;

@interface FFReadRequest : NSObject
@property(nonatomic) void *context;
@property(nonatomic) FFBrowserRead callback;
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

@interface FFPublicBrowser : NSObject <WKNavigationDelegate, WKUIDelegate>
@property(nonatomic, strong) WKWebView *view;
@property(nonatomic, weak) WKWebView *parent;
@property(nonatomic) void *context;
@property(nonatomic) FFBrowserPolicy policy;
@property(nonatomic) FFBrowserStatus status;
@property(nonatomic) FFBrowserRelease releaseContext;
@property(nonatomic) BOOL closed;
@property(nonatomic) BOOL closeComplete;
@property(nonatomic, strong) FFReadRequest *readRequest;
@property(nonatomic, strong) NSMapTable<WKNavigation *, NSNumber *> *navigationTokens;
@property(nonatomic, strong) WKNavigation *currentNavigation;
@property(nonatomic, copy) NSString *pendingPolicyURL;
@property(nonatomic) uint64_t currentToken;
@property(nonatomic, strong) WKNavigation *redirectNavigation;
- (BOOL)loadRequest:(NSURLRequest *)request token:(uint64_t)token;
- (void)emit:(int)event navigation:(WKNavigation *)navigation url:(NSURL *)url;
- (void)close;
@end

@implementation FFPublicBrowser
- (void)emit:(int)event url:(NSURL *)url {
    if (!shutdownStarted && !self.closed && self.status) self.status(self.context, event, self.currentToken, url.absoluteString.UTF8String);
}
- (BOOL)loadRequest:(NSURLRequest *)request token:(uint64_t)token {
    if (shutdownStarted || self.closed || !token) return NO;
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
static BOOL boundsValid(double x, double y, double width, double height) {
    return isfinite(x) && isfinite(y) && isfinite(width) && isfinite(height) &&
        x >= 0 && y >= 0 && width >= 1 && height >= 1 && width <= 10000 && height <= 10000;
}
static BOOL resize(FFPublicBrowser *browser, double x, double y, double width, double height) {
    WKWebView *parent = browser.parent;
    if (!parent || !parent.superview || !boundsValid(x,y,width,height)) return NO;
    if (x + width > parent.bounds.size.width + 1 || y + height > parent.bounds.size.height + 1) return NO;
    CGFloat localY = parent.isFlipped ? y : parent.bounds.size.height - y - height;
    browser.view.frame = [parent convertRect:NSMakeRect(x, localY, width, height) toView:parent.superview];
    return YES;
}

bool ff_browser_create(uint64_t browserID, void *parent_wk_view, double x, double y,
                       double width, double height, void *context,
                       FFBrowserPolicy policy, FFBrowserStatus status,
                       FFBrowserRelease release) {
    if (![NSThread isMainThread] || shutdownStarted || closeDepth || !parent_wk_view || !boundsValid(x,y,width,height)) return false;
    WKWebView *parent = (__bridge WKWebView *)parent_wk_view;
    if (![parent isKindOfClass:WKWebView.class] || !parent.superview) return false;
    if (!registry) registry = [NSMutableDictionary new];
    if (registry[@(browserID)]) return false;
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
    configuration.userContentController = [WKUserContentController new];
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = NO;
    FFPublicBrowser *browser = [FFPublicBrowser new];
    browser.navigationTokens = [NSMapTable strongToStrongObjectsMapTable];
    browser.parent = parent;
    browser.view = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    browser.view.navigationDelegate = browser;
    browser.view.UIDelegate = browser;
    browser.context = context;
    browser.policy = policy;
    browser.status = status;
    browser.releaseContext = release;
    if (!resize(browser,x,y,width,height)) {
        // Caller retains context ownership on creation failure.
        browser.releaseContext = NULL;
        return false;
    }
    registry[@(browserID)] = browser;
    [parent.superview addSubview:browser.view positioned:NSWindowAbove relativeTo:parent];
    return true;
}

bool ff_browser_navigate(uint64_t browserID, uint64_t navigation, const char *url) {
    if (![NSThread isMainThread] || shutdownStarted) return false;
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || browser.closed || !url) return false;
    NSString *text = [NSString stringWithUTF8String:url];
    NSURL *target = text ? [NSURL URLWithString:text] : nil;
    if (!target || !browser.policy || !browser.policy(browser.context,url)) return false;
    return [browser loadRequest:[NSURLRequest requestWithURL:target] token:navigation];
}

bool ff_browser_resize(uint64_t browserID, double x, double y, double width, double height) {
    if (![NSThread isMainThread] || shutdownStarted) return false;
    FFPublicBrowser *browser = lookup(browserID);
    return browser && !browser.closed && resize(browser,x,y,width,height);
}

bool ff_browser_read(uint64_t browserID, void *context, FFBrowserRead callback) {
    if (![NSThread isMainThread] || shutdownStarted) return false;
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || browser.closed || browser.view.loading || browser.readRequest || !callback) return false;
    FFReadRequest *request = [FFReadRequest new];
    request.context = context;
    request.callback = callback;
    browser.readRequest = request;
    NSString *script = @"(()=>{if(document.querySelector('input[type=password],input[autocomplete=one-time-code],input[autocomplete=current-password],input[autocomplete=new-password]'))return {blocked:true};const copy=document.body?.cloneNode(true);copy?.querySelectorAll('script,style,noscript,input,textarea,select,form,[contenteditable],iframe').forEach(n=>n.remove());return {blocked:false,url:location.href.slice(0,4096),title:document.title.slice(0,512),text:(copy ? copy.textContent : '').slice(0,65536)}})()";
    __weak FFPublicBrowser *weakBrowser = browser;
    [browser.view evaluateJavaScript:script inFrame:nil inContentWorld:[WKContentWorld worldWithName:@"FarfoldPublicReadOnly"] completionHandler:^(id value, NSError *error) {
        FFPublicBrowser *active = weakBrowser;
        if (!active || active.closed || active.readRequest != request) return;
        active.readRequest = nil;
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
