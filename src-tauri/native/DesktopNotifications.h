#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef void (*FFNotificationClick)(const char *target);
typedef void (*FFNotificationSettings)(void *context, int32_t permission,
                                       bool alert, bool sound, bool success);
typedef void (*FFNotificationSubmitted)(void *context, bool success);
// Static events and booleans only. Identifier is private correlation, never exported.
typedef void (*FFNotificationDiagnostic)(const char *identifier, int32_t event,
                                         bool initialized, bool delegateMatches,
                                         bool bundleMatches, bool appActive,
                                         int32_t errorDomain, int64_t errorCode);

// Main-thread entry points. Initialization never requests system permission.
bool ff_notifications_initialize(FFNotificationClick click);
void ff_notifications_set_diagnostic(FFNotificationDiagnostic diagnostic);
// Only the explicit user-enable path may pass request=true.
bool ff_notifications_settings(bool request, void *context, FFNotificationSettings reply);
bool ff_notifications_submit(const char *identifier, const char *target,
                             const char *body, bool sound, void *context,
                             FFNotificationSubmitted reply);
void ff_notifications_remove(const char *identifier);
