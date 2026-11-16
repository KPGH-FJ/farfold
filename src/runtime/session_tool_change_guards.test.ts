import { expect, it, vi } from "vitest";
import { SessionToolChangeGuards } from "./session_tool_change_guards";
import { freshThreadState } from "./session_projection";
import { configChangeBusy } from "./protected_config";
import { canDrain } from "./queue";
import { composerDrafts } from "./drafts";
import type { ThreadState } from "./session_types";

const operation = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";
const other = "aaaaaaaa-aaaa-aaaa-aaaa-000000000002";
let sequence = 0;
function fixture() {
  const owner = freshThreadState(
    `tool-change-guard-${++sequence}`,
    "fixture",
    "/owned",
    "native",
  );
  owner.connectionId = "connection";
  let current: ThreadState | undefined = owner;
  const emit = vi.fn();
  const guard = new SessionToolChangeGuards({ current: () => current, emit });
  return { owner, emit, guard, replace: (s?: ThreadState) => (current = s) };
}

it("blocks configuration and queued dispatch while an exact operation remains unresolved", () => {
  const { owner, guard, emit } = fixture();
  const observer = vi.fn();
  const unsubscribe = guard.subscribe(observer);
  expect(guard.claim(owner, operation)).toBe(true);
  expect(configChangeBusy(owner)).toBe(true);
  owner.queued.push([{ type: "text", text: "keep queued" }]);
  expect(canDrain(owner)).toBe(false);
  unsubscribe(); // A panel dismissal only removes observation.
  expect(guard.has(owner, operation)).toBe(true);
  expect(guard.claim(owner, other)).toBe(false);
  expect(guard.settle(owner, other)).toBe(false);
  expect(owner.configuring).toBe(true);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(observer).toHaveBeenCalledTimes(1);
});

it("preserves paused queue, draft and independent errors after matching completion", () => {
  const { owner, guard } = fixture();
  owner.queued.push([{ type: "text", text: "keep queued" }]);
  owner.queuePaused = "stopped";
  const draft = composerDrafts.read(`session:${owner.key}`);
  draft.text = "keep draft";
  expect(guard.claim(owner, operation)).toBe(true);
  owner.configError = "independent configuration failure";
  const queue = owner.queued;
  expect(guard.settle(owner, operation)).toBe(true);
  expect(owner.configuring).toBe(false);
  expect(owner.queued).toBe(queue);
  expect(owner.queuePaused).toBe("stopped");
  expect(owner.configError).toBe("independent configuration failure");
  expect(composerDrafts.read(`session:${owner.key}`).text).toBe("keep draft");
  expect(canDrain(owner)).toBe(false);
});

it.each([
  "running",
  "submitting",
  "configuring",
  "reconnecting",
  "stopUnconfirmed",
] as const)("does not replace another %s operation", (key) => {
  const { owner, guard, emit } = fixture();
  owner[key] = true;
  expect(guard.claim(owner, operation)).toBe(false);
  expect(guard.settle(owner, operation)).toBe(false);
  expect(owner[key]).toBe(true);
  expect(emit).not.toHaveBeenCalled();
});

it("does not race an unpaused queue or an input submission", () => {
  const { owner, guard } = fixture();
  owner.queued.push([{ type: "text", text: "already waiting" }]);
  expect(guard.claim(owner, operation)).toBe(false);
  owner.queuePaused = "stopped";
  const draft = composerDrafts.read(`session:${owner.key}`);
  draft.sendPending = true;
  expect(guard.claim(owner, operation)).toBe(false);
  draft.sendPending = false;
  expect(guard.claim(owner, operation)).toBe(true);
});

it("cannot clear a replacement thread, connection or changed service", () => {
  for (const change of ["thread", "connection", "service"] as const) {
    const h = fixture();
    expect(h.guard.claim(h.owner, operation)).toBe(true);
    if (change === "thread") h.replace({ ...h.owner });
    if (change === "connection") h.owner.connectionId = "replacement";
    if (change === "service") h.owner.serviceContext = "different";
    expect(h.guard.settle(h.owner, operation)).toBe(false);
    expect(h.owner.configuring).toBe(true);
  }
});

it("confirmed recovery releases only the matching change and keeps the old route closed", () => {
  const { owner, guard } = fixture();
  expect(guard.claim(owner, operation)).toBe(true);
  expect(guard.markUnknown(owner, operation)).toBe(true);
  expect(guard.resolveRecovery(owner, other)).toBe(false);
  expect(owner.configuring).toBe(true);
  expect(guard.resolveRecovery(owner, operation)).toBe(true);
  expect(owner.configuring).toBe(false);
  expect(owner.sessionToolRecoveryRequired).toBe(false);
  expect(owner.connectionLost).toBe(true);
  expect(owner.openError).toContain("重新打开");
  owner.queued.push([{ type: "text", text: "do not send" }]);
  expect(canDrain(owner)).toBe(false);
});

it("a proven unsent operation releases its original object without clearing a replacement", () => {
  const h = fixture();
  h.guard.claim(h.owner, operation);
  const replacement = { ...h.owner };
  h.replace(replacement);
  expect(h.guard.releaseUnsent(h.owner, other)).toBe(false);
  expect(h.guard.releaseUnsent(h.owner, operation)).toBe(true);
  expect(h.owner.configuring).toBe(false);
  expect(replacement.configuring).toBe(true);
  expect(h.guard.has(h.owner)).toBe(false);
});
