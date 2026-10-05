#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "../../../../src-tauri/native/BrowserWorkspace.h"
@interface Probe : NSObject<NSApplicationDelegate>
@property NSWindow *window;
@property WKWebView *parent;
@property NSMutableArray *checks;
@property(copy) NSString *url;
@property uint64_t token;
@property NSUInteger stage;
@property BOOL finished;
@property(copy) void (^completion)(NSDictionary *,NSString *);
- (void)check:(NSString *)label pass:(BOOL)pass;
- (void)ready;
- (void)finish;
@end
static Probe *owner(void *p){return (__bridge Probe *)p;}
static bool policy(void *p,const char *url){return url && [@(url) hasPrefix:@"http://127.0.0.1:18746/"];}
static void releaseOwner(void *p){}
static uint64_t status(void *p,int event,uint64_t token,const char *url){
 if(event==1 && owner(p).token==token) dispatch_async(dispatch_get_main_queue(),^{[owner(p) ready];});return 0;
}
static void result(void *p,const char *json,const char *error){
 Probe *probe=owner(p);if(json && probe.stage==1)[[@(json) dataUsingEncoding:NSUTF8StringEncoding] writeToFile:@"/tmp/farfold-browser-observation-probe/observation-wire.json" atomically:YES];NSDictionary *value=json ? [NSJSONSerialization JSONObjectWithData:[@(json) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL] : nil;
 void (^completion)(NSDictionary *,NSString *)=probe.completion;probe.completion=nil;if(completion)completion(value,error ? @(error):nil);
}
@implementation Probe
- (void)check:(NSString *)label pass:(BOOL)pass{[self.checks addObject:@{@"name":label,@"pass":@(pass)}];fprintf(stderr,"%s %s\n",pass?"PASS":"FAIL",label.UTF8String);}
- (void)load:(NSString *)path{self.token++;self.url=[@"http://127.0.0.1:18746" stringByAppendingString:path];[self check:@"production_navigation_started" pass:ff_browser_navigate(91,self.token,self.url.UTF8String)];}
- (void)observe:(BOOL)screenshot then:(void (^)(NSDictionary *,NSString *))completion{self.completion=completion;int code=ff_browser_observe(91,self.token,self.url.UTF8String,screenshot,(__bridge void *)self,result);[self check:@"observation_started" pass:code==1];if(code!=1)[self finish];}
- (void)act:(NSDictionary *)snapshot node:(NSString *)node kind:(int)kind text:(NSString *)text then:(void (^)(NSDictionary *,NSString *))completion{self.completion=completion;int code=ff_browser_act(91,self.token,self.url.UTF8String,[snapshot[@"observationId"] UTF8String],node.UTF8String,kind,text.UTF8String,(__bridge void *)self,result);[self check:@"fixed_action_started" pass:code==1];if(code!=1)[self finish];}
- (void)applicationDidFinishLaunching:(NSNotification *)note{
 self.checks=[NSMutableArray new];self.window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,640,480) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
 self.parent=[[WKWebView alloc]initWithFrame:NSMakeRect(0,0,640,480) configuration:[WKWebViewConfiguration new]];NSView *container=[[NSView alloc]initWithFrame:NSMakeRect(0,0,640,480)];self.window.contentView=container;[container addSubview:self.parent];
 [self check:@"create" pass:ff_browser_create(91,(__bridge void *)self.parent,0,0,640,480,(__bridge void *)self,policy,status,releaseOwner)];
 [self load:@"/safe"];dispatch_after(dispatch_time(DISPATCH_TIME_NOW,50*NSEC_PER_SEC),dispatch_get_main_queue(),^{if(!self.finished){[self check:@"bounded_finish" pass:NO];[self finish];}});
}
- (void)ready{
 if(self.stage==0){self.stage=1;[self observe:YES then:^(NSDictionary *snapshot,NSString *error){
  [self check:@"safe_dom_visible_text" pass:!error && [snapshot[@"text"] containsString:@"Public sample"] && [snapshot[@"nodes"] count]==1];
  NSDictionary *shot=snapshot[@"screenshot"];NSData *png=[[NSData alloc]initWithBase64EncodedString:shot[@"data"] ?: @"" options:0];
  [self check:@"real_webkit_png_bounded" pass:[shot[@"status"] isEqual:@"captured"] && png.length>100 && png.length<=300000 && [NSBitmapImageRep imageRepWithData:png]!=nil];
  [png writeToFile:@"/tmp/farfold-browser-observation-probe/snapshot.png" atomically:YES];
  [self act:snapshot node:@"n1" kind:1 text:@"" then:^(NSDictionary *reply,NSString *failure){
   [self check:@"click_dispatch_and_dom_version_changed" pass:!failure && [reply[@"applied"] boolValue] && [reply[@"outcome"] isEqual:@"dispatched"] && [reply[@"pageChanged"] boolValue]];
   [self check:@"node_one_use_native_rejection" pass:ff_browser_act(91,self.token,self.url.UTF8String,[snapshot[@"observationId"] UTF8String],"n1",1,"",(__bridge void *)self,result)==3];
   [self observe:NO then:^(NSDictionary *after,NSString *unused){[self check:@"click_visible_effect" pass:[after[@"text"] containsString:@"Clicked once"]];[self load:@"/input"];}];
  }];
 }];return;}
 if(self.stage==1){self.stage=2;[self observe:YES then:^(NSDictionary *snapshot,NSString *error){
  [self check:@"editable_page_dom_available_screenshot_refused" pass:!error && ![snapshot[@"blocked"] boolValue] && [snapshot[@"screenshot"][@"status"] isEqual:@"unavailable"]];
  [self act:snapshot node:@"n1" kind:2 text:@"Private ordinary draft" then:^(NSDictionary *reply,NSString *failure){
   [self check:@"fixed_input_dispatched" pass:!failure && [reply[@"applied"] boolValue]];
   [self observe:NO then:^(NSDictionary *after,NSString *unused){NSString *json=[[NSString alloc]initWithData:[NSJSONSerialization dataWithJSONObject:after ?: @{} options:0 error:NULL] encoding:NSUTF8StringEncoding];[self check:@"filled_value_not_observed" pass:![json containsString:@"Private ordinary draft"]];[self load:@"/stale"];}];
  }];
 }];return;}
 if(self.stage==2){self.stage=3;[self observe:NO then:^(NSDictionary *snapshot,NSString *error){
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,1500*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[self act:snapshot node:@"n1" kind:1 text:@"" then:^(NSDictionary *reply,NSString *failure){[self check:@"mutated_dom_reference_rejected" pass:!failure && ![reply[@"applied"] boolValue] && [reply[@"outcome"] isEqual:@"rejected"]];[self load:@"/secret"];}];});
 }];return;}
 if(self.stage==3){self.stage=4;[self observe:YES then:^(NSDictionary *snapshot,NSString *error){[self check:@"password_page_blocked_without_values" pass:!error && [snapshot[@"blocked"] boolValue] && !snapshot[@"text"] && !snapshot[@"screenshot"]];[self load:@"/frame"];}];return;}
 if(self.stage==4){self.stage=5;[self observe:YES then:^(NSDictionary *snapshot,NSString *error){[self check:@"frame_pixels_refused_dom_kept" pass:!error && [snapshot[@"text"] containsString:@"Embedded page"] && [snapshot[@"screenshot"][@"status"] isEqual:@"unavailable"]];[self load:@"/safe"];}];return;}
 if(self.stage==5){self.stage=6;[self observe:NO then:^(NSDictionary *snapshot,NSString *error){
  [self check:@"wrong_navigation_rejected_before_js" pass:ff_browser_act(91,self.token-1,self.url.UTF8String,[snapshot[@"observationId"] UTF8String],"n1",1,"",(__bridge void *)self,result)==2];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,31*NSEC_PER_SEC),dispatch_get_main_queue(),^{[self act:snapshot node:@"n1" kind:1 text:@"" then:^(NSDictionary *reply,NSString *failure){[self check:@"thirty_second_ref_expired" pass:!failure && [reply[@"outcome"] isEqual:@"rejected"]];self.stage=7;[self observe:NO then:^(NSDictionary *stale,NSString *staleError){[self check:@"navigate_during_async_observation_rejects_late_content" pass:staleError!=nil && stale==nil];self.stage=8;[self load:@"/safe"];}];[self load:@"/input"];}];});
 }];return;}
 if(self.stage==8){self.stage=9;[self observe:NO then:^(NSDictionary *late,NSString *error){[self check:@"close_cancels_pending_callback_without_content" pass:error!=nil && late==nil];dispatch_async(dispatch_get_main_queue(),^{[self finish];});}];[self check:@"close_during_async_observation_ack" pass:ff_browser_close(91)];}
}
- (void)finish{
 if(self.finished)return;self.finished=YES;[self check:@"close_ack" pass:ff_browser_close(91)];
 BOOL pass=YES;for(NSDictionary *item in self.checks)if(![item[@"pass"] boolValue])pass=NO;
 NSDictionary *report=@{@"pass":@(pass),@"checks":self.checks,@"scope":@"Standalone synthetic NSWindow and owned loopback fixture. Production native WebKit observation/action entrypoints; fixture policy authorizes only its own loopback origin. Does not prove production public URL policy, Tauri/MCP permission UI, real websites/Agents/accounts, trusted user gestures, or installed app."};
 NSData *data=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted|NSJSONWritingSortedKeys error:NULL];[data writeToFile:@"/tmp/farfold-browser-observation-probe/result.json" atomically:YES];puts([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String);[self.window orderOut:nil];[NSApplication.sharedApplication terminate:nil];
}
@end
int main(){@autoreleasepool{NSApplication *app=NSApplication.sharedApplication;[app setActivationPolicy:NSApplicationActivationPolicyProhibited];Probe *p=[Probe new];app.delegate=p;[app run];}return 0;}
