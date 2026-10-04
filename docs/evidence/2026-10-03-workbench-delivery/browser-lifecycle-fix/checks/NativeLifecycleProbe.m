#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <pthread.h>
#import "../native/BrowserWorkspace.h"
extern bool ff_browser_test_navigation_callbacks(uint64_t);
@interface Probe : NSObject <NSApplicationDelegate>
@property(nonatomic,strong) NSWindow *window;
@property(nonatomic,strong) WKWebView *parent;
@property(nonatomic,strong) NSMutableArray *events;
@property(nonatomic,strong) NSMutableArray *checks;
@property(nonatomic) NSUInteger releases;
@property(nonatomic) BOOL finished;
- (void)check:(NSString *)name pass:(BOOL)pass;
- (void)finish;
@end
static Probe *owner(void *context){return (__bridge Probe *)context;}
static void *off_main_close(void *result){*(bool *)result=ff_browser_close(77);return NULL;}
static bool policy(void *context,const char *url){return url && !strcmp(url,"about:blank");}
static void released(void *context){owner(context).releases++;}
static uint64_t status(void *context,int event,uint64_t token,const char *url){
 Probe *p=owner(context);[p.events addObject:@{@"event":@(event),@"token":@(token)}];
 if(event==1 && token==43)dispatch_async(dispatch_get_main_queue(),^{[p check:@"real_about_blank_loadRequest_finishes_with_assigned_token" pass:YES];[p finish];});
 return 0;
}
@implementation Probe
- (void)check:(NSString *)name pass:(BOOL)pass{[self.checks addObject:@{@"name":name,@"pass":@(pass)}];}
- (void)applicationDidFinishLaunching:(NSNotification *)notification{
 self.events=[NSMutableArray new];self.checks=[NSMutableArray new];
 self.window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,640,480) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
 NSView *container=[[NSView alloc] initWithFrame:NSMakeRect(0,0,640,480)];self.window.contentView=container;
 WKWebViewConfiguration *config=[WKWebViewConfiguration new];config.websiteDataStore=WKWebsiteDataStore.nonPersistentDataStore;
 self.parent=[[WKWebView alloc] initWithFrame:container.bounds configuration:config];[container addSubview:self.parent];
 [self check:@"create_ack_success" pass:ff_browser_create(77,(__bridge void *)self.parent,0,0,640,480,(__bridge void *)self,policy,status,released)];
 [self check:@"actual_WKNavigation_objects_via_production_loadRequest" pass:ff_browser_test_navigation_callbacks(77)];
 NSArray *expected=@[@{@"event":@1,@"token":@41},@{@"event":@2,@"token":@41},@{@"event":@3,@"token":@41},@{@"event":@1,@"token":@42}];
 [self check:@"late_finish_and_fail_keep_old_object_token_duplicate_ignored" pass:[self.events isEqual:expected]];
 bool wrongThreadACK=true;pthread_t worker;int started=pthread_create(&worker,NULL,off_main_close,&wrongThreadACK);if(!started)pthread_join(worker,NULL);
 [self check:@"off_main_close_has_no_success_ack" pass:!started && !wrongThreadACK];
 [self check:@"failed_close_retains_native_owner" pass:self.releases==0 && ff_browser_resize(77,0,0,400,300)];
 [self check:@"actual_async_request_accepted" pass:ff_browser_navigate(77,43,"about:blank")];
 dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_main_queue(),^{if(!self.finished){[self check:@"actual_navigation_bounded_completion" pass:NO];[self finish];}});
}
- (void)finish{
 if(self.finished)return;self.finished=YES;
 [self check:@"close_ack_after_cleanup" pass:ff_browser_close(77) && self.releases==1];
 [self check:@"duplicate_close_ack_idempotent" pass:ff_browser_close(77) && self.releases==1];
 [self check:@"closed_registry_rejects_navigation" pass:!ff_browser_navigate(77,44,"about:blank")];
 BOOL pass=YES;for(NSDictionary *c in self.checks)if(![c[@"pass"] boolValue])pass=NO;
 NSDictionary *report=@{@"pass":@(pass),@"checks":self.checks,@"events":self.events,@"scope":@"Standalone hidden synthetic NSWindow; real WKNavigation objects returned by production loadRequest; stale terminal callbacks deliberately injected; separate real asynchronous about:blank finish. No network, real app, account, Tauri command dispatch or MCP/Agent."};
 NSData *data=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted|NSJSONWritingSortedKeys error:NULL];
 [data writeToFile:@"checks/native-lifecycle-result.json" atomically:YES];puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
 [self.window orderOut:nil];[NSApplication.sharedApplication terminate:nil];
}
@end
int main(){@autoreleasepool{NSApplication *app=NSApplication.sharedApplication;[app setActivationPolicy:NSApplicationActivationPolicyProhibited];Probe *p=[Probe new];app.delegate=p;[app run];}return 0;}
