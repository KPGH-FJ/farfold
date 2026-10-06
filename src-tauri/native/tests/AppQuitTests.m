// Controlled peer: no system Apple events, app termination, UI or user data.
#import "../AppQuit.m"
#include <assert.h>

static uint64_t CurrentOwner = 7;
static NSUInteger Requested = 0;
static uint64_t Owner(void) { return CurrentOwner; }
static void Request(void) { Requested++; }

@interface QuitManagerPeer : NSAppleEventManager
@property(nonatomic) NSUInteger nextID;
@property(nonatomic) NSUInteger suspended;
@property(nonatomic, strong) NSMutableDictionary<NSValue *, NSAppleEventDescriptor *> *replies;
@property(nonatomic, strong) NSMutableArray<NSValue *> *resumed;
@property(nonatomic) AEEventClass installedClass;
@property(nonatomic) AEEventID installedID;
@property(nonatomic) SEL installedSelector;
@end
@implementation QuitManagerPeer
- (instancetype)init {
    self = [super init];
    if (self) { self.replies = [NSMutableDictionary dictionary]; self.resumed = [NSMutableArray array]; }
    return self;
}
- (void)setEventHandler:(id)handler andSelector:(SEL)selector
         forEventClass:(AEEventClass)eventClass andEventID:(AEEventID)eventID {
    self.installedClass = eventClass; self.installedID = eventID; self.installedSelector = selector;
}
- (NSAppleEventManagerSuspensionID)suspendCurrentAppleEvent {
    self.suspended++;
    NSAppleEventManagerSuspensionID key = (void *)(++self.nextID);
    NSAppleEventDescriptor *reply = [NSAppleEventDescriptor appleEventWithEventClass:kCoreEventClass
        eventID:kAEAnswer targetDescriptor:[NSAppleEventDescriptor nullDescriptor]
        returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
    self.replies[[NSValue valueWithPointer:key]] = reply;
    return key;
}
- (NSAppleEventDescriptor *)replyAppleEventForSuspensionID:(NSAppleEventManagerSuspensionID)key {
    return self.replies[[NSValue valueWithPointer:key]];
}
- (void)resumeWithSuspensionID:(NSAppleEventManagerSuspensionID)key {
    NSValue *value = [NSValue valueWithPointer:key];
    assert(![self.resumed containsObject:value]);
    [self.resumed addObject:value];
}
@end

static NSAppleEventDescriptor *Reply(void) {
    return [NSAppleEventDescriptor appleEventWithEventClass:kCoreEventClass eventID:kAEAnswer
        targetDescriptor:[NSAppleEventDescriptor nullDescriptor] returnID:kAutoGenerateReturnID
        transactionID:kAnyTransactionID];
}
static FFAppQuitHandler *Handler(QuitManagerPeer **manager) {
    *manager = [QuitManagerPeer new];
    Requested = 0;
    return [[FFAppQuitHandler alloc] initWithManager:*manager owner:Owner request:Request];
}
static void Quit(FFAppQuitHandler *handler) { [handler handleQuit:Reply() withReplyEvent:Reply()]; }
static int32_t Error(NSAppleEventDescriptor *reply) {
    return [reply paramDescriptorForKeyword:keyErrorNumber].int32Value;
}
int main(void) {
    @autoreleasepool {
        QuitManagerPeer *manager;
        FFAppQuitHandler *handler = Handler(&manager);
        [handler install];
        assert(manager.installedClass == kCoreEventClass && manager.installedID == kAEQuitApplication);
        assert(manager.installedSelector == @selector(handleQuit:withReplyEvent:));
        CurrentOwner = 7;
        Quit(handler); Quit(handler);
#ifdef FF_QUIT_EARLY_REPLY_COUNTEREXAMPLE
        // Replay the old Rust call order: save acknowledged, final installing
        // recheck not yet run. A late installer must still be able to defer.
        [handler completeOwner:7 saved:YES];
#endif
        assert(Requested == 1 && manager.suspended == 2 && manager.resumed.count == 0);
        [handler completeOwner:8 saved:YES];
        assert(manager.resumed.count == 0);
        [handler completeOwner:7 saved:NO];
        assert(manager.resumed.count == 2);
        for (NSValue *key in manager.resumed) assert(Error(manager.replies[key]) == userCanceledErr);
        [handler completeOwner:7 saved:YES];
        assert(manager.resumed.count == 2);

        handler = Handler(&manager); CurrentOwner = 7; Quit(handler);
        CurrentOwner = 9; Quit(handler);
        assert(Requested == 2 && manager.resumed.count == 1);
        assert(Error(manager.replies[manager.resumed[0]]) == userCanceledErr);
        [handler completeOwner:7 saved:YES];
        assert(manager.resumed.count == 1);
        [handler completeOwner:9 saved:YES];
        assert(manager.resumed.count == 2 && Error(manager.replies[manager.resumed[1]]) == 0);
        NSAppleEventDescriptor *reply = Reply();
        [handler handleQuit:Reply() withReplyEvent:reply];
        assert(Error(reply) == userCanceledErr && Requested == 2 && manager.suspended == 2);

        handler = Handler(&manager); CurrentOwner = 11;
        for (NSUInteger i = 0; i < FFQuitLimit; i++) Quit(handler);
        reply = Reply(); [handler handleQuit:Reply() withReplyEvent:reply];
        assert(Error(reply) == userCanceledErr && Requested == 1 && manager.suspended == FFQuitLimit);
        assert(manager.resumed.count == 0);
        [handler completeOwner:11 saved:NO];
        assert(manager.resumed.count == FFQuitLimit);

        handler = Handler(&manager); CurrentOwner = 0;
        reply = Reply(); [handler handleQuit:Reply() withReplyEvent:reply];
        assert(Error(reply) == userCanceledErr && Requested == 0 && manager.suspended == 0);
        puts("Apple-event quit peer: registration, deferred reply, cancel, owner race, bound, readiness passed");
    }
    return 0;
}
