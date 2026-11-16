import { beforeEach, expect, it, vi } from "vitest";
import { freshThreadState } from "./session_projection";
import type { ThreadState } from "./session_types";

const h = vi.hoisted(() => ({
  threads: new Map<string, ThreadState>(),
  account: false,
  copying: false,
  unknownCopy: false,
  absentCopy: false,
}));
vi.mock("./sessions", () => ({
  threads: { getSnapshot: () => ({ threads: h.threads }) },
}));
vi.mock("./authentication", () => ({
  hasActiveAuthentication: () => h.account,
}));
vi.mock("./file_copy_jobs", () => ({
  hasUnsettledFileCopies: () => h.copying,
  fileCopyJobs: {
    getSnapshot: () =>
      h.absentCopy
        ? [{ phase: "uncertain", absence: true }]
        : h.unknownCopy
          ? [
              {
                phase: "uncertain",
                status: { state: "unknown", settled: true },
              },
            ]
          : [],
  },
}));
import { exitReviewReason } from "./exit_impact";

beforeEach(() => {
  h.threads.clear();
  h.account = false;
  h.copying = false;
  h.unknownCopy = false;
  h.absentCopy = false;
});
it("reviews file saves even after the file view is gone", () => {
  h.copying = true;
  expect(exitReviewReason()).not.toBeNull();
});
it("reviews an ended save with an unknown result before exiting", () => {
  h.unknownCopy = true;
  expect(exitReviewReason()).not.toBeNull();
});
it("does not silently dismiss a missing operation as a successful copy", () => {
  h.absentCopy = true;
  expect(exitReviewReason()).not.toBeNull();
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
    expect(exitReviewReason()).not.toBeNull();
  },
);
it("includes account work after its settings view has closed", () => {
  h.account = true;
  expect(exitReviewReason()).not.toBeNull();
});
it("does not treat preserved paused drafts as active Agent work", () => {
  const thread = freshThreadState("a", "fixture", "/p", "a");
  thread.queued = [[{ type: "text", text: "keep without sending" }]];
  thread.queuePaused = "stopped";
  h.threads.set(thread.key, thread);
  expect(exitReviewReason()).toBeNull();
  expect(thread.queued).toHaveLength(1);
});
