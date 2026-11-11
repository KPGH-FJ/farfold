import { expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { emitOpeningHeader } from "./session_open_test_fixture";
import { deferred, flush } from "./session_tools.test-support";

function basicOpen(agentId: string) {
  let sequence = 0;
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_open") {
      const result = {
        cwd: "/owned-tools",
        nativeSessionId: `race-${agentId}-${++sequence}`,
        connectionId: `connection-${sequence}`,
        resumed: false,
      };
      emitOpeningHeader(args, result);
      return result;
    }
    if (command === "settings_get") return null;
    return [];
  });
  return () => threads.open({ agentId, cwd: "/owned-tools" });
}

it("keeps a newer draft's reuse mapping when an older conversation is saved late", async () => {
  const open = basicOpen("tool-saved-race");
  const original = await open();
  const operationId = "aaaaaaaa-aaaa-aaaa-aaaa-000000000002";
  expect(threads.toolChanges.claim(original, operationId)).toBe(true);
  const replacement = await threads.open({
    agentId: "tool-saved-race",
    cwd: "/owned-tools",
    fresh: true,
  });
  expect(replacement).not.toBe(original);
  expect(threads.toolChanges.saved(original, operationId)).toBe(true);
  expect(await open()).toBe(replacement);
  threads.toolChanges.settle(original, operationId);
});

it("does not discard or close an empty conversation with an admitted tool operation", async () => {
  const owner = await basicOpen("tool-saved-close")();
  const operationId = "aaaaaaaa-aaaa-aaaa-aaaa-000000000003";
  expect(threads.toolChanges.claim(owner, operationId)).toBe(true);
  h.invoke.mockClear();
  await threads.discardDraft(owner.key);
  expect(threads.thread(owner.key)).toBe(owner);
  expect(
    h.invoke.mock.calls.some(([command]) =>
      ["session_close", "session_dismiss"].includes(command),
    ),
  ).toBe(false);
  threads.toolChanges.settle(owner, operationId);
});

it("retires the saved draft and refreshes its local index without submitting queued input", async () => {
  let count = 0;
  const index = deferred();
  let delayed = false;
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_open") {
      const result = {
        cwd: "/owned-tools",
        nativeSessionId: `saved-${++count}`,
        connectionId: `connection-${count}`,
        resumed: false,
      };
      emitOpeningHeader(args, result);
      return result;
    }
    if (command === "session_index_list") return delayed ? index.promise : [];
    if (command === "settings_get") return null;
    if (command === "settings_set") return null;
    if (command === "session_prompt") throw new Error("must not dispatch");
    return [];
  });
  const owner = await threads.open({
    agentId: "tool-saved",
    cwd: "/owned-tools",
  });
  expect(owner.identity).toBe("draft");
  expect(
    await threads.open({ agentId: "tool-saved", cwd: "/owned-tools" }),
  ).toBe(owner);
  const operationId = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";
  expect(threads.toolChanges.claim(owner, operationId)).toBe(true);
  owner.queued.push([{ type: "text", text: "keep pending" }]);
  owner.queuePaused = "stopped";
  const queued = owner.queued;
  delayed = true;
  expect(threads.toolChanges.saved(owner, operationId)).toBe(true);
  expect(owner.identity).toBe("established");
  expect(owner.configuring).toBe(true);
  expect(threads.toolChanges.settle(owner, operationId)).toBe(true);
  index.resolve([]);
  await flush();
  expect(owner.queued).toBe(queued);
  expect(owner.queuePaused).toBe("stopped");
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_touch"),
  ).toBe(false);
  delayed = false;
  const next = await threads.open({
    agentId: "tool-saved",
    cwd: "/owned-tools",
  });
  expect(next).not.toBe(owner);
  expect(threads.thread(owner.key)).toBe(owner);
});
