import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mock.invoke,
  Channel: class {},
}));
import { threads, normalizeConfigOptions, type PromptBlock } from "./sessions";
import { sendNewConversation } from "./new_conversation";
import { composerDrafts, draftPersistence } from "./drafts";
import { DRAFT_STORAGE_KEY } from "./draft_storage";
import {
  rememberPendingConversation,
  finishPendingConversation,
} from "./pending_conversation";
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
  mock.invoke.mockReset();
  mock.invoke.mockImplementation(async (command, args) =>
    localCommand(command, args),
  );
});

function permissionDraft(id: string) {
  mock.invoke.mockClear();
  const s = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "");
  s.identity = "draft";
  s.openError = null;
  s.permissionConfigId = "mode";
  s.permissionState = "ready";
  s.configOptions = normalizeConfigOptions([
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "ask",
      options: [{ value: "ask", name: "Ask for approval" }],
    },
  ]);
  mock.invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_set_config") return s.configOptions;
    if (command === "session_prompt") return { status: "accepted" };
    return localCommand(command, args);
  });
  return s;
}

it("admits an explicitly sent ordinary first message after confirming permissions on an empty draft", async () => {
  const s = permissionDraft("first-after-permission");
  await threads.setConfig(s.key, "mode", "ask");
  expect(s.permissionState).toBe("ready");
  expect(s.queuePaused).toBe("stopped");
  expect(
    mock.invoke.mock.calls.some(([name]) => name === "session_prompt"),
  ).toBe(false);
  composerDrafts.update("new", () => ({
    text: "first real input",
    attachments: [],
    sendPending: true,
  }));
  const attempt = await rememberPendingConversation(
    "new",
    composerDrafts.read("new"),
    s,
  );
  await expect(
    sendNewConversation(s.key, [{ type: "text", text: "first real input" }]),
  ).resolves.toBeUndefined();
  finishPendingConversation(attempt, "accepted");
  expect(
    mock.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
  ).toHaveLength(1);
  expect(s.identity).toBe("established");
  expect(s.queued).toEqual([]);
  expect(composerDrafts.read("new").text).toBe("");
  const promptIndex = mock.invoke.mock.calls.findIndex(
    ([command]) => command === "session_prompt",
  );
  expect(
    mock.invoke.mock.calls
      .slice(0, promptIndex)
      .some(
        ([command, args]) =>
          command === "settings_set" &&
          args.key === DRAFT_STORAGE_KEY &&
          args.value.activity[s.key]?.ended === false &&
          args.value.queues[s.key]?.uncertainIndex === 0,
      ),
  ).toBe(true);
});

it("does not resume existing queued or uncertain work when a new message is explicitly sent", async () => {
  for (const unknown of [false, true]) {
    const s = permissionDraft(`retained-after-permission-${unknown}`);
    const previous: PromptBlock[] = [{ type: "text", text: "previous" }];
    s.queued = [previous];
    if (unknown) s.uncertainPrompt = previous;
    await threads.setConfig(s.key, "mode", "ask");
    const next: PromptBlock[] = [{ type: "text", text: "new explicit input" }];
    await expect(sendNewConversation(s.key, next)).rejects.toThrow();
    expect(s.queued[0]).toBe(previous);
    expect(s.queuePaused).toBe(unknown ? "uncertain" : "stopped");
    expect(
      mock.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
    ).toHaveLength(0);
  }
});

it("does not clear an empty pause while execution, stopping, reconnect, or its outcome is unresolved", async () => {
  for (const field of [
    "running",
    "stopping",
    "stopUnconfirmed",
    "reconnecting",
    "connectionLost",
    "connectionOutcomeUnknown",
  ] as const) {
    const s = permissionDraft(`empty-pause-${field}`);
    await threads.setConfig(s.key, "mode", "ask");
    s[field] = true;
    await expect(
      sendNewConversation(s.key, [{ type: "text", text: "fresh input" }]),
    ).rejects.toThrow();
    expect(s.queuePaused).toBe("stopped");
    expect(
      mock.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
    ).toHaveLength(0);
  }
});

it("admits an explicit first message after work was disabled and restored, while retained queued work stays paused", async () => {
  for (const hasQueued of [false, true]) {
    const s = permissionDraft(`restored-work-${hasQueued}`);
    const retained: PromptBlock[] = [{ type: "text", text: "retained" }];
    if (hasQueued) s.queued = [retained];
    threads.updateWork(s.cwd, { [s.agentId]: false });
    expect(s.queuePaused).toBe("work_disabled");
    threads.updateWork(s.cwd, { [s.agentId]: true });
    expect(s.workEnabled).toBe(true);
    expect(s.queuePaused).toBe("work_disabled");
    const sending = sendNewConversation(s.key, [
      { type: "text", text: "new explicit message" },
    ]);
    if (hasQueued) {
      await expect(sending).rejects.toThrow();
      expect(s.queued[0]).toBe(retained);
      expect(s.queuePaused).toBe("work_disabled");
      expect(
        mock.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
      ).toHaveLength(0);
    } else {
      await expect(sending).resolves.toBeUndefined();
      expect(s.identity).toBe("established");
      expect(
        mock.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
      ).toHaveLength(1);
    }
  }
});
afterEach(async () => {
  await draftPersistence.flush();
});

it("retains rejected first-message input through the editor error without an extra queued copy", async () => {
  const state = threads.markOpenFailed(
    "a:/p:first-rejected",
    "a",
    "/p",
    "first-rejected",
    "",
  );
  state.identity = "draft";
  state.openError = null;
  state.workEnabled = true;
  const blocks: PromptBlock[] = [{ type: "text", text: "Keep my idea" }];
  mock.invoke.mockImplementation(async (command: string, args) =>
    command === "session_prompt"
      ? { status: "rejected", reason: "failed" }
      : localCommand(command, args),
  );
  await expect(sendNewConversation(state.key, blocks)).rejects.toThrow();
  expect(blocks).toEqual([{ type: "text", text: "Keep my idea" }]);
  expect(state.queued).toEqual([]);
  expect(state.identity).toBe("draft");
  expect(state.items).toEqual([]);
});

it("does not turn an unknown first-message result into a retryable editor draft", async () => {
  const state = threads.markOpenFailed(
    "a:/p:first-unknown",
    "a",
    "/p",
    "first-unknown",
    "",
  );
  state.identity = "draft";
  state.openError = null;
  state.workEnabled = true;
  const blocks: PromptBlock[] = [{ type: "text", text: "Do this once" }];
  mock.invoke.mockImplementation(async (command: string, args) =>
    command === "session_prompt"
      ? { status: "unknown" }
      : localCommand(command, args),
  );
  await expect(sendNewConversation(state.key, blocks)).resolves.toBeUndefined();
  expect(state.uncertainPrompt).toBe(blocks);
  expect(state.identity).toBe("established");
});
