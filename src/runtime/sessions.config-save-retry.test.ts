import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));

import { threads } from "./sessions";
import { draftPersistence } from "./drafts";
import { archiveActivity } from "./archive_activity";
import { freshThreadState } from "./session_projection";
import { pauseQueue } from "./queue";
import type { ConfigCheck } from "./config_check";
import type { ConfirmedConfigUpdate } from "./session_configuration";
import type { ThreadState } from "./session_types";
import { STRINGS } from "./strings";

type Receipt = ConfigCheck & { configuration: ConfirmedConfigUpdate };
let sequence = 0;
function event(s: ThreadState, value: unknown) {
  (
    threads as unknown as {
      applyChannelEvent(key: string, event: unknown): void;
    }
  ).applyChannelEvent(s.key, value);
}
function fixture(configured = true) {
  const id = `save-retry-${sequence++}`;
  const s = threads.markOpenFailed(
    `retry:/fixture:${id}`,
    "retry",
    "/fixture",
    id,
    "fixture",
  );
  s.openError = null;
  s.connectionId = `connection-${id}`;
  s.identity = "established";
  s.service = configured
    ? { id: "selected-service", fingerprint: "same-source", model: "a" }
    : undefined;
  s.configOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "prefix/a",
      options: ["prefix/a", "prefix/b"].map((value) => ({
        value,
        name: value,
      })),
    },
    {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [{ value: "low", name: "Low" }],
    },
  ];
  s.items = [
    {
      kind: "agent",
      id: "history",
      text: "retained history",
      streaming: false,
      time: 1,
    },
  ];
  const original = structuredClone(s.configOptions);
  const originalService = structuredClone(s.service ?? null);
  const updated = original.map((option) => ({
    ...option,
    currentValue: option.id === "model" ? "prefix/b" : "high",
    options:
      option.id === "effort"
        ? [{ value: "high", name: "New effort" }]
        : option.options,
  }));
  const check: ConfigCheck = {
    status: "ready",
    issues: [],
    protectedIds: ["effort", "model"],
    current: {
      choices: updated.map((option) => ({
        id: option.id,
        category: option.category,
        type: option.type,
        value: option.currentValue,
      })),
    },
  };
  s.configCheck = {
    ...check,
    current: {
      choices: original.map((option) => ({
        id: option.id,
        category: option.category,
        type: option.type,
        value: option.currentValue,
      })),
    },
  };
  const receipt: Receipt = {
    ...check,
    configuration: {
      configOptions: updated,
      configOptionsModern: true,
      configCheck: check,
      permissionConfigId: null,
      permissionState: "ready",
      service: originalService ? { ...originalService, model: "b" } : null,
    },
  };
  let confirm: () => unknown = () => {
    event(s, { kind: "configCheck", check });
    return receipt;
  };
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_set_config") {
      event(s, {
        kind: "configCheck",
        check: { ...check, status: "record_failed" },
      });
      throw new Error("Agent accepted the choice; metadata save failed");
    }
    if (command === "session_confirm_config") {
      expect(args.displayed).toEqual(check.current);
      return confirm();
    }
    if (command === "session_prompt") return { status: "accepted" };
    return command === "settings_get" ? null : [];
  });
  const failSave = async () => {
    await expect(threads.setConfig(s.key, "model", "prefix/b")).rejects.toThrow(
      STRINGS.repair.configFailed,
    );
    expect(s.configOptions).toEqual(original);
    expect(s.service ?? null).toEqual(originalService);
    expect(s.configCheck?.status).toBe("record_failed");
    expect(s.modelDrift).toBe(true);
    expect(s.queuePaused).toBe("unavailable");
    expect(
      h.invoke.mock.calls.some(([name]) => name === "session_prompt"),
    ).toBe(false);
  };
  return {
    s,
    check,
    receipt,
    updated,
    original,
    originalService,
    failSave,
    confirm: (callback: () => unknown) => {
      confirm = callback;
    },
  };
}
function noPrompt() {
  expect(h.invoke.mock.calls.some(([name]) => name === "session_prompt")).toBe(
    false,
  );
}
function retained(f: ReturnType<typeof fixture>) {
  expect(f.s.configOptions).toEqual(f.original);
  expect(f.s.service ?? null).toEqual(f.originalService);
  expect(f.s.configError).toBe(STRINGS.repair.confirmConfigFailed);
  expect(f.s.items[0]).toMatchObject({ text: "retained history" });
  noPrompt();
}

beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
  h.invoke.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "publishes the complete saved configuration after explicit retry (configured service: %s)",
  async (configured) => {
    const f = fixture(configured);
    await f.failSave();
    const queue = f.s.queued;
    f.confirm(() => {
      event(f.s, { kind: "configCheck", check: f.check });
      // A ready event alone cannot publish or release the old failure.
      expect.soft(f.s.configOptions).toEqual(f.original);
      expect.soft(f.s.configCheck?.status).toBe("record_failed");
      expect.soft(f.s.queuePaused).toBe("unavailable");
      return f.receipt;
    });
    await threads.confirmConfig(f.s.key);
    expect(f.s.configOptions).toEqual(f.updated);
    expect(f.s.service ?? null).toEqual(f.receipt.configuration.service);
    expect(f.s.configCheck).toEqual(f.check);
    expect(f.s.modelDrift).toBe(false);
    expect(f.s.configError).toBeNull();
    expect(f.s.queuePaused).toBeNull();
    expect(f.s.queued).toBe(queue);
    expect(f.s.items[0]).toMatchObject({ text: "retained history" });
    noPrompt();
    await expect(
      threads.send(f.s.key, [{ type: "text", text: "explicit next input" }]),
    ).resolves.toEqual({ status: "accepted" });
    const prompts = h.invoke.mock.calls.filter(
      ([name]) => name === "session_prompt",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0][1]).toMatchObject({ expectedCurrent: f.check.current });
    expect(
      h.invoke.mock.calls.filter(([name]) => name === "session_set_config"),
    ).toHaveLength(1);
  },
);

it.each([
  "check-only",
  "missing-options",
  "null-options",
  "malformed-options",
  "wrong-source",
  "missing-service",
  "mismatched-check",
])("keeps the old baseline blocked after a %s receipt", async (kind) => {
  const f = fixture();
  await f.failSave();
  const receipt = structuredClone(f.receipt) as unknown as Record<string, any>;
  if (kind === "check-only") delete receipt.configuration;
  if (kind === "missing-options") delete receipt.configuration.configOptions;
  if (kind === "null-options") receipt.configuration.configOptions = null;
  if (kind === "malformed-options")
    receipt.configuration.configOptions = [
      { id: "model", currentValue: "prefix/b" },
    ];
  if (kind === "wrong-source")
    receipt.configuration.service.fingerprint = "foreign-source";
  if (kind === "missing-service") delete receipt.configuration.service;
  if (kind === "mismatched-check")
    receipt.configuration.configCheck = f.s.configCheck;
  f.confirm(() => {
    event(f.s, { kind: "configCheck", check: f.check });
    return receipt;
  });
  await threads.confirmConfig(f.s.key);
  retained(f);
  await expect(
    threads.send(f.s.key, [{ type: "text", text: "must stay local" }]),
  ).rejects.toThrow();
  noPrompt();
});

it.each([
  "unknown",
  "record_failed",
  "drift",
  "normalized-options",
  "raw-options",
  "permission",
  "busy",
])(
  "does not wash away an intervening %s with a later ready receipt",
  async (kind) => {
    const f = fixture();
    await f.failSave();
    f.confirm(() => {
      event(f.s, { kind: "configCheck", check: f.check });
      if (["unknown", "record_failed", "drift"].includes(kind)) {
        event(f.s, {
          kind: "configCheck",
          check: {
            ...f.check,
            status: kind === "record_failed" ? "record_failed" : "blocked",
            issues: [
              {
                category: "model",
                reason: kind === "unknown" ? "unknown" : "changed",
                expected: "prefix/b",
                current: "prefix/c",
              },
            ],
          },
        });
      } else if (kind === "normalized-options")
        event(f.s, { kind: "configOptions", options: f.updated, modern: true });
      else if (kind === "raw-options")
        event(f.s, {
          update: {
            sessionUpdate: "config_option_update",
            configOptions: f.updated,
          },
        });
      else if (kind === "permission")
        event(f.s, {
          kind: "permissionState",
          permissionConfigId: "permission",
          permissionState: "unknown",
        });
      else {
        f.s.running = true;
        event(f.s, { kind: "notification", method: "fixture_busy" });
        f.s.running = false;
      }
      event(f.s, { kind: "configCheck", check: f.check });
      return f.receipt;
    });
    await threads.confirmConfig(f.s.key);
    retained(f);
    await expect(
      threads.send(f.s.key, [{ type: "text", text: "must stay local" }]),
    ).rejects.toThrow();
    noPrompt();
  },
);

it.each(["thread", "connection", "service", "displayed"])(
  "does not publish a complete receipt after its %s owner changes",
  async (kind) => {
    const f = fixture();
    await f.failSave();
    let replacement: ThreadState | undefined;
    f.confirm(() => {
      if (kind === "thread") {
        replacement = freshThreadState(
          f.s.key,
          f.s.agentId,
          f.s.cwd,
          f.s.nativeSessionId,
        );
        threads.getSnapshot().threads.set(f.s.key, replacement);
      } else if (kind === "connection") f.s.connectionId = "new-connection";
      else if (kind === "service") f.s.service!.fingerprint = "new-source";
      else
        (
          f.s.configCheck!.current as { choices: { value: string }[] }
        ).choices[0].value = "prefix/c";
      event(f.s, { kind: "configCheck", check: f.check });
      return f.receipt;
    });
    await threads.confirmConfig(f.s.key);
    expect(f.s.configOptions).toEqual(f.original);
    expect(f.s.service?.model).toBe("a");
    if (replacement) {
      expect(threads.thread(f.s.key)).toBe(replacement);
      expect(replacement.configOptions).toEqual([]);
      expect(replacement.configError).toBeNull();
    } else
      expect(f.s.configError).toBe(
        kind === "displayed" ? STRINGS.repair.confirmConfigFailed : null,
      );
    expect(f.s.configuring).toBe(false);
    noPrompt();
  },
);

it.each(["queue", "later-stop", "later-unavailable"])(
  "publishes saved values without releasing a %s pause or draining input",
  async (kind) => {
    const f = fixture();
    await f.failSave();
    const oldInput = [{ type: "text" as const, text: "retained queued input" }];
    if (kind === "queue") f.s.queued.push(oldInput);
    f.confirm(() => {
      event(f.s, { kind: "configCheck", check: f.check });
      if (kind !== "queue")
        pauseQueue(f.s, kind === "later-stop" ? "stopped" : "unavailable");
      return f.receipt;
    });
    await threads.confirmConfig(f.s.key);
    expect(f.s.configOptions).toEqual(f.updated);
    expect(f.s.queuePaused).toBe(
      kind === "later-stop" ? "stopped" : "unavailable",
    );
    expect(f.s.queued).toEqual(kind === "queue" ? [oldInput] : []);
    noPrompt();
  },
);

it("keeps an explicit no-configuration retry distinct from a missing options field", async () => {
  const f = fixture(false);
  f.s.configOptions = [];
  const check: ConfigCheck = {
    status: "ready",
    issues: [],
    protectedIds: [],
    current: { choices: [] },
  };
  event(f.s, {
    kind: "configCheck",
    check: { ...check, status: "record_failed" },
  });
  h.invoke.mockImplementation(async (command) => {
    if (command !== "session_confirm_config") return [];
    event(f.s, { kind: "configCheck", check });
    return {
      ...check,
      configuration: {
        configOptions: null,
        configOptionsModern: false,
        configCheck: check,
        service: null,
        permissionConfigId: null,
        permissionState: "ready",
      },
    };
  });
  await threads.confirmConfig(f.s.key);
  expect(f.s.configOptions).toEqual([]);
  expect(f.s.configCheck).toEqual(check);
  expect(f.s.configError).toBeNull();
  expect(f.s.queuePaused).toBeNull();
  noPrompt();
});
