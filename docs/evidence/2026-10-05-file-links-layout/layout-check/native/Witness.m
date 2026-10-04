#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import "Witness.h"

// Retain only the observed browser so removal can be checked after the owner
// releases it. This fixture has no access to the browser's registry or methods.
static WKWebView *observedView;

bool witness_capture(void *parent_wk_view) {
    if (!NSThread.isMainThread) return false;
    observedView = nil;
    if (!parent_wk_view) return false;
    WKWebView *parent = (__bridge WKWebView *)parent_wk_view;
    if (![parent isKindOfClass:WKWebView.class] || !parent.superview) return false;
    WKWebView *candidate = nil;
    NSUInteger count = 0;
    for (NSView *view in parent.superview.subviews) {
        if (view != parent && [view isKindOfClass:WKWebView.class]) {
            candidate = (WKWebView *)view;
            count++;
        }
    }
    if (count != 1) return false;
    observedView = candidate;
    return true;
}

bool witness_attached(void) {
    return NSThread.isMainThread && observedView && observedView.superview != nil;
}

bool witness_ephemeral(void) {
    return NSThread.isMainThread && observedView &&
        !observedView.configuration.websiteDataStore.persistent;
}

bool witness_has_no_user_scripts(void) {
    return NSThread.isMainThread && observedView &&
        observedView.configuration.userContentController.userScripts.count == 0;
}

void witness_release(void) {
    if (!NSThread.isMainThread) return;
    observedView = nil;
}


bool witness_hidden(void) {return NSThread.isMainThread && observedView && observedView.hidden;}
// Fixed synthetic fixture only. No arbitrary script, URL or selector accepted.
void witness_evaluate(void *context, void (*callback)(void *, bool)) {
  if (!NSThread.isMainThread || !observedView || !observedView.superview || observedView.configuration.websiteDataStore.persistent || ![observedView.URL.host hasPrefix:@"preview-"] || ![observedView.URL.host hasSuffix:@".invalid"]) {callback(context,false);return;}
  NSString *script = @"(()=>{const noBridge=!window.__TAURI_INTERNALS__&&!window.__TAURI__;document.getElementById('counter').click();return noBridge&&window.fixtureLoaded===true&&document.title==='LOCAL_HTML_COMMAND_FIXTURE'&&document.getElementById('count').textContent==='1'&&document.getElementById('canvas').getContext('2d').getImageData(0,0,1,1).data[3]===255})()";
  [observedView evaluateJavaScript:script completionHandler:^(id value,NSError *error){callback(context,!error&&[value boolValue]);}];
}

static NSDictionary *rectJSON(NSRect r) {return @{ @"x":@(r.origin.x), @"y":@(r.origin.y), @"width":@(r.size.width), @"height":@(r.size.height)};}
static WKWebView *childFor(WKWebView *parent) {
  WKWebView *child=nil;NSUInteger count=0;
  for(NSView *view in parent.superview.subviews) if(view!=parent && [view isKindOfClass:WKWebView.class]){child=(WKWebView *)view;count++;}
  return count==1?child:nil;
}
const char *witness_geometry(void *raw) {
  if(!NSThread.isMainThread||!raw)return NULL;
  WKWebView *parent=(__bridge WKWebView *)raw;
  if(![parent isKindOfClass:WKWebView.class]||!parent.superview)return NULL;
  WKWebView *child=childFor(parent);
  NSMutableDictionary *out=[@{@"mainBounds":rectJSON(parent.bounds),@"mainVisibleRect":rectJSON(parent.visibleRect),@"mainSafeAreaRect":rectJSON(parent.safeAreaRect),@"windowContentLayoutRect":rectJSON(parent.window.contentLayoutRect),@"windowContentLayoutInMain":rectJSON([parent convertRect:parent.window.contentLayoutRect fromView:nil]),@"safeTop":@(parent.safeAreaInsets.top),@"safeBottom":@(parent.safeAreaInsets.bottom),@"safeLeft":@(parent.safeAreaInsets.left),@"safeRight":@(parent.safeAreaInsets.right),@"mainFrame":rectJSON(parent.frame),@"mainFlipped":@(parent.isFlipped),@"superFlipped":@(parent.superview.isFlipped),@"superBounds":rectJSON(parent.superview.bounds),@"mainPageZoom":@(parent.pageZoom),@"mainHidden":@(parent.hidden),@"windowVisible":@(parent.window.visible),@"windowOcclusionVisible":@((parent.window.occlusionState&NSWindowOcclusionStateVisible)!=0),@"windowContentRect":rectJSON(parent.window.contentView.bounds),@"nativePresent":@(child!=nil)} mutableCopy];
  if(child){NSRect inMain=[parent convertRect:child.frame fromView:parent.superview];NSRect dom=inMain;if(!parent.isFlipped)dom.origin.y=parent.bounds.size.height-NSMaxY(inMain);out[@"nativeFrame"]=rectJSON(child.frame);out[@"nativeInMain"]=rectJSON(inMain);out[@"nativeDOMRect"]=rectJSON(dom);out[@"nativeHidden"]=@(child.hidden);out[@"nativePageZoom"]=@(child.pageZoom);out[@"nativeFirstResponder"]=@([parent.window.firstResponder isKindOfClass:NSView.class]&&[(NSView *)parent.window.firstResponder isDescendantOf:child]);}
  NSMutableArray *subviews=[NSMutableArray new];for(NSView *sub in parent.subviews){[subviews addObject:@{@"class":NSStringFromClass(sub.class),@"frame":rectJSON(sub.frame),@"bounds":rectJSON(sub.bounds),@"visibleRect":rectJSON(sub.visibleRect),@"flipped":@(sub.isFlipped),@"safeTop":@(sub.safeAreaInsets.top)}];}out[@"mainSubviews"]=subviews;NSScrollView *scroll=parent.enclosingScrollView;if(scroll)out[@"enclosingScroll"]=@{@"frame":rectJSON(scroll.frame),@"bounds":rectJSON(scroll.bounds),@"contentViewFrame":rectJSON(scroll.contentView.frame),@"documentVisibleRect":rectJSON(scroll.documentVisibleRect)};
  NSData *data=[NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
  return data?strdup([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String):NULL;
}
void witness_free(const char *text){free((void *)text);}
void witness_snapshot(void *raw,const char *out_path,void *context,void (*callback)(void *,bool)) {
  if(!NSThread.isMainThread||!raw||!out_path){callback(context,false);return;}
  WKWebView *parent=(__bridge WKWebView *)raw;WKWebView *child=childFor(parent);
  NSString *path=[NSString stringWithUTF8String:out_path];
  NSSize size=parent.bounds.size;
  WKSnapshotConfiguration *cfg=[WKSnapshotConfiguration new];cfg.rect=parent.bounds;cfg.snapshotWidth=@(size.width);
  void(^finish)(NSImage *,NSImage *)=^(NSImage *base,NSImage *page){
    if(!base){callback(context,false);return;}
    NSImage *combined=[[NSImage alloc]initWithSize:size];[combined lockFocus];[base drawInRect:NSMakeRect(0,0,size.width,size.height)];
    if(page&&child&&!child.hidden){NSRect r=[parent convertRect:child.frame fromView:parent.superview];if(parent.isFlipped)r.origin.y=size.height-NSMaxY(r);[page drawInRect:r];}
    [combined unlockFocus];NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc]initWithData:combined.TIFFRepresentation];NSData *png=[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];callback(context,png&&[png writeToFile:path atomically:YES]);
  };
  [parent takeSnapshotWithConfiguration:cfg completionHandler:^(NSImage *base,NSError *error){
    if(error||!base){callback(context,false);return;}
    if(!child||child.hidden){finish(base,nil);return;}
    WKSnapshotConfiguration *second=[WKSnapshotConfiguration new];second.rect=child.bounds;second.snapshotWidth=@(child.bounds.size.width);
    [child takeSnapshotWithConfiguration:second completionHandler:^(NSImage *page,NSError *pageError){if(pageError){callback(context,false);return;}finish(base,page);}];
  }];
}

// Capture only this controlled main NSWindow; never use an all-window/desktop option.
#import <CoreGraphics/CoreGraphics.h>
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
bool witness_window_picture(void *raw,const char *out_path) {
 if(!NSThread.isMainThread||!raw||!out_path)return false;
 WKWebView *parent=(__bridge WKWebView *)raw;if(!parent.window)return false;
 CGImageRef shot=CGWindowListCreateImage(CGRectNull,kCGWindowListOptionIncludingWindow,(CGWindowID)parent.window.windowNumber,kCGWindowImageBoundsIgnoreFraming);
 if(!shot)return false;
 NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc]initWithCGImage:shot];CGImageRelease(shot);
 NSData *png=[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];return png&&[png writeToFile:[NSString stringWithUTF8String:out_path] atomically:YES];
}
#pragma clang diagnostic pop

bool witness_zoom(void *raw,double zoom){if(!NSThread.isMainThread||!raw||(zoom!=1&&zoom!=1.25))return false;WKWebView *parent=(__bridge WKWebView *)raw;parent.pageZoom=zoom;return parent.pageZoom==zoom;}
