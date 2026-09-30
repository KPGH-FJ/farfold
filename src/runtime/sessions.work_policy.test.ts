import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { draftPersistence } from "./drafts";
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  h.invoke.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});
it("pauses every Agent in one location while preserving running work, approvals, and queue order", async () => {
  const make = (agent: string, cwd: string) => {
    const s = threads.markOpenFailed(
      `${agent}:${cwd}:location`,
      agent,
      cwd,
      "location",
      "fixture",
    );
    s.openError = null;
    s.queued = [
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "second" }],
    ];
    return s;
  };
  const first = make("a", "/scope"),
    another = make("b", "/scope"),
    elsewhere = make("a", "/elsewhere");
  first.running = true;
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown): void;
    }
  ).applyChannelEvent(first.key, {
    kind: "permissionRequest",
    requestId: "approval",
    toolCall: { toolCallId: "approval", title: "Review" },
    options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }],
  });
  const original = first.queued;
  threads.updateWork("/scope", { a: true, b: false }, false);
  expect(first.workEnabled).toBe(false);
  expect(another.workEnabled).toBe(false);
  expect(elsewhere.workEnabled).toBe(true);
  expect(first.running).toBe(true);
  expect(first.pendingPermissions.map((p) => p.requestId)).toEqual([
    "approval",
  ]);
  expect(first.queued).toBe(original);
  expect(first.queuePaused).toBe("work_disabled");
  await threads.continueQueue(another.key);
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
  threads.updateWork("/scope", { a: false, b: false }, true);
  expect(first.workEnabled).toBe(true);
  expect(another.workEnabled).toBe(true);
  expect(first.queuePaused).toBe("work_disabled");
  expect(first.pendingPermissions).toHaveLength(1);
  expect(first.queued).toBe(original);
  expect(another.queued).toHaveLength(2);
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
});
