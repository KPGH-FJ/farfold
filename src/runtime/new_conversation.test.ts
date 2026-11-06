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
import { STRINGS } from "./strings";
import { PROMPT_ADMISSION as P } from "./prompt_admission_strings";
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
    if (command === "session_set_config")
      return {
        configOptions: s.configOptions,
        configCheck: { status: "ready", issues: [], current: {} },
        permissionConfigId: "mode",
        permissionState: "ready",
        service: null,
      };
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
    await threads.setConfig(s.key, "mode", "ask");
    if (unknown) {
      s.uncertainPrompt = previous;
      s.queuePaused = "uncertain";
    }
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

it("does not offer a first prompt when quit was already cancelled during its pre-offer save", async () => {
  const state = permissionDraft("quit-before-first-offer");
  state.permissionState = "ready";
  const draft = { text: "Keep the first input", attachments: [] };
  const blocks: PromptBlock[] = [{ type: "text", text: draft.text }];
  composerDrafts.update("new", () => ({ ...draft, sendPending: true }));
  const attempt = await rememberPendingConversation(
    "new",
    composerDrafts.read("new"),
    state,
  );
  let releaseSave!: () => void;
  const heldSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let writing = false;
  mock.invoke.mockImplementation(async (command, args) => {
    if (
      command === "settings_set" &&
      args?.key === DRAFT_STORAGE_KEY &&
      args.value.queues[state.key]?.uncertainIndex === 0 &&
      !writing
    ) {
      writing = true;
      await heldSave;
    }
    return command === "session_prompt"
      ? { status: "accepted" }
      : localCommand(command, args);
  });
  const sending = Promise.allSettled([sendNewConversation(state.key, blocks)]);
  const prompts = () =>
    mock.invoke.mock.calls.filter(([name]) => name === "session_prompt");
  try {
    await vi.waitFor(() => expect(writing).toBe(true));
    expect(state.queued).toEqual([blocks]);
    expect(state.submitting).toBe(true);
    expect(prompts()).toEqual([]);
    // Exercise the final dispatch guard without relying on the separate
    // exit queue pause to reject this already-preparing request.
    draftPersistence.acquireInteractionLock()();
    expect(draftPersistence.snapshot().interactionLocked).toBe(false);
    releaseSave();
    const [outcome] = await sending;
    expect(prompts()).toEqual([]);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { message: STRINGS.repair.sendFailed },
    });
    expect(state.identity).toBe("draft");
    expect(state.queued).toEqual([]);
    expect(state.uncertainPrompt).toBeNull();
    expect(state.submitting).toBe(false);
    finishPendingConversation(attempt, "rejected");
    expect(composerDrafts.read("new")).toMatchObject({
      ...draft,
      sendPending: false,
    });
    expect(composerDrafts.read("new").pendingConversation).toBeUndefined();
    const explicit = [{ type: "text" as const, text: "A new explicit send" }];
    await expect(
      sendNewConversation(state.key, explicit),
    ).resolves.toBeUndefined();
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]?.[1]?.content).toEqual(explicit);
  } finally {
    releaseSave();
    await sending;
    composerDrafts.clear("new");
  }
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

it.each([
  ["send_wait_limit", P.full],
  ["send_wait_payload", P.payload],
  ["send_wait_cancelled", P.cancelled],
  [
    "send_wait_timeout",
    "等待发送已结束，原内容已保留。请检查正在进行的任务，再明确重试。",
  ],
])(
  "preserves the definite %s first-send reason and original attachment draft",
  async (reason, message) => {
    const state = permissionDraft(`first-rejected-${reason}`);
    const attachment = {
      id: "owned-file",
      kind: "file" as const,
      name: "owned.txt",
      uri: "file:///controlled/owned.txt",
      deliveryMode: "location" as const,
    };
    const blocks: PromptBlock[] = [
      { type: "text", text: "Keep this input" },
      { type: "resource_link", name: attachment.name, uri: attachment.uri },
    ];
    composerDrafts.update("new", () => ({
      text: "Keep this input",
      attachments: [attachment],
      sendPending: true,
    }));
    const attempt = await rememberPendingConversation(
      "new",
      composerDrafts.read("new"),
      state,
    );
    mock.invoke.mockImplementation(async (command, args) =>
      command === "session_prompt"
        ? { status: "rejected", reason }
        : command === "draft_attachment_check"
          ? null
          : localCommand(command, args),
    );
    await expect(sendNewConversation(state.key, blocks)).rejects.toThrow(
      message,
    );
    finishPendingConversation(attempt, "rejected");
    expect(composerDrafts.read("new")).toMatchObject({
      text: "Keep this input",
      attachments: [attachment],
      sendPending: false,
    });
    expect(composerDrafts.read("new").pendingConversation).toBeUndefined();
    expect(state.identity).toBe("draft");
    expect(state.uncertainPrompt).toBeNull();
    expect(state.queued).toEqual([]);
    expect(blocks[1]).toMatchObject({ uri: attachment.uri });
    expect(
      mock.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
    ).toHaveLength(1);
    expect(
      mock.invoke.mock.calls.filter(
        ([name]) => name === "draft_attachment_check",
      ),
    ).toHaveLength(1);
  },
);

it.each(["unrecognized_PRIVATE_MARKER", "constructor", "__proto__"])(
  "does not expose or interpret an opaque rejected first-send reason: %s",
  async (reason) => {
    const state = permissionDraft(`first-opaque-${reason}`);
    mock.invoke.mockImplementation(async (command, args) =>
      command === "session_prompt"
        ? { status: "rejected", reason }
        : localCommand(command, args),
    );
    await expect(
      sendNewConversation(state.key, [{ type: "text", text: "keep" }]),
    ).rejects.toThrow(STRINGS.repair.sendFailed);
    expect(state.queued).toEqual([]);
    expect(
      mock.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
    ).toHaveLength(1);
  },
);

it.each(["accepted", "unknown"] as const)(
  "does not interpret a timeout reason on a %s first-send result as unsent",
  async (status) => {
    const state = permissionDraft(`first-nonrejection-${status}`);
    const blocks: PromptBlock[] = [{ type: "text", text: "once only" }];
    mock.invoke.mockImplementation(async (command, args) =>
      command === "session_prompt"
        ? { status, reason: "send_wait_timeout" }
        : localCommand(command, args),
    );
    await expect(
      sendNewConversation(state.key, blocks),
    ).resolves.toBeUndefined();
    expect(state.identity).toBe("established");
    expect(state.uncertainPrompt).toBe(status === "unknown" ? blocks : null);
    expect(state.queued).toEqual(status === "unknown" ? [blocks] : []);
    expect(
      mock.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
    ).toHaveLength(1);
  },
);

it("keeps an invalid attachment in the first-send editor without dispatch or a forged timeout reason", async () => {
  const state = permissionDraft("first-attachment-check-failed");
  const attachment = {
    id: "unreadable-file",
    kind: "file" as const,
    name: "unreadable.txt",
    uri: "file:///controlled/unreadable.txt",
    deliveryMode: "location" as const,
  };
  const blocks: PromptBlock[] = [
    { type: "text", text: "retain this attachment" },
    { type: "resource_link", name: attachment.name, uri: attachment.uri },
  ];
  composerDrafts.update("new", () => ({
    text: "retain this attachment",
    attachments: [attachment],
    sendPending: true,
  }));
  const attempt = await rememberPendingConversation(
    "new",
    composerDrafts.read("new"),
    state,
  );
  mock.invoke.mockImplementation(async (command, args) => {
    if (command === "draft_attachment_check")
      throw new Error("FAILED: PROMPT_QUEUE_TIMEOUT");
    return localCommand(command, args);
  });
  await expect(sendNewConversation(state.key, blocks)).rejects.toThrow(
    STRINGS.repair.sendFailed,
  );
  finishPendingConversation(attempt, "rejected");
  expect(composerDrafts.read("new")).toMatchObject({
    text: "retain this attachment",
    attachments: [attachment],
    sendPending: false,
  });
  expect(state.identity).toBe("draft");
  expect(state.queued).toEqual([]);
  expect(state.uncertainPrompt).toBeNull();
  expect(
    mock.invoke.mock.calls.filter(([name]) => name === "session_prompt"),
  ).toHaveLength(0);
  expect(
    mock.invoke.mock.calls.filter(([name]) => name === "session_prompt_cancel"),
  ).toHaveLength(0);
});
