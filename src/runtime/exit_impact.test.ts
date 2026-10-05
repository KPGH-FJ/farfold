import { beforeEach, expect, it, vi } from "vitest";
import { freshThreadState } from "./session_projection";
import type { ThreadState } from "./session_types";

const h = vi.hoisted(() => ({
  threads: new Map<string, ThreadState>(),
  account: false,
}));
vi.mock("./sessions", () => ({
  threads: { getSnapshot: () => ({ threads: h.threads }) },
}));
vi.mock("./authentication", () => ({
  hasActiveAuthentication: () => h.account,
}));
import { exitNeedsReview } from "./exit_impact";

beforeEach(() => {
  h.threads.clear();
  h.account = false;
});
it.each([
  { running: true },
  { connectionOutcomeUnknown: true },
  { stopUnconfirmed: true },
  { activeToolCallIds: ["still-active"] },
  { permissionState: "unknown" },
  { configuring: true },
] as Partial<ThreadState>[])(
  "includes background or uncertain work when quitting: %j",
  (patch) => {
    const thread = Object.assign(
      freshThreadState("a", "fixture", "/p", "a"),
      patch,
    );
    h.threads.set(thread.key, thread);
    expect(exitNeedsReview()).toBe(true);
  },
);
it("includes account work after its settings view has closed", () => {
  h.account = true;
  expect(exitNeedsReview()).toBe(true);
});
it("does not treat preserved paused drafts as active Agent work", () => {
  const thread = freshThreadState("a", "fixture", "/p", "a");
  thread.queued = [[{ type: "text", text: "keep without sending" }]];
  thread.queuePaused = "stopped";
  h.threads.set(thread.key, thread);
  expect(exitNeedsReview()).toBe(false);
  expect(thread.queued).toHaveLength(1);
});
