import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { canonicalRecoveryOpen } from "./session_recovery";
import { STRINGS } from "./strings";

const code = "AGENT_WORK_DIRECTORY_UNAVAILABLE";
const message = "工作文件夹不存在或无法访问，请恢复后重试。原内容已保留。";
let serial = 0;
const keys: string[] = [];

afterEach(async () => {
  h.invoke.mockResolvedValue(null);
  for (const key of keys.splice(0)) await threads.close(key);
  h.invoke.mockReset();
});

it.each([code, new Error(code), `${code}: private-path`])(
  "retains content and uncertain work without resending after a directory rejection: %s",
  async (reason) => {
    const cwd = "/owned/missing-location";
    const nativeSessionId = `directory-${++serial}`;
    const key = `directory-fixture:${cwd}:${nativeSessionId}`;
    keys.push(key);
    const old = threads.markOpenFailed(
      key,
      "directory-fixture",
      cwd,
      nativeSessionId,
      "initial",
    );
    old.items.push({
      kind: "agent",
      id: "old",
      text: "Retained original body",
      streaming: false,
      time: 0,
    });
    old.queued = [[{ type: "text", text: "Retained queue" }]];
    old.queuePaused = "stopped";
    old.uncertainPrompt = [{ type: "text", text: "Unknown prior request" }];
    old.stopUnconfirmed = true;
    const retained = structuredClone({
      items: old.items,
      queued: old.queued,
      uncertainPrompt: old.uncertainPrompt,
    });
    h.invoke.mockImplementation(async (command) => {
      if (command === "session_open") throw reason;
      throw new Error(`Unexpected IPC ${command}`);
    });
    await expect(
      threads.open({ agentId: old.agentId, cwd, nativeSessionId }),
    ).rejects.toBe(reason);
    expect(threads.thread(key)).toBe(old);
    expect(old.openError).toBe(
      reason === `${code}: private-path`
        ? STRINGS.repair.reconnectFailed
        : message,
    );
    expect({
      items: old.items,
      queued: old.queued,
      uncertainPrompt: old.uncertainPrompt,
    }).toEqual(retained);
    expect(old.stopUnconfirmed).toBe(true);
    expect(old.queuePaused).toBe("stopped");
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      "session_open",
    ]);
  },
);

it("keeps the same location explanation at the canonical recovery precheck without opening a process", async () => {
  const input = {
    agentId: "directory-fixture",
    cwd: "/owned/missing-location",
    nativeSessionId: "precheck",
  };
  const states = new Map();
  const failed = vi.fn(threads.markOpenFailed.bind(threads));
  const open = vi.fn();
  h.invoke.mockRejectedValue(code);
  await expect(canonicalRecoveryOpen(input, states, open, failed)).rejects.toBe(
    code,
  );
  expect(failed).toHaveBeenCalledWith(
    "directory-fixture:/owned/missing-location:precheck",
    input.agentId,
    input.cwd,
    input.nativeSessionId,
    message,
    false,
    true,
  );
  keys.push("directory-fixture:/owned/missing-location:precheck");
  expect(open).not.toHaveBeenCalled();
  expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
    "agent_work_get",
  ]);
});
