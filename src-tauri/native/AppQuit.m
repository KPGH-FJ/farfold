#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>
#include "AppQuit.h"

static const NSUInteger FFQuitLimit = 8;

@interface FFAppQuitHandler : NSObject
@property(nonatomic, strong) NSAppleEventManager *manager;
@property(nonatomic) FFAppQuitOwner ownerCallback;
@property(nonatomic) FFAppQuitRequest requestCallback;
@property(nonatomic) uint64_t pendingOwner;
@property(nonatomic) BOOL exiting;
@property(nonatomic, strong) NSMutableArray<NSValue *> *suspensions;
- (instancetype)initWithManager:(NSAppleEventManager *)manager
                          owner:(FFAppQuitOwner)owner request:(FFAppQuitRequest)request;
- (void)install;
- (void)handleQuit:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply;
- (void)completeOwner:(uint64_t)owner saved:(BOOL)saved;
@end

static void FFQuitCancelled(NSAppleEventDescriptor *reply) {
    if (reply.descriptorType != typeNull) {
        [reply setParamDescriptor:[NSAppleEventDescriptor descriptorWithInt32:userCanceledErr]
                      forKeyword:keyErrorNumber];
    }
}

@implementation FFAppQuitHandler
- (instancetype)initWithManager:(NSAppleEventManager *)manager
                          owner:(FFAppQuitOwner)owner request:(FFAppQuitRequest)request {
    self = [super init];
    if (self) {
        self.manager = manager;
        self.ownerCallback = owner;
        self.requestCallback = request;
        self.suspensions = [NSMutableArray array];
    }
    return self;
}
- (void)install {
    [self.manager setEventHandler:self andSelector:@selector(handleQuit:withReplyEvent:)
                   forEventClass:kCoreEventClass andEventID:kAEQuitApplication];
}
- (void)handleQuit:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply {
    uint64_t owner = self.exiting ? 0 : self.ownerCallback();
    if (!owner || (owner == self.pendingOwner && self.suspensions.count >= FFQuitLimit)) {
        FFQuitCancelled(reply);
        return;
    }
    // Returning from an asynchronous save must not send a successful quit reply.
    NSAppleEventManagerSuspensionID suspended = [self.manager suspendCurrentAppleEvent];
    if (!suspended) {
        FFQuitCancelled(reply);
        return;
    }
    if (self.pendingOwner && self.pendingOwner != owner) {
        // A cancelled save may have completed on another thread while its
        // main-thread reply is still queued. Never merge a new owner with it.
        [self completeOwner:self.pendingOwner saved:NO];
    }
    BOOL first = self.suspensions.count == 0;
    self.pendingOwner = owner;
    [self.suspensions addObject:[NSValue valueWithPointer:suspended]];
    if (first) self.requestCallback();
}
- (void)completeOwner:(uint64_t)owner saved:(BOOL)saved {
    if (!owner || owner != self.pendingOwner) return;
    NSArray<NSValue *> *pending = [self.suspensions copy];
    [self.suspensions removeAllObjects];
    self.pendingOwner = 0;
    if (saved) self.exiting = YES;
    for (NSValue *value in pending) {
        NSAppleEventManagerSuspensionID suspended = value.pointerValue;
        // Apple forbids retaining this reply descriptor; fetch, edit and resume
        // each suspension exactly once. Resume sends our reply, not terminate:.
        if (!saved) FFQuitCancelled([self.manager replyAppleEventForSuspensionID:suspended]);
        [self.manager resumeWithSuspensionID:suspended];
    }
}
@end

static FFAppQuitHandler *FFQuitHandler;
bool ff_app_quit_initialize(FFAppQuitOwner owner, FFAppQuitRequest request) {
    if (![NSThread isMainThread] || !NSApp || !owner || !request) return false;
    if (FFQuitHandler) return true;
    FFQuitHandler = [[FFAppQuitHandler alloc]
        initWithManager:[NSAppleEventManager sharedAppleEventManager] owner:owner request:request];
    [FFQuitHandler install];
    return true;
}
void ff_app_quit_complete(uint64_t owner, bool saved) {
    if (![NSThread isMainThread]) return;
    [FFQuitHandler completeOwner:owner saved:saved];
}
