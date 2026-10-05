#import "../../../../src-tauri/native/BrowserWorkspace.m"
@interface PreviewProbe : NSObject<NSApplicationDelegate>
@property NSWindow *window;
@property WKWebView *parent;
@property NSMutableArray *checks;
@property NSMutableSet *requests;
@property BOOL finished;
@property NSUInteger stage;
@property uint64_t delayed;
@property(copy) void (^observed)(void);
- (void)check:(NSString *)label pass:(BOOL)pass;
- (void)ready;
- (void)finish;
@end
static PreviewProbe *owner(void *p){return (__bridge PreviewProbe *)p;}
static bool allow(void *p,const char *url){NSString *s=url ? @(url):@"";return [s hasPrefix:@"ff-preview://preview-92/"] || [s hasPrefix:@"http://127.0.0.1:18746/"];}
static void released(void *p){}
static uint64_t status(void *p,int event,uint64_t token,const char *url){if(event==1)dispatch_async(dispatch_get_main_queue(),^{[owner(p) ready];});return 0;}
static NSString *csp=@"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
static void resource(void *p,uint64_t request,const char *url){
 PreviewProbe *probe=owner(p);NSString *path=[NSURL URLWithString:@(url)].path;[probe.requests addObject:path];NSString *value=nil;NSString *mime=nil;
 if([path isEqual:@"/index.html"]){mime=@"text/html; charset=utf-8";value=[NSString stringWithFormat:@"<!doctype html><meta http-equiv='Content-Security-Policy' content=\"%@\"><h1>Directory sample</h1><link rel='stylesheet' href='style.css'><script src='main.js'></script><img src='image.svg'>",csp];}
 if([path isEqual:@"/style.css"]){mime=@"text/css; charset=utf-8";value=@"h1{color:rgb(12,34,56)}";}
 if([path isEqual:@"/main.js"]){mime=@"text/javascript; charset=utf-8";value=@"document.title='script-ready';localStorage.setItem('fixture','stored');fetch('data.json').then(r=>r.json()).then(j=>document.body.dataset.json=j.ok).catch(()=>document.body.dataset.json='fetch-failed');fetch('http://127.0.0.1:18746/blocked').then(()=>document.body.dataset.external='allowed').catch(()=>document.body.dataset.external='blocked');fetch('ff-preview://other/secret.json').then(()=>document.body.dataset.other='allowed').catch(()=>document.body.dataset.other='blocked');";}
 if([path isEqual:@"/data.json"]){mime=@"application/json";value=@"{\"ok\":\"yes\"}";}
 if([path isEqual:@"/image.svg"]){mime=@"image/svg+xml";value=@"<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><rect width='20' height='20' fill='blue'/></svg>";}
 if([path isEqual:@"/delayed.html"]){probe.delayed=request;return;}
 NSData *data=[value dataUsingEncoding:NSUTF8StringEncoding];NSData *headers=[NSJSONSerialization dataWithJSONObject:@{@"Content-Security-Policy":csp,@"Cache-Control":@"no-store",@"X-Content-Type-Options":@"nosniff"} options:0 error:NULL];NSString *json=[[NSString alloc]initWithData:headers encoding:NSUTF8StringEncoding];
 dispatch_async(dispatch_get_main_queue(),^{ff_browser_resource_finish(92,request,data.bytes,data.length,mime.UTF8String,json.UTF8String);});
}
static void observed(void *p,const char *json,const char *error){
 PreviewProbe *probe=owner(p);NSData *data=json ? [@(json) dataUsingEncoding:NSUTF8StringEncoding] : nil;NSDictionary *v=data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL]:nil;
 [probe check:@"directory_observation_real_DOM_and_pixels" pass:!error && [v[@"text"] containsString:@"Directory sample"] && [v[@"screenshot"][@"status"] isEqual:@"captured"]];
 [data writeToFile:@"/tmp/farfold-browser-observation-probe/directory-observation.json" atomically:YES];
 void (^done)(void)=probe.observed;probe.observed=nil;if(done)done();
}
@implementation PreviewProbe
- (void)check:(NSString *)label pass:(BOOL)pass{[self.checks addObject:@{@"name":label,@"pass":@(pass)}];fprintf(stderr,"%s %s\n",pass?"PASS":"FAIL",label.UTF8String);}
- (void)applicationDidFinishLaunching:(NSNotification *)note{
 self.checks=[NSMutableArray new];self.requests=[NSMutableSet new];self.window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,640,480) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];NSView *container=[[NSView alloc]initWithFrame:NSMakeRect(0,0,640,480)];self.window.contentView=container;self.parent=[[WKWebView alloc]initWithFrame:container.bounds configuration:[WKWebViewConfiguration new]];[container addSubview:self.parent];
 [self check:@"validated_default_http_origin_create" pass:ff_browser_create_preview(94,(__bridge void *)self.parent,0,0,640,480,(__bridge void *)self,allow,status,released,"62781cd5-fb1f-44ab-a1a3-e6597473d250","http://127.0.0.1/",NULL)];
 [self check:@"validated_default_https_origin_create" pass:ff_browser_create_preview(95,(__bridge void *)self.parent,0,0,640,480,(__bridge void *)self,allow,status,released,"47831cda-62d4-45d7-9b7c-319f647be5f8","https://[::1]/",NULL)];
 [self check:@"default_origin_views_closed_without_network" pass:ff_browser_close(94)&&ff_browser_close(95)];
 [self check:@"directory_create" pass:ff_browser_create_preview(92,(__bridge void *)self.parent,0,0,640,480,(__bridge void *)self,allow,status,released,"d1f7ec2f-6e61-4a4e-8a17-4e2f35f1d639","ff-preview://preview-92/",resource)];
 [self check:@"directory_initial_navigation" pass:ff_browser_navigate_preview(92,1,"ff-preview://preview-92/index.html")];
 dispatch_after(dispatch_time(DISPATCH_TIME_NOW,15*NSEC_PER_SEC),dispatch_get_main_queue(),^{if(!self.finished){[self check:@"bounded_completion" pass:NO];[self finish];}});
}
- (void)ready{
 if(self.stage==0){self.stage=1;dispatch_after(dispatch_time(DISPATCH_TIME_NOW,500*NSEC_PER_MSEC),dispatch_get_main_queue(),^{
  [lookup(92).view evaluateJavaScript:@"({title:document.title,json:document.body.dataset.json,external:document.body.dataset.external,other:document.body.dataset.other,color:getComputedStyle(document.querySelector('h1')).color,image:document.querySelector('img').naturalWidth,stored:localStorage.getItem('fixture'),bridge:typeof window.__TAURI_INTERNALS__})" completionHandler:^(id value,NSError *error){
   [self check:@"directory_real_multi_file_script_style_image" pass:!error && [value[@"title"] isEqual:@"script-ready"] && [value[@"color"] isEqual:@"rgb(12, 34, 56)"] && [value[@"image"] intValue]==20];
   [self check:@"directory_same_source_fetch" pass:[value[@"json"] isEqual:@"yes"]];
   [self check:@"directory_CSP_blocks_external_and_other_source_fetch" pass:[value[@"external"] isEqual:@"blocked"] && [value[@"other"] isEqual:@"blocked"] && ![self.requests containsObject:@"/secret.json"]];
   [self check:@"directory_local_storage_and_no_tauri_bridge" pass:[value[@"stored"] isEqual:@"stored"] && [value[@"bridge"] isEqual:@"undefined"]];
   __weak PreviewProbe *weakSelf=self;self.observed=^{PreviewProbe *self=weakSelf;
   [self check:@"directory_unselected_top_origin_denied" pass:!ff_browser_navigate_preview(92,2,"ff-preview://other/index.html")];
   [self check:@"directory_delayed_resource_started" pass:ff_browser_navigate_preview(92,3,"ff-preview://preview-92/delayed.html")];
   dispatch_after(dispatch_time(DISPATCH_TIME_NOW,300*NSEC_PER_MSEC),dispatch_get_main_queue(),^{
    [self check:@"delayed_request_recorded" pass:self.delayed>0];[self check:@"directory_close_ack" pass:ff_browser_close(92)];
    [self check:@"late_resource_not_delivered_after_close" pass:!ff_browser_resource_finish(92,self.delayed,(const uint8_t *)"late",4,"text/html","{}")];
    [self check:@"development_create" pass:ff_browser_create_preview(93,(__bridge void *)self.parent,0,0,640,480,(__bridge void *)self,allow,status,released,"7c5c9991-b680-41ae-ad33-66a47ca49c90","http://127.0.0.1:18746/",NULL)];
    [self check:@"development_navigation" pass:ff_browser_navigate_preview(93,1,"http://127.0.0.1:18746/safe")];
   });
   };
   [self check:@"directory_observation_started" pass:ff_browser_observe(92,1,"ff-preview://preview-92/index.html",true,(__bridge void *)self,observed)==1];
  }];
 });return;}
 if(self.stage==1){self.stage=2;[lookup(93).view evaluateJavaScript:@"({title:document.querySelector('h1').textContent,bridge:typeof window.__TAURI_INTERNALS__})" completionHandler:^(id value,NSError *error){
  [self check:@"development_ignores_persistent_store_argument" pass:!lookup(93).view.configuration.websiteDataStore.persistent];
  [self check:@"development_real_page_no_bridge" pass:!error && [value[@"title"] isEqual:@"Public sample"] && [value[@"bridge"] isEqual:@"undefined"]];
  [self check:@"development_external_top_navigation_denied" pass:!ff_browser_navigate_preview(93,2,"https://example.com/")];[self finish];
 }];}
}
- (void)finish{if(self.finished)return;self.finished=YES;[self check:@"all_preview_close" pass:ff_browser_close(92)&&ff_browser_close(93)];BOOL pass=YES;for(NSDictionary *c in self.checks)if(![c[@"pass"] boolValue])pass=NO;NSDictionary *report=@{@"pass":@(pass),@"checks":self.checks,@"requests":self.requests.allObjects,@"scope":@"Real WKURLSchemeHandler and WebKit custom origin multi-resource loading with synthetic callback bytes; actual production native create/finish/close. Test-only direct WK JS reads assertions. Directory filesystem guards/lease tested separately in Rust; does not prove Tauri UI integration or installed app. Explicit loopback dev page retains its network capabilities; no network sandbox claim."};NSData *data=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted|NSJSONWritingSortedKeys error:NULL];[data writeToFile:@"/tmp/farfold-browser-observation-probe/preview-result.json" atomically:YES];puts([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String);[NSApplication.sharedApplication terminate:nil];}
@end
int main(){@autoreleasepool{NSApplication *app=NSApplication.sharedApplication;[app setActivationPolicy:NSApplicationActivationPolicyProhibited];PreviewProbe *p=[PreviewProbe new];app.delegate=p;[app run];}return 0;}
