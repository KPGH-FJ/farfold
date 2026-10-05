#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef void (*FFNotificationClick)(const char *target);
typedef void (*FFNotificationSettings)(void *context, int32_t permission,
                                       bool alert, bool sound, bool success);
typedef void (*FFNotificationSubmitted)(void *context, bool success);

// Main-thread entry points. Initialization never requests system permission.
bool ff_notifications_initialize(FFNotificationClick click);
// Only the explicit user-enable path may pass request=true.
bool ff_notifications_settings(bool request, void *context, FFNotificationSettings reply);
bool ff_notifications_submit(const char *identifier, const char *target,
                             const char *body, bool sound, void *context,
                             FFNotificationSubmitted reply);
void ff_notifications_remove(const char *identifier);
