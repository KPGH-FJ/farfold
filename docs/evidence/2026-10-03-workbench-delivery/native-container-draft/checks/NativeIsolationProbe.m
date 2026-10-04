#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "../native/BrowserWorkspace.h"

extern bool ff_browser_test_load_html(uint64_t,const char *);
extern void ff_browser_test_inspect(uint64_t,void *,FFBrowserRead);
extern bool ff_browser_test_same_window(uint64_t);
extern bool ff_browser_test_ephemeral(uint64_t);

@interface Probe : NSObject <NSApplicationDelegate,WKNavigationDelegate,WKScriptMessageHandler>
@property(nonatomic,strong) NSWindow *window;
@property(nonatomic,strong) WKWebView *main;
@property(nonatomic,strong) NSMutableArray *checks;
@property(nonatomic,strong) NSString *directory;
@property(nonatomic) NSUInteger handlerCalls;
@property(nonatomic) NSUInteger releaseCalls;
@property(nonatomic) BOOL started;
@property(nonatomic) BOOL finished;
- (void)check:(NSString *)name pass:(BOOL)pass;
- (void)inspect:(const char *)json error:(const char *)error;
- (void)read:(const char *)json error:(const char *)error;
- (void)finish;
@end

static Probe *owner(void *context) { return (__bridge Probe *)context; }
static bool policy(void *context,const char *url) { return url && strcmp(url,"about:blank")==0; }
static void inspected(void *context,const char *json,const char *error) { [owner(context) inspect:json error:error]; }
static void readResult(void *context,const char *json,const char *error) { [owner(context) read:json error:error]; }
static void released(void *context) { owner(context).releaseCalls++; }
static void status(void *context,int event,const char *url) {
    if (event==1) ff_browser_test_inspect(100,context,inspected);
}

@implementation Probe
- (void)check:(NSString *)name pass:(BOOL)pass { [self.checks addObject:@{@"name":name,@"pass":@(pass)}]; }
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.checks=[NSMutableArray new];
    WKWebViewConfiguration *configuration=[WKWebViewConfiguration new];
    configuration.websiteDataStore=WKWebsiteDataStore.nonPersistentDataStore;
    [configuration.userContentController addScriptMessageHandler:self name:@"ipc"];
    [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:@"window.__TAURI_INTERNALS__={syntheticCanary:'HOST_ONLY'};window.ipc={synthetic:true};" injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    self.main=[[WKWebView alloc] initWithFrame:NSMakeRect(0,0,800,560) configuration:configuration];
    self.main.navigationDelegate=self;
    self.window=[[NSWindow alloc] initWithContentRect:self.main.frame styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    self.window.title=@"Farfold independent WK container — controlled fixture";
    self.window.contentView=self.main;
    [self.window center];[self.window makeKeyAndOrderFront:nil];
    [self.main loadHTMLString:@"<html><body><h1>Controlled parent view</h1><p>No real app data, no network.</p></body></html>" baseURL:nil];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_SEC),dispatch_get_main_queue(),^{if(!self.finished){[self check:@"bounded_execution" pass:NO];[self finish];}});
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message { self.handlerCalls++; }
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    if(self.started)return;self.started=YES;
    [self.main evaluateJavaScript:@"Boolean(window.__TAURI_INTERNALS__ && window.ipc && window.webkit.messageHandlers.ipc)" completionHandler:^(id value,NSError *error){
        [self check:@"controlled_parent_has_synthetic_bridge" pass:!error && [value boolValue]];
        bool created=ff_browser_create(100,(__bridge void *)self.main,24,120,752,400,(__bridge void *)self,policy,status,released);
        [self check:@"native_sibling_created" pass:created];
        [self check:@"same_window_distinct_view" pass:ff_browser_test_same_window(100)];
        [self check:@"separate_controller_and_ephemeral_store" pass:ff_browser_test_ephemeral(100)];
        bool loaded=ff_browser_test_load_html(100,"<!doctype html><html><head><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline';script-src 'unsafe-inline';connect-src 'none'\"></head><body style='font:20px system-ui;padding:25px;background:#edf7ef'><h1>Independent native WK child</h1><p>No application IPC bridge.</p><p id='count'>Visible native child result</p><input value='SYNTHETIC_INPUT_EXCLUDED'></body></html>");
        [self check:@"controlled_page_requested" pass:loaded];
        if(!created||!loaded)[self finish];
    }];
}
- (void)inspect:(const char *)json error:(const char *)error {
    NSDictionary *result=json?[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL]:nil;
    [self check:@"child_page_world_has_no_tauri_bridge" pass:!error && result && ![result[@"tauri"] boolValue] && ![result[@"ipc"] boolValue]];
    [self check:@"child_cannot_reach_parent_ipc_handler" pass:result && ![result[@"handlerReachable"] boolValue] && self.handlerCalls==0];
    [self check:@"native_child_has_own_document" pass:[result[@"count"] isEqual:@"Visible native child result"]];
    [self check:@"outside_bounds_rejected" pass:!ff_browser_resize(100,24,120,9000,400)];
    [self check:@"snapshot_request_accepted" pass:ff_browser_read(100,(__bridge void *)self,readResult)];
}
- (void)read:(const char *)json error:(const char *)error {
    NSDictionary *result=json?[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL]:nil;
    NSString *text=result[@"text"];
    [self check:@"isolated_world_read_returns_real_dom" pass:!error && [text containsString:@"Visible native child result"]];
    [self check:@"input_values_not_returned" pass:![text containsString:@"SYNTHETIC_INPUT_EXCLUDED"]];
    ff_browser_close(100);
    [self check:@"close_releases_owner_once" pass:self.releaseCalls==1];
    [self check:@"closed_child_cannot_read" pass:!ff_browser_read(100,NULL,readResult)];
    [self check:@"closed_child_cannot_resize" pass:!ff_browser_resize(100,0,0,100,100)];
    ff_browser_close(100);
    [self check:@"duplicate_close_is_harmless" pass:self.releaseCalls==1];
    [self finish];
}
- (void)finish {
    if(self.finished)return;self.finished=YES;
    ff_browser_close(100);
    BOOL pass=YES;for(NSDictionary *check in self.checks){if(![check[@"pass"] boolValue])pass=NO;}
    NSDictionary *report=@{@"kind":@"independent-native-WK-sibling",@"pass":@(pass),@"checks":self.checks,@"scope":@"Real WebKit parent and separate sibling in one NSWindow. Parent bridge is synthetic; no Tauri process, real channel, network, account or Agent.",@"limitations":@[@"Tauri with_webview integration remains untested",@"No public site, login, cross-origin frame or arbitrary navigation coverage",@"No OS/network sandbox claim"]};
    NSData *data=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted|NSJSONWritingSortedKeys error:NULL];
    [data writeToFile:[self.directory stringByAppendingPathComponent:@"native-isolation-result.json"] atomically:YES];
    puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    [self.main.configuration.userContentController removeScriptMessageHandlerForName:@"ipc"];
    [self.window orderOut:nil];[NSApplication.sharedApplication terminate:nil];
}
@end

int main(int argc,const char *argv[]) {
    @autoreleasepool {
        if(argc!=2)return 2;
        NSApplication *app=NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        Probe *probe=[Probe new];probe.directory=[NSString stringWithUTF8String:argv[1]];
        app.delegate=probe;[app run];
    }
    return 0;
}
