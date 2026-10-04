#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "BrowserWorkspace.h"

@interface FFReadRequest : NSObject
@property(nonatomic) void *context;
@property(nonatomic) FFBrowserRead callback;
- (void)finish:(NSString *)json error:(NSString *)error;
@end
@implementation FFReadRequest
- (void)finish:(NSString *)json error:(NSString *)error {
    FFBrowserRead callback = self.callback;
    self.callback = NULL;
    if (callback) callback(self.context, json.UTF8String, error.UTF8String);
    self.context = NULL;
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
@property(nonatomic, strong) FFReadRequest *readRequest;
- (void)close;
@end

@implementation FFPublicBrowser
- (void)emit:(int)event url:(NSURL *)url {
    if (!self.closed && self.status) self.status(self.context, event, url.absoluteString.UTF8String);
}
- (void)close {
    if (self.closed) return;
    self.closed = YES;
    [self.view stopLoading];
    self.view.navigationDelegate = nil;
    self.view.UIDelegate = nil;
    [self.view removeFromSuperview];
    [self.readRequest finish:nil error:@"网页已关闭，读取已取消"];
    self.readRequest = nil;
    self.policy = NULL;
    self.status = NULL;
    if (self.releaseContext) self.releaseContext(self.context);
    self.releaseContext = NULL;
    self.context = NULL;
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    if (action.targetFrame && !action.targetFrame.isMainFrame) { decisionHandler(WKNavigationActionPolicyCancel); return; }
    BOOL allowed = !self.closed && action.targetFrame != nil && self.policy &&
        self.policy(self.context, action.request.URL.absoluteString.UTF8String);
    if (@available(macOS 11.3, *)) {
        if (action.shouldPerformDownload) allowed = NO;
    }
    if (!allowed) [self emit:3 url:nil];
    decisionHandler(allowed ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationResponse:(WKNavigationResponse *)response decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
    if (!response.canShowMIMEType) [self emit:3 url:nil];
    decisionHandler(!self.closed && response.canShowMIMEType ? WKNavigationResponsePolicyAllow : WKNavigationResponsePolicyCancel);
}
- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation { [self emit:0 url:webView.URL]; }
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation { [self emit:1 url:webView.URL]; }
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self emit:2 url:nil]; }
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    // Policy cancellation already has a specific blocked state.
    if (error.code != NSURLErrorCancelled) [self emit:2 url:nil];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView { [self emit:2 url:nil]; }
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
    if (![NSThread isMainThread] || !parent_wk_view || !boundsValid(x,y,width,height)) return false;
    WKWebView *parent = (__bridge WKWebView *)parent_wk_view;
    if (![parent isKindOfClass:WKWebView.class] || !parent.superview) return false;
    if (!registry) registry = [NSMutableDictionary new];
    if (registry[@(browserID)]) return false;
    WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
    configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
    configuration.userContentController = [WKUserContentController new];
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = NO;
    FFPublicBrowser *browser = [FFPublicBrowser new];
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

bool ff_browser_navigate(uint64_t browserID, const char *url) {
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || browser.closed || !url) return false;
    NSString *text = [NSString stringWithUTF8String:url];
    NSURL *target = text ? [NSURL URLWithString:text] : nil;
    if (!target || !browser.policy || !browser.policy(browser.context,url)) return false;
    [browser.view loadRequest:[NSURLRequest requestWithURL:target]];
    return true;
}

bool ff_browser_resize(uint64_t browserID, double x, double y, double width, double height) {
    FFPublicBrowser *browser = lookup(browserID);
    return browser && !browser.closed && resize(browser,x,y,width,height);
}

bool ff_browser_read(uint64_t browserID, void *context, FFBrowserRead callback) {
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

void ff_browser_close(uint64_t browserID) {
    FFPublicBrowser *browser = lookup(browserID);
    [browser close];
    [registry removeObjectForKey:@(browserID)];
}

#ifdef FF_BROWSER_TEST_FIXTURE
// Compiled only in the standalone native fixture, never in the application.
bool ff_browser_test_load_html(uint64_t browserID, const char *html) {
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || browser.closed || !html) return false;
    [browser.view loadHTMLString:[NSString stringWithUTF8String:html] baseURL:nil];
    return true;
}
void ff_browser_test_inspect(uint64_t browserID, void *context, FFBrowserRead callback) {
    FFPublicBrowser *browser = lookup(browserID);
    if (!browser || browser.closed) { callback(context,NULL,"closed"); return; }
    NSString *script = @"(()=>{let reached=false;try{window.webkit.messageHandlers.ipc.postMessage({synthetic:true});reached=true}catch(e){};return {tauri:typeof window.__TAURI_INTERNALS__!=='undefined',ipc:typeof window.ipc!=='undefined',handlerReachable:reached,count:document.getElementById('count')?.textContent}})()";
    [browser.view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        if (error || ![NSJSONSerialization isValidJSONObject:value]) { callback(context,NULL,"inspect-failed"); return; }
        NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
        callback(context,[[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] UTF8String],NULL);
    }];
}
bool ff_browser_test_same_window(uint64_t browserID) { FFPublicBrowser *b=lookup(browserID); return b && b.view.window==b.parent.window && b.view.superview==b.parent.superview && b.view!=b.parent; }
bool ff_browser_test_ephemeral(uint64_t browserID) { FFPublicBrowser *b=lookup(browserID); return b && !b.view.configuration.websiteDataStore.persistent && b.view.configuration.userContentController!=b.parent.configuration.userContentController; }
#endif

// No Tauri script, WKScriptMessageHandler, custom URL scheme, raw eval command,
// browser profile reuse, cookie export or listening port is installed here.
