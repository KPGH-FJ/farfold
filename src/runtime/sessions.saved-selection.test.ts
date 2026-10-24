import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type ThreadState } from "./sessions";
import { draftPersistence } from "./drafts";
import { freshThreadState, normalizeConfigOptions } from "./session_projection";
import { STRINGS } from "./strings";

let state: ThreadState;
let serial = 0;
const saved = { model: "kept", thought_level: "medium" };
const check = () => ({
  status: "ready" as const,
  issues: [],
  current: {
    choices: Object.entries(saved).map(([id, value]) => ({
      id,
      category: id,
      type: "select",
      value,
    })),
  },
});
function event(value: unknown) {
  (
    threads as unknown as {
      applyChannelEvent(key: string, value: unknown, live: boolean): void;
    }
  ).applyChannelEvent(state.key, value, true);
}
function calls() {
  return h.invoke.mock.calls.filter(
    ([name]) => name === "session_confirm_config",
  );
}
beforeEach(() => {
  h.invoke
    .mockReset()
    .mockImplementation(async (name) => (name === "settings_get" ? null : []));
  state = threads.markOpenFailed(
    `saved-baseline-${++serial}`,
    "chosen",
    "/controlled",
    `native-${serial}`,
    "",
  );
  state.identity = "draft";
  state.openError = null;
  state.connectionId = "owned-connection";
  state.configOptions = normalizeConfigOptions(
    Object.entries(saved).map(([id, value]) => ({
      id,
      category: id,
      name: id,
      type: "select",
      currentValue: value,
      options: [{ value, name: value }],
    })),
  );
  state.configCheck = check();
});
afterEach(async () => {
  await draftPersistence.flush();
});

it("uses the real strict invoke bridge with the saved map and ordered ready event, without manual refresh or a setter", async () => {
  h.invoke.mockImplementation(async (name) => {
    if (name !== "session_confirm_config")
      return name === "settings_get" ? null : [];
    const ready = check();
    event({ kind: "configCheck", check: ready });
    return ready;
  });
  await expect(
    threads.confirmRestoredConfig(state.key, saved),
  ).resolves.toBeUndefined();
  expect(calls()).toHaveLength(1);
  expect(calls()[0][1]).toMatchObject({
    agentId: "chosen",
    cwd: "/controlled",
    sessionId: state.nativeSessionId,
    displayed: check().current,
    restoreSelection: saved,
  });
  expect(state.configuring).toBe(false);
  expect(state.configError).toBeNull();
  expect(
    h.invoke.mock.calls.filter(([name]) =>
      [
        "session_index_list",
        "session_touch",
        "session_set_config",
        "session_prompt",
      ].includes(name),
    ),
  ).toHaveLength(0);
});

it.each(["transport", "nonready", "later-different-current", "later-drift"])(
  "throws and never publishes stale ready for %s",
  async (reason) => {
    h.invoke.mockImplementation(async (name) => {
      if (name !== "session_confirm_config")
        return name === "settings_get" ? null : [];
      if (reason === "transport") throw new Error("controlled failure");
      if (reason === "nonready") return { ...check(), status: "record_failed" };
      if (reason === "later-different-current")
        event({
          kind: "configCheck",
          check: { ...check(), current: { changed: true } },
        });
      if (reason === "later-drift") {
        event({ kind: "configCheck", check: check() });
        event({
          kind: "configCheck",
          check: { ...check(), status: "blocked", current: { changed: true } },
        });
      }
      return check();
    });
    await expect(
      threads.confirmRestoredConfig(state.key, saved),
    ).rejects.toThrow(STRINGS.repair.confirmConfigFailed);
    expect(calls()).toHaveLength(1);
    expect(state.configError).toBe(STRINGS.repair.confirmConfigFailed);
    expect(state.configuring).toBe(false);
    if (reason === "later-drift") {
      expect(state.configCheck?.status).toBe("blocked");
      expect(state.modelDrift).toBe(true);
    }
  },
);

it.each(["missing", "busy", "mismatched-saved", "empty-intent"])(
  "rejects %s before invoking confirmation",
  async (reason) => {
    if (reason === "missing") state.configCheck = null;
    if (reason === "busy") state.running = true;
    const selection =
      reason === "mismatched-saved"
        ? { ...saved, model: "other" }
        : reason === "empty-intent"
          ? {}
          : saved;
    await expect(
      threads.confirmRestoredConfig(state.key, selection),
    ).rejects.toThrow();
    expect(calls()).toHaveLength(0);
  },
);

it.each(["owner", "source", "connection", "readback"])(
  "rejects a late reply after %s changed without overwriting the current state",
  async (reason) => {
    let replacement: ThreadState | null = null;
    h.invoke.mockImplementation(async (name) => {
      if (name !== "session_confirm_config")
        return name === "settings_get" ? null : [];
      event({ kind: "configCheck", check: check() });
      if (reason === "owner") {
        replacement = freshThreadState(
          state.key,
          "chosen",
          "/controlled",
          "replacement",
        );
        (
          threads as unknown as { threads: Map<string, ThreadState> }
        ).threads.set(state.key, replacement);
      } else if (reason === "source") state.serviceContext = "changed-source";
      else if (reason === "connection")
        state.connectionId = "changed-connection";
      else state.configOptions[0].currentValue = "changed";
      return check();
    });
    await expect(
      threads.confirmRestoredConfig(state.key, saved),
    ).rejects.toThrow();
    expect(calls()).toHaveLength(1);
    if (replacement) {
      expect(threads.thread(state.key)).toBe(replacement);
      expect((replacement as ThreadState).configError).toBeNull();
      expect((replacement as ThreadState).configuring).toBe(false);
    }
  },
);

it("accepts an explicit thought-only original intention and leaves the other current model as inherited", async () => {
  h.invoke.mockImplementation(async (name) => {
    if (name !== "session_confirm_config")
      return name === "settings_get" ? null : [];
    const ready = check();
    event({ kind: "configCheck", check: ready });
    return ready;
  });
  await expect(
    threads.confirmRestoredConfig(state.key, { thought_level: "medium" }),
  ).resolves.toBeUndefined();
  expect(calls()[0][1]).toMatchObject({
    restoreSelection: { thought_level: "medium" },
  });
  expect(calls()[0][1].restoreSelection).not.toHaveProperty("model");
});
it("rejects a late ready reply if work becomes unknown while confirmation is pending", async () => {
  h.invoke.mockImplementation(async (name) => {
    if (name !== "session_confirm_config") return [];
    event({ kind: "configCheck", check: check() });
    state.uncertainPrompt = [{ type: "text", text: "controlled pending work" }];
    state.queuePaused = "uncertain";
    return check();
  });
  await expect(
    threads.confirmRestoredConfig(state.key, saved),
  ).rejects.toThrow();
  expect(state.uncertainPrompt).toEqual([
    { type: "text", text: "controlled pending work" },
  ]);
  expect(state.queuePaused).toBe("uncertain");
  expect(calls()).toHaveLength(1);
});

it("accepts the same-owner native ready acknowledgement before its queued channel event without applying the reply", async () => {
  const original = state.configCheck;
  const originalOptions = state.configOptions;
  const originalChoiceValues = state.configOptions.map(
    (item) => item.currentValue,
  );
  const ready = check();
  h.invoke.mockImplementation(async (name) =>
    name === "session_confirm_config" ? ready : [],
  );
  await expect(
    threads.confirmRestoredConfig(state.key, saved),
  ).resolves.toBeUndefined();
  expect(calls()).toHaveLength(1);
  expect(state.configCheck).toBe(original);
  expect(state.configCheck).not.toBe(ready);
  expect(state.configOptions).toBe(originalOptions);
  expect(state.configOptions.map((item) => item.currentValue)).toEqual(
    originalChoiceValues,
  );
  expect(state.configuring).toBe(false);
  expect(
    h.invoke.mock.calls.filter(([name]) => name !== "session_confirm_config"),
  ).toHaveLength(0);
  event({
    kind: "configCheck",
    check: { ...check(), status: "blocked", current: { changed: true } },
  });
  expect(state.configCheck?.status).toBe("blocked");
  expect(state.modelDrift).toBe(true);
});
