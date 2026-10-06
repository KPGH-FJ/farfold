#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef void (*FFNotificationClick)(const char *target);
typedef void (*FFNotificationSettings)(void *context, int32_t permission,
                                       bool alert, bool sound, bool success);
typedef void (*FFNotificationSubmitted)(void *context, bool success);
// Main-thread query of the actual main window: 0 background, 1 foreground,
// 2 unavailable. No saved window pointer or submission context is retained.
typedef int32_t (*FFNotificationForeground)(void);
// Static events and booleans only. Identifier is private correlation, never exported.
typedef void (*FFNotificationDiagnostic)(const char *identifier, int32_t event,
                                         bool initialized, bool delegateMatches,
                                         bool bundleMatches, bool appActive,
                                         int32_t errorDomain, int64_t errorCode);

// Main-thread entry points. Initialization never requests system permission.
bool ff_notifications_initialize(FFNotificationClick click,
                                 FFNotificationForeground foreground);
void ff_notifications_set_diagnostic(FFNotificationDiagnostic diagnostic);
// Only the explicit user-enable path may pass request=true.
bool ff_notifications_settings(bool request, void *context, FFNotificationSettings reply);
bool ff_notifications_submit(const char *identifier, const char *target,
                             const char *body, bool sound, void *context,
                             FFNotificationSubmitted reply);
void ff_notifications_remove(const char *identifier);
