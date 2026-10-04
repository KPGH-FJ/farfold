#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "/Users/tw/Desktop/farfold/src-tauri/native/BrowserWorkspace.h"

static int checks, failures, released, events;
static void check(BOOL pass, NSString *name) {
    checks++;
    if (!pass) failures++;
    printf("%s %s\n", pass ? "PASS" : "FAIL", name.UTF8String);
}
static bool policy(void *context, const char *url) { return true; }
static uint64_t status(void *context, int event, uint64_t navigation, const char *url) { events++; return 1; }
static void releaseContext(void *context) { released++; }
static BOOL spin(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
}
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(-10000,-10000,800,600) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        WKWebView *parent = [[WKWebView alloc] initWithFrame:NSMakeRect(0,0,800,600) configuration:configuration];
        [window.contentView addSubview:parent];
        check(ff_browser_create(301, (__bridge void *)parent, 100,100,400,300,NULL,policy,status,releaseContext), @"create owned blank WK surface");
        WKWebView *child = nil;
        for (NSView *view in window.contentView.subviews) if (view != parent && [view isKindOfClass:WKWebView.class]) child = (WKWebView *)view;
        check(child && !child.hidden, @"initial surface is actually visible");
        __block BOOL seeded = NO;
        [child evaluateJavaScript:@"document.body.innerHTML='<h1>Visibility fixture</h1>'; window.fixtureValue='kept'; 'seeded'" completionHandler:^(id value, NSError *error) { seeded = !error && [value isEqual:@"seeded"]; }];
        check(spin(^BOOL { return seeded; }), @"seed synthetic document without navigation or network");
        int previousEvents = events;
        check(ff_browser_set_visible(301,false,0,0,0,0) && child.hidden, @"hide ACK matches actual NSView hidden state");
        check(child.superview == parent.superview && released == 0, @"hide preserves same attached owner and page");
        check(ff_browser_set_visible(301,false,0,0,0,0), @"repeat hide remains acknowledged");
        check(!ff_browser_set_visible(301,true,700,100,400,300) && child.hidden, @"invalid restore remains hidden");
        check(ff_browser_set_visible(301,true,200,150,350,250) && !child.hidden, @"restore ACK shows same page at fresh valid bounds");
        check(child.frame.size.width == 350 && child.frame.size.height == 250, @"restored frame uses new dimensions");
        __block BOOL preserved = NO;
        [child evaluateJavaScript:@"window.fixtureValue==='kept' && document.querySelector('h1').textContent==='Visibility fixture'" completionHandler:^(id value, NSError *error) { preserved = !error && [value boolValue]; }];
        check(spin(^BOOL { return preserved; }), @"document and page state survive hide and restore");
        check(events == previousEvents && released == 0, @"presentation emits no navigation or release callbacks");
        check(!ff_browser_set_visible(999,true,0,0,20,20), @"unknown owner cannot be shown");
        check(ff_browser_set_visible(301,false,0,0,0,0) && ff_browser_close(301), @"hidden page still closes with real acknowledgement");
        check(!child.superview && released == 1, @"close detaches and releases exactly once");
        check(!ff_browser_set_visible(301,true,100,100,400,300), @"late restore cannot revive a closed owner");
        check(ff_browser_create(302, (__bridge void *)parent, 100,100,400,300,NULL,policy,status,releaseContext), @"a new owner can replace the closed one");
        check(!ff_browser_set_visible(301,false,0,0,0,0), @"stale hide cannot affect replacement owner");
        check(ff_browser_close_all() && released == 2 && !ff_browser_set_visible(302,true,100,100,400,300), @"shutdown retires visibility controls");
        printf("RESULT %d/%d passed\n", checks-failures, checks);
        return failures ? 1 : 0;
    }
}
