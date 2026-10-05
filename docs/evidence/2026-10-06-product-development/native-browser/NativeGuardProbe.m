#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "../../../../src-tauri/native/BrowserWorkspace.h"
@interface GuardProbe : NSObject<NSApplicationDelegate>
@property NSWindow *window;@property WKWebView *parent;@property NSMutableArray *checks;
@property NSUInteger stage;@property BOOL finished;@property(copy) NSString *url;
- (void)next;- (void)ready;- (void)finish;- (void)check:(NSString *)name pass:(BOOL)pass;
@end
static GuardProbe *owner(void *p){return (__bridge GuardProbe *)p;}
static bool policy(void *p,const char *url){return url && [@(url) hasPrefix:@"http://127.0.0.1:18746/"];}
static void releaseOwner(void *p){}
static uint64_t status(void *p,int event,uint64_t token,const char *url){if(event==1)dispatch_async(dispatch_get_main_queue(),^{[owner(p) ready];});return 0;}
static void readResult(void *p,const char *json,const char *error){
 GuardProbe *probe=owner(p);NSDictionary *v=json ? [NSJSONSerialization JSONObjectWithData:[@(json) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL]:nil;
 [probe check:@"guard_observation_completed" pass:!error && v!=nil];
 if(probe.stage==1)[probe check:@"OTP_associated_label_blocks_reading" pass:[v[@"blocked"] boolValue] && !v[@"text"]];
 if(probe.stage==2)[probe check:@"upload_control_blocks_reading" pass:[v[@"blocked"] boolValue] && !v[@"text"]];
 if(probe.stage==3)[probe check:@"open_shadow_DOM_excludes_values_and_blocks_pixels" pass:![v[@"blocked"] boolValue] && ![@(json) containsString:@"SHADOW_SECRET"] && [v[@"screenshot"][@"status"] isEqual:@"unavailable"]];
 if(probe.stage==4)[probe check:@"closed_shadow_DOM_excludes_values_pixels_disabled_by_production_path" pass:![@(json) containsString:@"SHADOW_SECRET"] && [v[@"screenshot"][@"status"] isEqual:@"unavailable"]];
 if(probe.stage==5)[probe check:@"offscreen_and_transparent_text_not_observed" pass:[v[@"text"] containsString:@"Public sample"] && ![v[@"text"] containsString:@"INVISIBLE_PARENT_TEXT"] && ![v[@"text"] containsString:@"OFFSCREEN_TEXT"]];
 [probe next];
}
@implementation GuardProbe
- (void)check:(NSString *)name pass:(BOOL)pass{[self.checks addObject:@{@"name":name,@"pass":@(pass)}];fprintf(stderr,"%s %s\n",pass?"PASS":"FAIL",name.UTF8String);}
- (void)applicationDidFinishLaunching:(NSNotification *)note{
 self.checks=[NSMutableArray new];self.window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,640,480) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];NSView *container=[[NSView alloc]initWithFrame:NSMakeRect(0,0,640,480)];self.window.contentView=container;self.parent=[[WKWebView alloc]initWithFrame:container.bounds configuration:[WKWebViewConfiguration new]];[container addSubview:self.parent];
 [self check:@"guard_create" pass:ff_browser_create(96,(__bridge void *)self.parent,0,0,640,480,(__bridge void *)self,policy,status,releaseOwner)];[self next];dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_main_queue(),^{if(!self.finished){[self check:@"bounded_complete" pass:NO];[self finish];}});
}
- (void)next{self.stage++;NSArray *paths=@[@"/otp",@"/upload",@"/shadow-open",@"/shadow-closed",@"/safe"];if(self.stage>paths.count){[self finish];return;}self.url=[@"http://127.0.0.1:18746" stringByAppendingString:paths[self.stage-1]];[self check:@"guard_navigation" pass:ff_browser_navigate(96,self.stage,self.url.UTF8String)];}
- (void)ready{[self check:@"guard_observation_start" pass:ff_browser_observe(96,self.stage,self.url.UTF8String,self.stage!=4,(__bridge void *)self,readResult)==1];}
- (void)finish{if(self.finished)return;self.finished=YES;[self check:@"guard_close" pass:ff_browser_close(96)];BOOL pass=YES;for(NSDictionary *c in self.checks)if(![c[@"pass"] boolValue])pass=NO;NSDictionary *report=@{@"pass":@(pass),@"checks":self.checks,@"scope":@"Synthetic real WK OTP/upload/open-shadow/offscreen samples. Closed shadow observation uses screenshot=false exactly as hardcoded by production Rust; no claim that native screenshot can identify a closed root. Production pixel delivery is disabled for this reason. No real app or Agent."};NSData *data=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted|NSJSONWritingSortedKeys error:NULL];[data writeToFile:@"/tmp/farfold-browser-observation-probe/guard-result.json" atomically:YES];puts([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String);[NSApplication.sharedApplication terminate:nil];}
@end
int main(){@autoreleasepool{NSApplication *app=NSApplication.sharedApplication;[app setActivationPolicy:NSApplicationActivationPolicyProhibited];GuardProbe *p=[GuardProbe new];app.delegate=p;[app run];}return 0;}
