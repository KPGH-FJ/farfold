import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface NavigationPort {
  listen(wake: () => void): Promise<() => void>;
  take(): Promise<unknown>;
}
const nativePort: NavigationPort = {
  listen: (wake) => listen("desktop-notification:activate", wake),
  take: () => invoke("desktop_notification_take_pending"),
};

/** Subscribe before draining startup clicks. IDs have already been checked
 * against existing local metadata; selecting one must never open an Agent. */
export async function notificationNavigation(
  select: (key: string) => void | Promise<void>,
  port: NavigationPort = nativePort,
  openSettings?: () => void | Promise<void>,
): Promise<() => void> {
  let closed = false;
  let draining = false;
  let dirty = false;
  const drain = async () => {
    dirty = true;
    if (draining || closed) return;
    draining = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        try {
          const pending = await port.take();
          if (!closed && Array.isArray(pending)) {
            const key = pending.at(-1);
            if (
              typeof key === "string" &&
              key.length > 0 &&
              key.length <= 16384
            )
              await select(key);
            else if (
              key !== null &&
              typeof key === "object" &&
              !Array.isArray(key) &&
              Object.keys(key).length === 2 &&
              key.kind === "settings" &&
              key.section === "notifications"
            )
              await openSettings?.();
          }
        } catch {
          // Only a new activation during this attempt can drive another drain.
        }
      }
    } finally {
      draining = false;
    }
  };
  const stop = await port.listen(() => {
    void drain();
  });
  void drain();
  return () => {
    closed = true;
    stop();
  };
}
