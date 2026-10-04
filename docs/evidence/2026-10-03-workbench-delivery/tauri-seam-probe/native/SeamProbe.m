#define FF_BROWSER_TEST_FIXTURE
#import "BrowserWorkspace.m"

// Probe-only code. Never linked into Farfold. Only synthetic in-memory HTML.
typedef void (*SeamResult)(void *, const char *);
@interface SeamProbe : NSObject
@property(nonatomic) void *context;
@property(nonatomic) SeamResult result;
@property(nonatomic,strong) NSMutableArray *checks;
@property(nonatomic,strong) NSDictionary *snapshot;
@property(nonatomic) NSUInteger releases;
@property(nonatomic) NSUInteger cancelledReads;
@property(nonatomic) BOOL completed;
@end
@implementation SeamProbe
- (void)add:(NSString *)name pass:(BOOL)pass {
    [self.checks addObject:@{@"name":name,@"pass":@(pass)}];
}
- (void)finish {
    if (self.completed) return;
    self.completed=YES;
    BOOL passed=YES; for (NSDictionary *c in self.checks) passed &= [c[@"pass"] boolValue];
    NSDictionary *report=@{@"kind":@"real-tauri-independent-native-WK-seam",@"pass":@(passed),@"checks":self.checks,@"snapshot":self.snapshot ?: @{},@"scope":@"Real Tauri 2.11.5 main WK, official with_webview, independent WK sibling; only probe-owned commands/channel and in-memory HTML; no Farfold setup, network, profile or account."};
    NSData *data=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
    NSString *text=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    self.result(self.context,text.UTF8String);
}
@end
static SeamProbe *probe;
static const uint64_t browserID=1701;
static bool permit(void *context,const char *url) { return url && strcmp(url,"about:blank")==0; }
static void releaseOwner(void *context) { probe.releases++; }
static void cancelled(void *context,const char *json,const char *error) {
    if (!json && error) probe.cancelledReads++;
}
static void readResult(void *context,const char *json,const char *error) {
    NSDictionary *value=json ? [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil] : nil;
    [probe add:@"isolated_world_returns_actual_child_dom" pass:!error && [value[@"text"] containsString:@"Controlled browser seam 42"]];
    [probe add:@"input_canary_excluded" pass:value && ![value[@"text"] containsString:@"SYNTHETIC_INPUT_CANARY"]];
    probe.snapshot=value;
    BOOL pending=ff_browser_read(browserID,NULL,cancelled);
    [probe add:@"pending_read_accepted_before_close" pass:pending];
    ff_browser_close(browserID);
    [probe add:@"close_cancels_pending_read_without_content" pass:probe.cancelledReads==1];
    [probe add:@"close_releases_once" pass:probe.releases==1];
    [probe add:@"closed_child_rejects_read" pass:!ff_browser_read(browserID,NULL,cancelled)];
    [probe add:@"closed_child_rejects_resize" pass:!ff_browser_resize(browserID,20,80,400,200)];
    ff_browser_close(browserID);
    [probe add:@"repeat_close_is_harmless" pass:probe.releases==1];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,200*NSEC_PER_MSEC),dispatch_get_main_queue(),^{
        [probe add:@"late_native_read_did_not_escape_close" pass:probe.cancelledReads==1];
        [probe finish];
    });
}
static void inspected(void *context,const char *json,const char *error) {
    NSDictionary *value=json ? [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil] : nil;
    [probe add:@"child_has_no_tauri_bridge" pass:value && ![value[@"tauri"] boolValue] && ![value[@"ipc"] boolValue]];
    [probe add:@"child_cannot_reach_tauri_ipc_handler" pass:value && ![value[@"handlerReachable"] boolValue]];
    [probe add:@"child_document_is_distinct" pass:[value[@"count"] isEqual:@"42"]];
    if (!ff_browser_read(browserID,NULL,readResult)) { [probe add:@"snapshot_request_accepted" pass:NO]; [probe finish]; }
}
static void status(void *context,int event,const char *url) {
    if(event==1) ff_browser_test_inspect(browserID,NULL,inspected);
    if(event==2 || event==3) { [probe add:@"controlled_child_load" pass:NO]; ff_browser_close(browserID); [probe finish]; }
}
void ff_seam_start(void *parentWK,void *context,SeamResult result) {
    probe=[SeamProbe new]; probe.context=context; probe.result=result; probe.checks=[NSMutableArray new];
    WKWebView *parent=(__bridge WKWebView *)parentWK;
    [probe add:@"official_with_webview_returned_real_WK" pass:[parent isKindOfClass:WKWebView.class]];
    [probe add:@"real_tauri_parent_uses_nonpersistent_store" pass:!parent.configuration.websiteDataStore.persistent];
    BOOL created=ff_browser_create(browserID,parentWK,20,80,500,260,NULL,permit,status,releaseOwner);
    [probe add:@"independent_child_created" pass:created];
    if(!created) { [probe finish]; return; }
    [probe add:@"same_real_tauri_window_distinct_view" pass:ff_browser_test_same_window(browserID)];
    [probe add:@"child_controller_and_store_independent" pass:ff_browser_test_ephemeral(browserID)];
    [probe add:@"bounds_outside_parent_rejected" pass:!ff_browser_resize(browserID,100000,0,500,200)];
    const char *html="<!doctype html><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'\"><title>Controlled seam page</title><main><h1>Controlled browser seam <span id='count'>42</span></h1><p>Only synthetic probe content.</p><input value='SYNTHETIC_INPUT_CANARY'></main>";
    BOOL loaded=ff_browser_test_load_html(browserID,html);
    [probe add:@"synthetic_in_memory_page_requested" pass:loaded];
    if(!loaded) { ff_browser_close(browserID); [probe finish]; }
}
