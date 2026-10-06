// Pure Objective-C peer for the production bridge: never create the OS center,
// request actual permission, submit a system notification, or open an app.
#import "../DesktopNotifications.m"
#include <assert.h>

@interface FFTestSettings : NSObject
@property UNAuthorizationStatus authorizationStatus;
@property UNNotificationSetting alertSetting;
@property UNNotificationSetting soundSetting;
@end
@implementation FFTestSettings
@end
@interface FFTestCenter : NSObject
@property(strong) FFTestSettings *settings;
@property NSInteger requests;
@property(strong) UNNotificationRequest *last;
@property(strong) NSArray<NSString *> *removed;
@end
@implementation FFTestCenter
- (void)getNotificationSettingsWithCompletionHandler:(void (^)(UNNotificationSettings *))reply {
  reply((UNNotificationSettings *)self.settings);
}
- (void)requestAuthorizationWithOptions:(UNAuthorizationOptions)options completionHandler:(void (^)(BOOL,NSError *))reply {
  assert(options == (UNAuthorizationOptionAlert | UNAuthorizationOptionSound));
  self.requests++;
  self.settings.authorizationStatus = UNAuthorizationStatusAuthorized;
  reply(YES,nil);
}
- (void)addNotificationRequest:(UNNotificationRequest *)request withCompletionHandler:(void (^)(NSError *))reply {
  self.last = request; reply(nil);
}
- (void)removePendingNotificationRequestsWithIdentifiers:(NSArray<NSString *> *)ids { self.removed = ids; }
- (void)removeDeliveredNotificationsWithIdentifiers:(NSArray<NSString *> *)ids { self.removed = ids; }
@end
@interface FFTestNotification : NSObject
@property(strong) UNNotificationRequest *request;
@end
@implementation FFTestNotification
@end
@interface FFTestResponse : NSObject
@property(strong) NSString *actionIdentifier;
@property(strong) FFTestNotification *notification;
@end
@implementation FFTestResponse
@end
@interface FFTestApplication : NSObject
@property BOOL active;
@end
@implementation FFTestApplication
- (BOOL)isActive { return self.active; }
@end
static int permissionValue, replies, clicks;
static int foregroundState;
static int32_t foreground(void) { return foregroundState; }
static void status(void *context, int32_t permission, bool alert, bool sound, bool success) {
  assert(success); assert(alert); assert(sound); permissionValue = permission; replies++;
}
static void submitted(void *context, bool success) { assert(success); replies++; }
static void clicked(const char *target) { assert(strlen(target)==64); clicks++; }

int main(void) {
 @autoreleasepool {
  FFTestCenter *peer = [FFTestCenter new];
  peer.settings = [FFTestSettings new];
  peer.settings.alertSetting = UNNotificationSettingEnabled;
  peer.settings.soundSetting = UNNotificationSettingEnabled;
  // Injection exists only in this test translation unit, never a product flag.
  ffCenter = (UNUserNotificationCenter *)peer;
  ffDelegate = [FFNotificationDelegate new];
  ffClick = clicked;
  ffForeground = foreground;
  FFTestApplication *application = [FFTestApplication new];
  application.active = YES;
  NSApp = (NSApplication *)application;
  assert(ff_notifications_settings(false,NULL,status));
  assert(permissionValue==1 && peer.requests==0);
  assert(ff_notifications_settings(true,NULL,status));
  assert(permissionValue==3 && peer.requests==1);
  assert(ff_notifications_settings(true,NULL,status));
  assert(peer.requests==1);
  peer.settings.authorizationStatus=UNAuthorizationStatusDenied;
  assert(ff_notifications_settings(true,NULL,status));
  assert(permissionValue==2 && peer.requests==1);
  peer.settings.authorizationStatus=UNAuthorizationStatusProvisional;
  assert(ff_notifications_settings(false,NULL,status));
  assert(permissionValue==4);
  const char *digest="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  assert(ff_notifications_submit("farfold-fixture",digest,"有一项工作需要你检查。",false,NULL,submitted));
  assert(peer.last.content.userInfo.count==1);
  assert([peer.last.content.userInfo[@"target"] isEqualToString:@(digest)]);
  assert([peer.last.content.title isEqualToString:@"Farfold"]);
  assert(peer.last.content.sound==nil);
  assert(ff_notifications_submit("farfold-fixture",digest,"有一项工作需要你检查。",true,NULL,submitted));
  assert(peer.last.content.sound!=nil);
  assert(!ff_notifications_submit("farfold-fixture","invalid","body",false,NULL,submitted));
  FFTestResponse *response=[FFTestResponse new];
  response.notification=[FFTestNotification new];
  response.notification.request=peer.last;
  response.actionIdentifier=UNNotificationDismissActionIdentifier;
  __block int completed=0;
  [ffDelegate userNotificationCenter:ffCenter didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:^{completed++;}];
  response.actionIdentifier=UNNotificationDefaultActionIdentifier;
  [ffDelegate userNotificationCenter:ffCenter didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:^{completed++;}];
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
  assert(completed==2 && clicks==1);
  // An active application with a minimized/unfocused main window still needs
  // a visible reminder. App activity alone is not the foreground test.
  __block int presentations = 0;
  [ffDelegate userNotificationCenter:ffCenter willPresentNotification:(UNNotification *)response.notification withCompletionHandler:^(UNNotificationPresentationOptions options) {
    assert(options == (UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound));
    presentations++;
  }];
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
  assert(presentations == 1);
  // Recheck at presentation time; returning to the window after submission
  // must suppress the stale banner, even when the request was made away.
  foregroundState = 0;
  [ffDelegate userNotificationCenter:ffCenter willPresentNotification:(UNNotification *)response.notification withCompletionHandler:^(UNNotificationPresentationOptions options) {
    assert(options == UNNotificationPresentationOptionNone); presentations++;
  }];
  foregroundState = 1;
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
  assert(presentations == 2);
  // Unknown/missing window queries are not interpreted as permission to show.
  foregroundState = 2;
  [ffDelegate userNotificationCenter:ffCenter willPresentNotification:(UNNotification *)response.notification withCompletionHandler:^(UNNotificationPresentationOptions options) {
    assert(options == UNNotificationPresentationOptionNone); presentations++;
  }];
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
  ffForeground = NULL;
  [ffDelegate userNotificationCenter:ffCenter willPresentNotification:(UNNotification *)response.notification withCompletionHandler:^(UNNotificationPresentationOptions options) {
    assert(options == UNNotificationPresentationOptionNone); presentations++;
  }];
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
  // Leaving again before the presentation callback uses the new window state;
  // a quiet reminder stays quiet while retaining banner/list presentation.
  ffForeground = foreground;
  assert(ff_notifications_submit("farfold-fixture",digest,"有一项工作需要你检查。",false,NULL,submitted));
  response.notification.request = peer.last;
  foregroundState = 1;
  [ffDelegate userNotificationCenter:ffCenter willPresentNotification:(UNNotification *)response.notification withCompletionHandler:^(UNNotificationPresentationOptions options) {
    assert(options == (UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList)); presentations++;
  }];
  foregroundState = 0;
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
  assert(presentations == 5);
  ff_notifications_remove("farfold-fixture");
  assert([peer.removed isEqualToArray:@[@"farfold-fixture"]]);
  assert(replies==8);
  puts("notification bridge: permission/read/request, payload, sound, click filter, removal passed; no system center used");
 }
 return 0;
}
