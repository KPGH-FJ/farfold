import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useLayoutEffect, useRef, useState } from "react";
import {
  BrowserSurfaceGuard,
  type BrowserSurfaceHold,
} from "./browser_surface_guard";
import {
  createBrowserWorkspaceClient,
  type BrowserWorkspaceState,
} from "./browser_workspace";

/** One in-memory coordinator for the trusted main application's native surface. */
export const browserSurfaceGuard = new BrowserSurfaceGuard();
export const browserWorkspaceClient = createBrowserWorkspaceClient(
  invoke,
  (callback) =>
    listen<BrowserWorkspaceState>("browser-workspace:state", (event) =>
      callback(event.payload),
    ),
  (callback) =>
    listen<{ taskKey: string }>("browser-workspace:tabs-changed", (event) =>
      callback(event.payload),
    ),
);

/** Keep covering DOM hidden until the exact native surface has acknowledged hide. */
export function useBrowserSurfaceBarrier(requested: boolean): boolean {
  const hold = useRef<BrowserSurfaceHold | null>(null);
  const [, refresh] = useState(0);
  useLayoutEffect(() => {
    if (!requested) return;
    const stop = browserSurfaceGuard.subscribe(() =>
      refresh((value) => value + 1),
    );
    const ticket = browserSurfaceGuard.hold();
    hold.current = ticket;
    refresh((value) => value + 1);
    return () => {
      hold.current = null;
      stop();
      ticket.release();
    };
  }, [requested]);
  return requested && (hold.current?.ready ?? !browserSurfaceGuard.hasSurfaces);
}
