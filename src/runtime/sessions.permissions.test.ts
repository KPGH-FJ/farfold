import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, normalizeConfigOptions } from "./sessions";
import { draftPersistence } from "./drafts";
import { canDrain } from "./queue";
const option = (value = "ask") => [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: value,
    options: [
      { value: "ask", name: "Ask", description: "Ask before changing files" },
    ],
  },
];
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  h.invoke.mockImplementation(async () => []);
});
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});
function seed(id: string) {
  const s = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  s.openError = null;
  s.permissionConfigId = "mode";
  s.permissionState = "required";
  s.configOptions = normalizeConfigOptions(option());
  s.queued = [[{ type: "text", text: "next" }]];
  s.queuePaused = null;
  return s;
}
it("keeps loaded permissions and queued messages blocked until an explicit matching receipt", async () => {
  const s = seed("permission-required");
  expect(canDrain(s)).toBe(false);
  h.invoke.mockResolvedValue(option());
  await threads.setConfig(s.key, "mode", "ask");
  expect(s.permissionState).toBe("ready");
  expect(s.queuePaused).toBe("stopped");
  expect(canDrain(s)).toBe(false);
  expect(s.configOptions[0].options[0].description).toBe(
    "Ask before changing files",
  );
});
it("does not accept a mismatched result or late update as permission confirmation", async () => {
  const s = seed("permission-unknown");
  h.invoke.mockResolvedValue(option("other"));
  await expect(threads.setConfig(s.key, "mode", "ask")).rejects.toBeTruthy();
  expect(s.permissionState).toBe("unknown");
  (
    threads as unknown as { applyChannelEvent(k: string, e: unknown): void }
  ).applyChannelEvent(s.key, {
    kind: "permissionState",
    permissionConfigId: "mode",
    permissionState: "ready",
  });
  expect(s.permissionState).toBe("unknown");
  expect(canDrain(s)).toBe(false);
});
it("failed or lost replies retain unknown until a new explicit successful request", async () => {
  const s = seed("permission-timeout");
  h.invoke.mockRejectedValue(new Error("timeout"));
  await expect(threads.setConfig(s.key, "mode", "ask")).rejects.toBeTruthy();
  expect(s.permissionState).toBe("unknown");
  h.invoke.mockResolvedValue(option());
  await threads.setConfig(s.key, "mode", "ask");
  expect(s.permissionState).toBe("ready");
  expect(s.queuePaused).toBe("stopped");
});
it("blocks permission changes while tasks, approval, stopping or reconnect are active", async () => {
  for (const field of [
    "running",
    "stopping",
    "stopUnconfirmed",
    "reconnecting",
  ] as const) {
    const s = seed(`permission-${field}`);
    s[field] = true;
    await expect(threads.setConfig(s.key, "mode", "ask")).rejects.toBeTruthy();
  }
  const s = seed("permission-approval");
  s.pendingPermissions = [
    {
      requestId: "r",
      status: "pending",
      error: null,
      toolCallId: null,
      title: "Approval",
      kind: "edit",
      locations: [],
      options: [],
      decision: null,
    },
  ];
  await expect(threads.setConfig(s.key, "mode", "ask")).rejects.toBeTruthy();
  expect(h.invoke).not.toHaveBeenCalled();
});
it("pauses remaining queue at exit without cancelling work or losing uncertain content", () => {
  const s = seed("permission-exit");
  s.running = true;
  const uncertain = seed("permission-exit-unknown");
  uncertain.uncertainPrompt = uncertain.queued[0];
  uncertain.queuePaused = "uncertain";
  threads.pauseQueuesForExit();
  expect(s.queuePaused).toBe("stopped");
  expect(s.running).toBe(true);
  expect(s.queued).toHaveLength(1);
  expect(uncertain.queuePaused).toBe("uncertain");
});

it("cannot resume the queue while permission confirmation is still outstanding", async () => {
  const s = seed("permission-confirm-in-flight");
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const setting = threads.setConfig(s.key, "mode", "ask");
  expect(s.permissionState).toBe("changing");
  await threads.continueQueue(s.key);
  expect(s.queuePaused).toBe("stopped");
  finish(option());
  await setting;
  expect(s.queuePaused).toBe("stopped");
});

it("does not let an older successful setter overwrite a newer unknown event and actual options", async () => {
  const s = seed("permission-out-of-order");
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const setting = threads.setConfig(s.key, "mode", "ask");
  const channel = threads as unknown as {
    applyChannelEvent(k: string, e: unknown): void;
  };
  channel.applyChannelEvent(s.key, {
    kind: "permissionState",
    permissionConfigId: "mode",
    permissionState: "unknown",
  });
  channel.applyChannelEvent(s.key, {
    update: {
      sessionUpdate: "config_option_update",
      configOptions: option("other"),
    },
  });
  expect(s.permissionState).toBe("unknown");
  expect(s.configOptions[0].currentValue).toBe("other");
  finish(option("ask"));
  await expect(setting).rejects.toBeTruthy();
  expect(s.permissionState).toBe("unknown");
  expect(s.configOptions[0].currentValue).toBe("other");
  expect(canDrain(s)).toBe(false);
  expect(s.queuePaused).toBe("stopped");
});
