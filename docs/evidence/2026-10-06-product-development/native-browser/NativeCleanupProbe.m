#import <AppKit/AppKit.h>
#import "../../../../src-tauri/native/BrowserWorkspace.h"
static NSUInteger pending=6, failures=0;
static void done(void *context,const char *json,const char *error){if(!json || error)failures++;if(--pending==0){printf("{\"fixtureStoresCleared\":6,\"failures\":%lu}\n",(unsigned long)failures);[NSApplication.sharedApplication terminate:nil];}}
@interface CleanupProbe:NSObject<NSApplicationDelegate>@end
@implementation CleanupProbe
- (void)applicationDidFinishLaunching:(NSNotification *)note{NSArray *stores=@[@"637a301d-6c8c-40a0-9bc5-b9bb7b16b1f7",@"96479c34-c10a-4308-8d81-4b7a13ee0977",@"d1f7ec2f-6e61-4a4e-8a17-4e2f35f1d639",@"7c5c9991-b680-41ae-ad33-66a47ca49c90",@"62781cd5-fb1f-44ab-a1a3-e6597473d250",@"47831cda-62d4-45d7-9b7c-319f647be5f8"];for(NSString *store in stores)if(!ff_browser_clear_html_storage(store.UTF8String,NULL,done))done(NULL,NULL,"not started");dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_main_queue(),^{if(pending){printf("{\"incomplete\":%lu}\n",(unsigned long)pending);[NSApplication.sharedApplication terminate:nil];}});}
@end
int main(){@autoreleasepool{NSApplication *app=NSApplication.sharedApplication;[app setActivationPolicy:NSApplicationActivationPolicyProhibited];CleanupProbe *p=[CleanupProbe new];app.delegate=p;[app run];}return 0;}
