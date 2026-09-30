import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { AgentPreparation } from "./agent_preparation";
import { draftPersistence } from "./drafts";
const settings = new Map<string, unknown>();
function localCommand(command: string, args?: Record<string, unknown>) {
  if (command === "settings_get")
    return args?.key === "autoArchiveDays"
      ? 30
      : (settings.get(String(args?.key)) ?? null);
  if (command === "settings_set") {
    settings.set(String(args?.key), structuredClone(args?.value));
    return null;
  }
  return [];
}
beforeEach(() => {
  settings.clear();
  h.invoke.mockReset();
});
afterEach(async () => {
  await draftPersistence.flush();
});

it("isolates simultaneous preparation and ordinary drafts even when both request a fresh session", async () => {
  const opens: ((result: unknown) => void)[] = [];
  h.invoke.mockImplementation((command: string, args) =>
    command === "session_open"
      ? new Promise((resolve) => {
          opens.push(resolve);
        })
      : Promise.resolve(localCommand(command, args)),
  );
  const ordinary = threads.open({
    agentId: "scope-test",
    cwd: "/work",
    fresh: true,
  });
  const preparing = threads.open({
    agentId: "scope-test",
    cwd: "/work",
    fresh: true,
    draftScope: "setup",
  });
  expect(opens).toHaveLength(2);
  opens[0]({ cwd: "/work", nativeSessionId: "ordinary", resumed: false });
  opens[1]({ cwd: "/work", nativeSessionId: "preparation", resumed: false });
  const [a, b] = await Promise.all([ordinary, preparing]);
  expect(a.key).not.toBe(b.key);
  expect(await threads.open({ agentId: "scope-test", cwd: "/work" })).toBe(a);
  expect(
    await threads.open({
      agentId: "scope-test",
      cwd: "/work",
      draftScope: "setup",
    }),
  ).toBe(b);
});

it.each(["accepted", "rejected", "unknown"] as const)(
  "returns %s admission without pretending the Agent finished",
  async (status) => {
    h.invoke.mockImplementation(async (command: string, args) =>
      command === "session_prompt" ? { status } : localCommand(command, args),
    );
    const s = threads.markOpenFailed(
      `receipt:/work:${status}`,
      "receipt",
      "/work",
      status,
      "",
    );
    s.openError = null;
    s.connectionLost = false;
    expect(
      await threads.send(s.key, [{ type: "text", text: "check" }]),
    ).toEqual({ status });
    expect(s.items.some((item) => item.kind === "settled")).toBe(false);
  },
);

it("requires explicit preparation of a fresh draft after a rejected test, without resuming a paused queue", async () => {
  h.invoke.mockClear();
  let sequence = 0;
  let prompts = 0;
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_open")
      return {
        cwd: "/work",
        nativeSessionId: `rejection-${++sequence}`,
        resumed: false,
      };
    if (command === "session_prompt")
      return ++prompts === 1
        ? { status: "rejected", reason: "failed" }
        : { status: "accepted" };
    return localCommand(command, args);
  });
  const controller = new AgentPreparation(threads, () => "rejected-test");
  const send = vi.spyOn(threads, "send");
  const input = {
    agentId: "rejected-prepare",
    agentName: "Example",
    cwd: "/work",
    program: "program",
    service: null,
  };
  await controller.prepare(input);
  const rejectedKey = controller.getSnapshot().threadKey!;
  const rejected = threads.thread(rejectedKey)!;
  await controller.start();
  expect(controller.getSnapshot().phase).toBe("failed");
  expect(rejected.queuePaused).toBe("failed");
  expect(rejected.queued).toHaveLength(0);

  await controller.start();
  expect(prompts).toBe(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(rejected.queued).toHaveLength(0);
  await controller.prepare(input, true);
  const freshKey = controller.getSnapshot().threadKey!;
  expect(freshKey).not.toBe(rejectedKey);
  expect(threads.thread(rejectedKey)).toBeUndefined();
  expect(rejected.queuePaused).toBe("failed");
  expect(controller.getSnapshot().phase).toBe("untested");
  expect(prompts).toBe(1);

  await controller.start();
  expect(prompts).toBe(2);
  expect(threads.thread(freshKey)?.identity).toBe("established");
  send.mockRestore();
});
