import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createBrowserSharingClient } from "./browser_sharing";

export const browserSharingClient = createBrowserSharingClient(
  invoke,
  (callback) =>
    listen<{ taskKey: string }>("browser-sharing:changed", (event) =>
      callback(event.payload.taskKey),
    ),
);
