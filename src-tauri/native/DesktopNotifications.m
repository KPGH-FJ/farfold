#import "DesktopNotifications.h"
#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>

static NSString *const FFNotificationCategory = @"farfold-work-attention";
static FFNotificationClick ffClick;
static UNUserNotificationCenter *ffCenter;
static FFNotificationDiagnostic ffDiagnostic;
static void ffObserve(NSString *identifier, int32_t event, int32_t domain, int64_t code);

@interface FFNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation FFNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (NSApp.active) {
      ffObserve(notification.request.identifier, 3, 0, 0);
      completion(UNNotificationPresentationOptionNone); return;
    }
    UNNotificationPresentationOptions options = UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList;
    if (notification.request.content.sound) options |= UNNotificationPresentationOptionSound;
    ffObserve(notification.request.identifier, 4, 0, 0);
    completion(options);
  });
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completion {
  if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier] &&
      [response.notification.request.content.categoryIdentifier isEqualToString:FFNotificationCategory]) {
    id target = response.notification.request.content.userInfo[@"target"];
    if ([target isKindOfClass:NSString.class] && [target length] == 64) {
      ffObserve(response.notification.request.identifier, 5, 0, 0);
      NSString *copy = [target copy];
      dispatch_async(dispatch_get_main_queue(), ^{ if (ffClick) ffClick(copy.UTF8String); });
    }
  }
  completion();
}
@end
static FFNotificationDelegate *ffDelegate;
static void ffObserve(NSString *identifier, int32_t event, int32_t domain, int64_t code) {
  if (!ffDiagnostic || !identifier) return;
  // State is sampled at the real submission, not during later diagnostics reads.
  bool initialized = false, delegateMatches = false, bundleMatches = false, active = false;
  if (event == 0) {
    initialized = ffCenter != nil;
    delegateMatches = initialized && ffCenter.delegate == ffDelegate;
    bundleMatches = [NSBundle.mainBundle.bundleIdentifier isEqualToString:@"ai.farfold.desktop"];
    active = NSApp.active;
  }
  ffDiagnostic(identifier.UTF8String, event, initialized, delegateMatches,
               bundleMatches, active, domain, code);
}
void ff_notifications_set_diagnostic(FFNotificationDiagnostic diagnostic) {
  if (NSThread.isMainThread) ffDiagnostic = diagnostic;
}
static int32_t ffErrorDomain(NSError *error) {
  if ([error.domain isEqualToString:UNErrorDomain]) return 1;
  if ([error.domain isEqualToString:NSCocoaErrorDomain]) return 2;
  if ([error.domain isEqualToString:NSPOSIXErrorDomain]) return 3;
  if ([error.domain isEqualToString:NSOSStatusErrorDomain]) return 4;
  return 5;
}

bool ff_notifications_initialize(FFNotificationClick click) {
  if (!NSThread.isMainThread) return false;
  @try {
    if (!NSBundle.mainBundle.bundleIdentifier.length) return false;
    ffClick = click;
    ffCenter = UNUserNotificationCenter.currentNotificationCenter;
    if (!ffDelegate) ffDelegate = [FFNotificationDelegate new];
    ffCenter.delegate = ffDelegate;
    return true;
  } @catch (NSException *exception) { return false; }
}

static void ffReplySettings(void *context, FFNotificationSettings reply, bool success) {
  [ffCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    int32_t permission = 0;
    switch (settings.authorizationStatus) {
      case UNAuthorizationStatusNotDetermined: permission = 1; break;
      case UNAuthorizationStatusDenied: permission = 2; break;
      case UNAuthorizationStatusAuthorized: permission = 3; break;
      case UNAuthorizationStatusProvisional: permission = 4; break;
      default: break;
    }
    reply(context, permission, settings.alertSetting == UNNotificationSettingEnabled,
          settings.soundSetting == UNNotificationSettingEnabled, success);
  }];
}

bool ff_notifications_settings(bool request, void *context, FFNotificationSettings reply) {
  if (!NSThread.isMainThread || !ffCenter) return false;
  [ffCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    if (request && settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
      [ffCenter requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                            completionHandler:^(BOOL granted, NSError *error) {
        ffReplySettings(context, reply, error == nil);
      }];
    } else { ffReplySettings(context, reply, true); }
  }];
  return true;
}

bool ff_notifications_submit(const char *identifier, const char *target,
                             const char *body, bool sound, void *context,
                             FFNotificationSubmitted reply) {
  if (!NSThread.isMainThread) return false;
  NSString *observedId = [NSString stringWithUTF8String:identifier];
  ffObserve(observedId, 0, 0, 0);
  if (!ffCenter) { ffObserve(observedId, 6, 0, 0); return false; }
  NSString *requestId = observedId;
  NSString *targetId = [NSString stringWithUTF8String:target];
  NSString *message = [NSString stringWithUTF8String:body];
  if (!requestId || targetId.length != 64 || !message) {
    ffObserve(observedId, 7, 0, 0); return false;
  }
  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = @"Farfold";
  content.body = message;
  content.categoryIdentifier = FFNotificationCategory;
  content.userInfo = @{@"target":targetId};
  if (sound) content.sound = UNNotificationSound.defaultSound;
  UNNotificationRequest *notice = [UNNotificationRequest requestWithIdentifier:requestId content:content trigger:nil];
  [ffCenter addNotificationRequest:notice withCompletionHandler:^(NSError *error) {
    ffObserve(notice.identifier, error ? 2 : 1, error ? ffErrorDomain(error) : 0,
              error ? (int64_t)error.code : 0);
    reply(context, error == nil);
  }];
  return true;
}

void ff_notifications_remove(const char *identifier) {
  if (!NSThread.isMainThread || !ffCenter) return;
  NSString *requestId = [NSString stringWithUTF8String:identifier];
  if (!requestId) return;
  [ffCenter removePendingNotificationRequestsWithIdentifiers:@[requestId]];
  [ffCenter removeDeliveredNotificationsWithIdentifiers:@[requestId]];
}
