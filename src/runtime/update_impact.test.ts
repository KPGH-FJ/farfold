import { expect, it } from "vitest";
import { freshThreadState } from "./session_projection";
import { updateConversationBlocker, UPDATE_IMPACT as S } from "./update_impact";
import type { ThreadState } from "./session_types";

it.each([
  [{ running: true }, S.running],
  [{ activeToolCallIds: ["tool-tail"] }, S.tools],
  [{ stopping: true }, S.stopping],
  [{ stopUnconfirmed: true }, S.unknown],
  [{ permissionState: "unknown" }, S.unknown],
  [{ connectionOutcomeUnknown: true }, S.unknown],
  [{ submitting: true }, S.sending],
  [{ reconnecting: true }, S.connecting],
  [{ configuring: true }, S.changing],
] as [Partial<ThreadState>, string][])(
  "describes the same concrete work that blocks installation: %j",
  (patch, reason) => {
    const thread = freshThreadState("a", "fixture", "/p", "a");
    Object.assign(thread, patch);
    expect(updateConversationBlocker(thread)).toBe(reason);
  },
);

it("allows saving a paused queue without treating a permission confirmation requirement as live work", () => {
  const thread = freshThreadState("a", "fixture", "/p", "a");
  thread.queued = [[{ type: "text", text: "do not send" }]];
  thread.queuePaused = "stopped";
  thread.permissionConfigId = "permission";
  thread.permissionState = "required";
  expect(updateConversationBlocker(thread)).toBeNull();
  expect(thread.queued).toHaveLength(1);
});
