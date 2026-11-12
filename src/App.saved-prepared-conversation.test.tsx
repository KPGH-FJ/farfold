import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  call,
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";
import { browserSurfaceGuard } from "./runtime/browser_surface";
import { freshThreadState } from "./runtime/session_projection";
import type { PreparedConversationTransition } from "./components/usePreparedComposerOwner";

beforeEach(resetHarness);
afterEach(cleanupHarness);
function prepare() {
  const state = freshThreadState("same-prepared", "A", "/owned", "same-native");
  state.identity = "established";
  state.connectionId = "same-connection";
  h.threads.set(state.key, state);
  call("EmptyState", "onPreparedKey", state.key);
  render();
  return state;
}
const transition = () =>
  component("EmptyState").onPreparedSaved as PreparedConversationTransition;

it.each(["delayed", "rejected"])(
  "keeps the same prepared browser workspace visible without invoking its %s hide callback",
  (kind) => {
    const state = prepare();
    const hide = vi.fn(() =>
      kind === "delayed"
        ? new Promise<void>(() => {})
        : Promise.reject(new Error("must not hide")),
    );
    const close = vi.fn(async () => {});
    const surface = browserSurfaceGuard.register(close, hide);
    const move = vi.fn(() => true);
    const oldChoice = structuredClone(h.choice);
    try {
      expect(transition()(state, move)).toBe(true);
      expect(move).toHaveBeenCalledOnce();
      call("EmptyState", "onPreparedKey", null);
      expect(component("ThreadPage")).toMatchObject({
        viewKey: state.key,
        active: true,
        draftComposerRef: undefined,
      });
      expect(component("EmptyState").active).toBe(false);
      expect(browserSurfaceGuard.hasSurfaces).toBe(true);
      expect(browserSurfaceGuard.hasPendingNavigation).toBe(false);
      expect(hide).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(h.open).not.toHaveBeenCalled();
      expect(h.choice).toEqual(oldChoice);
    } finally {
      surface.release();
    }
  },
);

it.each([
  "different prepared key",
  "replacement object",
  "draft identity",
  "another route",
  "pending navigation",
  "move refused",
])("does not move prepared input after %s", async (change) => {
  const state = prepare();
  const original = transition();
  let release: (() => void) | undefined;
  let finish: (() => void) | undefined;
  if (change === "different prepared key")
    call("EmptyState", "onPreparedKey", "other");
  if (change === "replacement object") h.threads.set(state.key, { ...state });
  if (change === "draft identity") state.identity = "draft";
  if (change === "another route") call("Sidebar", "onLibrary", { kind: "all" });
  if (change === "pending navigation") {
    const surface = browserSurfaceGuard.register(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    release = surface.release;
    browserSurfaceGuard.runLatest(() => {});
  }
  render();
  const move = vi.fn(() => change !== "move refused");
  try {
    expect(original(state, move)).toBe(false);
    expect(move).toHaveBeenCalledTimes(change === "move refused" ? 1 : 0);
    expect(h.open).not.toHaveBeenCalled();
  } finally {
    release?.();
    finish?.();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
});
