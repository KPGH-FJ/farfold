#import "../../../../src-tauri/native/BrowserWorkspace.m"
@interface InteractionProbe : NSObject<NSApplicationDelegate>
@property NSWindow *window;@property WKWebView *parent;@property NSMutableArray *checks;
@property NSUInteger count;@property NSUInteger callbacks;@property BOOL finished;
- (void)ready;- (void)finish;- (void)check:(NSString *)name pass:(BOOL)pass;
@end
static InteractionProbe *owner(void *p){return (__bridge InteractionProbe *)p;}
static bool allow(void *p,const char *url){return url && !strcmp(url,"http://127.0.0.1:18746/safe");}
static void releaseOwner(void *p){}
static uint64_t status(void *p,int event,uint64_t token,const char *url){if(event==1)dispatch_async(dispatch_get_main_queue(),^{[owner(p) ready];});if(event==6){owner(p).count++;return token+1;}return 0;}
static NSEvent *mouse(FFPublicBrowser *browser,NSPoint local){return [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:[browser.view convertPoint:local toView:nil] modifierFlags:0 timestamp:0 windowNumber:browser.view.window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];}
static void cancelled(void *p,const char *json,const char *error){InteractionProbe *probe=owner(p);probe.callbacks++;[probe check:@"manual_activity_cancels_pending_observation_without_body" pass:json==NULL && error!=NULL];dispatch_async(dispatch_get_main_queue(),^{[probe finish];});}
static void observed(void *p,const char *json,const char *error){
 InteractionProbe *probe=owner(p);NSDictionary *v=json ? [NSJSONSerialization JSONObjectWithData:[@(json) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL]:nil;[probe check:@"observation_ready_before_user_activity" pass:!error && [v[@"nodes"] count]>0];FFPublicBrowser *browser=lookup(97);
 [probe check:@"local_monitor_registered" pass:browser.interactionMonitor!=nil];
 [browser userActivity:mouse(browser,NSMakePoint(500,400))];[probe check:@"outside_approval_area_click_keeps_page_scope" pass:probe.count==0];
 browser.view.hidden=YES;[browser userActivity:mouse(browser,NSMakePoint(40,40))];[probe check:@"hidden_page_click_ignored" pass:probe.count==0];browser.view.hidden=NO;
 [browser userActivity:mouse(browser,NSMakePoint(40,40))];[probe check:@"owned_page_click_advances_navigation_and_clears_node_map" pass:probe.count==1 && browser.currentToken==2 && browser.observationID==nil];
 [probe check:@"old_action_ref_rejected_after_manual_click" pass:ff_browser_act(97,1,"http://127.0.0.1:18746/safe",[v[@"observationId"] UTF8String],"n1",1,"",p,cancelled)==2];
 NSEvent *key=[NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:probe.window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:0];
 [probe.window makeFirstResponder:probe.parent];[browser userActivity:key];[probe check:@"app_composer_keyboard_focus_ignored" pass:probe.count==1];
 [probe.window makeFirstResponder:browser.view];[browser userActivity:key];[probe check:@"page_keyboard_focus_revokes_without_reading_key_data" pass:probe.count==2 && browser.currentToken==3];
 [probe check:@"pending_observation_started" pass:ff_browser_observe(97,3,"http://127.0.0.1:18746/safe",false,p,cancelled)==1];
 [browser userActivity:mouse(browser,NSMakePoint(40,40))];
}
@implementation InteractionProbe
- (void)check:(NSString *)name pass:(BOOL)pass{[self.checks addObject:@{@"name":name,@"pass":@(pass)}];fprintf(stderr,"%s %s\n",pass?"PASS":"FAIL",name.UTF8String);}
- (void)applicationDidFinishLaunching:(NSNotification *)note{self.checks=[NSMutableArray new];self.window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,640,480) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];NSView *container=[[NSView alloc]initWithFrame:NSMakeRect(0,0,640,480)];self.window.contentView=container;self.parent=[[WKWebView alloc]initWithFrame:container.bounds configuration:[WKWebViewConfiguration new]];[container addSubview:self.parent];[self check:@"create" pass:ff_browser_create(97,(__bridge void *)self.parent,0,0,320,300,(__bridge void *)self,allow,status,releaseOwner)];[self check:@"navigate" pass:ff_browser_navigate(97,1,"http://127.0.0.1:18746/safe")];dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_main_queue(),^{if(!self.finished){[self check:@"bounded_finish" pass:NO];[self finish];}});}
- (void)ready{[self check:@"observe" pass:ff_browser_observe(97,1,"http://127.0.0.1:18746/safe",false,(__bridge void *)self,observed)==1];}
- (void)finish{if(self.finished)return;self.finished=YES;FFPublicBrowser *browser=lookup(97);[self check:@"close_removes_monitor" pass:ff_browser_close(97) && browser.interactionMonitor==nil];[self check:@"pending_callback_once" pass:self.callbacks==1];BOOL pass=YES;for(NSDictionary *c in self.checks)if(![c[@"pass"] boolValue])pass=NO;NSDictionary *report=@{@"pass":@(pass),@"checks":self.checks,@"scope":@"Direct synthetic NSEvent objects passed only to the production ownership predicate of this test-owned hidden window. No system keyboard/mouse injection and no user content. Real WebKit observation callback cancellation. Does not claim installed-app event-loop acceptance."};NSData *data=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted|NSJSONWritingSortedKeys error:NULL];[data writeToFile:@"/tmp/farfold-browser-observation-probe/interaction-result.json" atomically:YES];puts([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String);[NSApplication.sharedApplication terminate:nil];}
@end
int main(){@autoreleasepool{NSApplication *app=NSApplication.sharedApplication;[app setActivationPolicy:NSApplicationActivationPolicyProhibited];InteractionProbe *p=[InteractionProbe new];app.delegate=p;[app run];}return 0;}
