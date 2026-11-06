import { afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(null),
  workEnabled: true,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => h.workEnabled }),
}));

import { Composer } from "./Composer";
import { MessageResendDialog } from "./MessageResendDialog";
import { ThreadView } from "./ThreadView";
import {
  freshThreadState,
  applyTurnEnd,
  applyUpdate,
} from "../runtime/session_projection";
import {
  threads,
  type PromptBlock,
  type ThreadState,
} from "../runtime/sessions";
import {
  composerDrafts,
  draftPersistence,
  draftQueues,
  parseDraftSnapshot,
  type ComposerDraft,
} from "../runtime/drafts";
import { DraftSaveError } from "../runtime/draft_storage";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import { STRINGS } from "../runtime/strings";
import { emitOpeningHeader } from "../runtime/session_open_test_fixture";

function renderComposer(props: ComponentProps<typeof Composer>) {
  let tree: ReactNode;
  function Capture() {
    tree = Composer(props);
    return tree;
  }
  const html = renderToStaticMarkup(<Capture />);
  const elements: ReactElement<Record<string, unknown>>[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return {
    html,
    button: (name: string) =>
      elements.find(
        (element) =>
          element.type === "button" && element.props["aria-label"] === name,
      ),
  };
}

function render(thread: ThreadState) {
  return renderComposer({ thread, imageEnabled: false, onGoSettings() {} });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  h.invoke.mockReset().mockResolvedValue(null);
  h.workEnabled = true;
});

it.each(["stopped", "work_disabled", "no_result"] as const)(
  "labels explicit new input as send after an empty %s pause can be released",
  async (pause) => {
    vi.spyOn(draftPersistence, "load").mockResolvedValue();
    vi.spyOn(draftPersistence, "flush").mockResolvedValue();
    h.invoke.mockImplementation(async (command) =>
      command === "session_prompt" ? { status: "accepted" } : null,
    );
    const key = `restored-empty-${pause}`;
    const thread = threads.markOpenFailed(
      key,
      "a",
      "/restored",
      key,
      "fixture",
    );
    thread.openError = null;
    thread.identity = "established";
    thread.resumed = true;
    applyUpdate(thread, {
      sessionUpdate: "tool_call",
      toolCallId: "historical-stopped-tool",
      title: "Earlier command",
      status: "failed",
    });
    thread.permissionConfigId = "permission";
    thread.permissionState = "ready";
    thread.queuePaused = pause;
    if (pause === "work_disabled") {
      threads.updateWork(thread.cwd, {}, false);
      threads.updateWork(thread.cwd, {}, true);
    }
    composerDrafts.update(`session:${key}`, () => ({
      text: "Explicit new input",
      attachments: [],
    }));
    const view = render(thread);
    expect(thread.activeToolCallIds).toEqual([]);
    expect(thread.queuePaused).toBe(pause);
    expect(
      h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
    ).toBe(false);
    const action =
      view.button(STRINGS.composer.sendTitle) ?? view.button(C.addQueued);
    expect(action?.props.disabled).toBe(false);
    (action!.props.onClick as () => void)();
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith(
        "session_prompt",
        expect.objectContaining({
          content: [{ type: "text", text: "Explicit new input" }],
        }),
      ),
    );
    expect(thread.queuePaused).toBeNull();
    expect(thread.queued).toEqual([]);
    composerDrafts.clear(`session:${key}`);
    expect(view.button(STRINGS.composer.sendTitle)).toBeDefined();
    expect(view.button(C.addQueued)).toBeUndefined();
  },
);

it.each(["queued", "running", "permission"] as const)(
  "preserves the pause and queue label while %s still blocks new input",
  async (blocker) => {
    const key = `restored-blocked-${blocker}`;
    const thread = threads.markOpenFailed(key, "a", "/blocked", key, "fixture");
    thread.openError = null;
    thread.queuePaused = "stopped";
    thread.permissionConfigId = "permission";
    thread.permissionState = blocker === "permission" ? "required" : "ready";
    thread.running = blocker === "running";
    const prior = [{ type: "text" as const, text: "Existing paused input" }];
    if (blocker === "queued") thread.queued = [prior];
    composerDrafts.update(`session:${key}`, () => ({
      text: "Explicit new input",
      attachments: [],
    }));
    const view = render(thread);
    expect(view.button(C.addQueued)).toBeDefined();
    expect(view.button(STRINGS.composer.sendTitle)).toBeUndefined();
    expect(view.button(C.addQueued)?.props.disabled).toBe(
      blocker === "permission",
    );
    const blocks = [{ type: "text" as const, text: "Explicit new input" }];
    expect(await threads.send(key, blocks)).toEqual({ status: "queued" });
    expect(thread.queuePaused).toBe("stopped");
    expect(thread.queued).toEqual(
      blocker === "queued" ? [prior, blocks] : [blocks],
    );
    expect(
      h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
    ).toBe(false);
    composerDrafts.clear(`session:${key}`);
  },
);

it("offers mouse queue submission alongside stop without starting another request", async () => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  const thread = threads.markOpenFailed(
    "mouse-queue",
    "a",
    "/p",
    "mouse-queue",
    "fixture",
  );
  thread.openError = null;
  thread.running = true;
  thread.identity = "established";
  composerDrafts.update(`session:${thread.key}`, () => ({
    text: "Next step",
    attachments: [],
  }));
  const view = render(thread);
  expect(view.button(STRINGS.composer.stopTitle)?.props.disabled).toBe(false);
  const enqueue = view.button("加入待发");
  expect(enqueue).toBeDefined();
  expect(enqueue!.props.disabled).toBe(false);
  (enqueue!.props.onClick as () => void)();
  await vi.waitFor(() =>
    expect(thread.queued).toEqual([[{ type: "text", text: "Next step" }]]),
  );
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
  expect(thread.running).toBe(true);
  thread.stopping = true;
  composerDrafts.update(`session:${thread.key}`, () => ({
    text: "Keep stopped draft",
    attachments: [],
  }));
  expect(render(thread).button("加入待发")?.props.disabled).toBe(true);
  composerDrafts.clear(`session:${thread.key}`);
});

it.each(["waiting", "confirmed"] as const)(
  "keeps an earlier queue click in the draft when a stop is %s during its pending save",
  async (outcome) => {
    const id = `stop-during-pending-save-${outcome}`;
    const thread = threads.markOpenFailed(id, "a", "/p", id, "fixture");
    thread.openError = null;
    thread.identity = "established";
    thread.connectionId = `connection-${id}`;
    const key = `session:${thread.key}`;
    const draft = { text: "Keep this input in the draft", attachments: [] };
    const receiptId = 41;
    const channel = threads as unknown as {
      applyChannelEvent(key: string, event: unknown): void;
    };
    const confirmStop = () =>
      channel.applyChannelEvent(thread.key, {
        kind: "turnEnd",
        promptReceiptId: receiptId,
        stopReason: "cancelled",
      });
    h.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "session_prompt") {
        const { admissionChannel } = args as {
          admissionChannel: { onmessage(value: unknown): void };
        };
        admissionChannel.onmessage({ receiptId, phase: "offered" });
        return { status: "accepted" };
      }
      if (command === "session_prompt_cancel")
        return { receiptId, outcome: "cancelRequested" };
      return null;
    });
    const flush = vi.spyOn(draftPersistence, "flush").mockResolvedValue();
    await expect(
      threads.send(thread.key, [{ type: "text", text: "Already running" }]),
    ).resolves.toEqual({ status: "accepted" });
    expect(thread.running).toBe(true);
    expect(thread.queued).toEqual([]);
    composerDrafts.update(key, () => draft);

    let releaseSave!: () => void;
    const heldSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let pendingSaveStarted = false;
    flush.mockImplementation(async () => {
      if (!composerDrafts.read(key).sendPending) return;
      pendingSaveStarted = true;
      await heldSave;
    });

    try {
      const enqueue = render(thread).button(C.addQueued)!;
      expect(enqueue.props.disabled).toBe(false);
      (enqueue.props.onClick as () => void)();
      await vi.waitFor(() => expect(pendingSaveStarted).toBe(true));
      expect(composerDrafts.read(key)).toMatchObject({
        ...draft,
        sendPending: true,
      });
      expect(thread.queued).toEqual([]);

      const stop = render(thread).button(STRINGS.composer.stopTitle)!;
      expect(stop.props.disabled).toBe(false);
      (stop.props.onClick as () => void)();
      await vi.waitFor(() =>
        expect(h.invoke).toHaveBeenCalledWith(
          "session_prompt_cancel",
          expect.objectContaining({
            sessionId: id,
            connectionId: thread.connectionId,
            receiptId,
          }),
        ),
      );
      expect(thread.stopping).toBe(true);
      expect(thread.queuePaused).toBe("stopped");
      if (outcome === "confirmed") {
        confirmStop();
        expect(thread.stopping).toBe(false);
        expect(thread.running).toBe(false);
        expect(thread.items.at(-1)).toMatchObject({
          kind: "settled",
          status: "stopped",
          stopReason: "cancelled",
        });
      }
    } finally {
      releaseSave();
    }
    await vi.waitFor(() =>
      expect(composerDrafts.read(key).sendPending).not.toBe(true),
    );
    expect.soft(composerDrafts.read(key)).toMatchObject(draft);
    expect.soft(thread.queued).toEqual([]);
    expect
      .soft(
        h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
      )
      .toHaveLength(1);
    if (outcome === "waiting") confirmStop();
    else {
      const send = render(thread).button(STRINGS.composer.sendTitle)!;
      expect(send.props.disabled).toBe(false);
      (send.props.onClick as () => void)();
      await vi.waitFor(() =>
        expect(h.invoke).toHaveBeenCalledWith(
          "session_prompt",
          expect.objectContaining({
            content: [{ type: "text", text: draft.text }],
          }),
        ),
      );
      await vi.waitFor(() => expect(composerDrafts.read(key).text).toBe(""));
      confirmStop();
    }
    composerDrafts.clear(key);
  },
);

it("keeps a held submission in the draft when the reconnect button installs a replacement connection", async () => {
  type OpenWire = {
    cwd: string;
    nativeSessionId: string;
    openToken: string;
    channel: { onmessage(event: unknown): void };
  };
  const opens: OpenWire[] = [];
  const input = {
    agentId: "held-reconnect-fixture",
    cwd: "/held-reconnect-fixture",
    nativeSessionId: "owned-connection-replacement",
  };
  h.invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "session_open") {
      const wire = args as OpenWire;
      opens.push(wire);
      const result = {
        cwd: wire.cwd,
        nativeSessionId: wire.nativeSessionId,
        connectionId: `owned-connection-${opens.length}`,
        resumed: true,
        configOptions: [],
        service: null,
      };
      emitOpeningHeader(wire, result);
      wire.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Owned retained history" },
        },
      });
      wire.channel.onmessage({
        kind: "session_history_complete",
        openToken: wire.openToken,
      });
      return result;
    }
    if (command === "settings_get") return null;
    if (command === "session_prompt") return { status: "accepted" };
    return [];
  });
  const flush = vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  const original = await threads.open(input);
  expect(original.connectionId).toBe("owned-connection-1");
  expect(original.running).toBe(false);
  const key = `session:${original.key}`;
  const draft = { text: "Keep the input across reconnect", attachments: [] };
  composerDrafts.update(key, () => draft);

  let releaseSave!: () => void;
  const heldSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let pendingSaveStarted = false;
  flush.mockImplementation(async () => {
    if (!composerDrafts.read(key).sendPending) return;
    pendingSaveStarted = true;
    await heldSave;
  });

  try {
    const send = render(original).button(STRINGS.composer.sendTitle)!;
    expect(send.props.disabled).toBe(false);
    (send.props.onClick as () => void)();
    await vi.waitFor(() => expect(pendingSaveStarted).toBe(true));
    expect(original.submitting).toBe(false);
    expect(composerDrafts.read(key).sendPending).toBe(true);
    opens[0]!.channel.onmessage({
      kind: "connectionLost",
      closeReason: "unexpected",
    });
    expect(original.connectionLost).toBe(true);
    expect(original.connectionCloseReason).toBe("unexpected");
    expect(original.connectionOutcomeUnknown).toBe(false);

    let reconnect: ReactElement<Record<string, unknown>> | undefined;
    function Capture() {
      const view = ThreadView({
        thread: original,
        active: true,
        agents: [],
        onGoSettings() {},
        onOpened() {},
      });
      const visit = (node: ReactNode) =>
        Children.forEach(node, (child) => {
          if (!isValidElement<Record<string, unknown>>(child)) return;
          if (
            child.type === "button" &&
            child.props.children === STRINGS.thread.reconnect
          )
            reconnect = child;
          visit(child.props.children as ReactNode);
        });
      visit(view);
      return view;
    }
    renderToStaticMarkup(<Capture />);
    expect(reconnect?.props.disabled).toBe(false);
    (reconnect!.props.onClick as () => void)();
    await vi.waitFor(() =>
      expect(threads.thread(original.key)?.connectionId).toBe(
        "owned-connection-2",
      ),
    );
    const replacement = threads.thread(original.key)!;
    expect(replacement).not.toBe(original);
    expect(replacement.key).toBe(original.key);
    expect(replacement.connectionLost).toBe(false);
    expect(replacement.queuePaused).toBe("unavailable");
    expect(replacement.queued).toEqual([]);
  } finally {
    releaseSave();
  }

  await vi.waitFor(() =>
    expect(composerDrafts.read(key).sendPending).not.toBe(true),
  );
  expect.soft(composerDrafts.read(key)).toMatchObject(draft);
  expect.soft(threads.thread(original.key)!.queued).toEqual([]);
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toEqual([]);
  composerDrafts.clear(key);
});

type SavedWork = {
  composers: Record<string, ComposerDraft>;
  queues: Record<string, { blocks: PromptBlock[][] }>;
};

it.each(["idle", "running"] as const)(
  "keeps the original composer editable when the pending queue cannot be saved while %s",
  async (activity) => {
    const id = `queue-handoff-storage-refusal-${activity}`;
    const thread = threads.markOpenFailed(id, "a", "/p", id, "fixture");
    thread.openError = null;
    thread.connectionId = "original-connection";
    const key = `session:${thread.key}`;
    const otherKey = `session:independent-${id}`;
    const draft: ComposerDraft = {
      text: "Keep this unsent input",
      attachments: [
        {
          id: "owned-file",
          kind: "file",
          name: "owned.txt",
          uri: "file:///fixture/owned.txt",
          deliveryMode: "location",
        },
      ],
    };
    const other: ComposerDraft = { text: "Independent draft", attachments: [] };
    const activeText = "Previously admitted input";
    const activeReceiptId = 81;
    const existing: PromptBlock[] = [{ type: "text", text: "Already queued" }];
    const priorQueue = activity === "running" ? [existing] : [];
    const newBlocks: PromptBlock[] = [
      { type: "text", text: draft.text },
      {
        type: "resource_link",
        uri: "file:///fixture/owned.txt",
        name: "owned.txt",
      },
    ];
    const committed: SavedWork[] = [];
    const rejected: SavedWork[] = [];
    let blockHandoff = true;
    h.invoke.mockImplementation(async (command, args) => {
      if (
        command === "session_prompt" &&
        args.content[0]?.text === activeText
      ) {
        args.admissionChannel.onmessage({
          receiptId: activeReceiptId,
          phase: "offered",
        });
        return { status: "accepted" };
      }
      if (command === "settings_set" && args.key === "unsentWork.v1") {
        const snapshot = structuredClone(args.value as SavedWork);
        if (
          blockHandoff &&
          (rejected.length > 0 ||
            (snapshot.queues[thread.key]?.blocks.length ?? 0) >
              priorQueue.length)
        ) {
          rejected.push(snapshot);
          throw "FARFOLD_STORAGE:busy:fixture queue write locked";
        }
        committed.push(snapshot);
      }
      return null;
    });
    try {
      await draftPersistence.load();
      if (activity === "running") {
        await expect(
          threads.send(thread.key, [{ type: "text", text: activeText }]),
        ).resolves.toEqual({ status: "accepted" });
        expect(thread.running).toBe(true);
        await expect(threads.send(thread.key, existing)).resolves.toEqual({
          status: "queued",
        });
      }
      composerDrafts.update(key, () => draft);
      composerDrafts.update(otherKey, () => other);
      await draftPersistence.flush();
      expect(committed.at(-1)?.composers[key]).toEqual(draft);

      const send = vi.spyOn(threads, "send");
      const action =
        activity === "idle" ? STRINGS.composer.sendTitle : C.addQueued;
      const submit = render(thread).button(action)!;
      expect(submit.props.disabled).toBe(false);
      (submit.props.onClick as () => void)();
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send).toHaveBeenCalledWith(thread.key, newBlocks, {
        key,
        value: { ...draft, sendPending: true },
      });
      const delivery = send.mock.results[0]!.value;
      await expect(delivery).rejects.toBeInstanceOf(DraftSaveError);
      await expect(delivery).rejects.toThrow(
        STRINGS.storageRecovery.issues.busy,
      );
      await vi.waitFor(() =>
        expect(composerDrafts.read(key).sendPending).not.toBe(true),
      );
      await expect(draftPersistence.flush()).rejects.toThrow();

      const priorSave = committed.at(-1);
      expect(priorSave?.composers[key]).toEqual({
        ...draft,
        sendPending: true,
      });
      expect(priorSave?.composers[otherKey]).toEqual(other);
      expect(priorSave?.queues[thread.key]?.blocks ?? []).toEqual(priorQueue);
      expect(rejected[0]?.queues[thread.key]?.blocks).toEqual([
        ...priorQueue,
        newBlocks,
      ]);
      expect(rejected[0]?.composers[key]).toBeUndefined();
      expect(
        h.invoke.mock.calls
          .filter(([command]) => command === "session_prompt")
          .map(([, args]) => args.content[0].text),
      ).toEqual(activity === "running" ? [activeText] : []);
      expect(thread.queued).toEqual(priorQueue);
      if (activity === "running") expect(thread.queued[0]).toBe(existing);
      expect(draftQueues.read(thread.key)?.blocks ?? []).toEqual(priorQueue);
      expect(thread.running).toBe(activity === "running");
      expect(composerDrafts.read(otherKey)).toBe(other);
      expect(composerDrafts.read(key)).toMatchObject(draft);
      expect(render(thread).button(action)?.props.disabled).toBe(false);
    } finally {
      blockHandoff = false;
      for (let index = thread.queued.length - 1; index >= 0; index--)
        threads.dequeue(thread.key, index);
      if (activity === "running") {
        (
          threads as unknown as {
            applyChannelEvent(key: string, event: unknown): void;
          }
        ).applyChannelEvent(thread.key, {
          kind: "turnEnd",
          promptReceiptId: activeReceiptId,
          stopReason: "end_turn",
        });
      }
      composerDrafts.clear(key);
      composerDrafts.clear(otherKey);
      await draftPersistence.flush();
    }
  },
);

it("keeps one saved queue copy when a later independent write fails", async () => {
  const id = "saved-handoff-later-write-refusal";
  const thread = threads.markOpenFailed(id, "a", "/p", id, "fixture");
  thread.openError = null;
  thread.connectionId = "original-connection";
  thread.queuePaused = "unavailable";
  const key = `session:${thread.key}`;
  const siblingKey = `session:independent-${id}`;
  const submitted = "Original queued input";
  const blocks: PromptBlock[] = [{ type: "text", text: submitted }];
  const newer = { text: "Newer input in the same editor", attachments: [] };
  const sibling = { text: "Earlier independent input", attachments: [] };
  const newerSibling = { text: "Newer independent input", attachments: [] };
  const committed: SavedWork[] = [];
  const refused: SavedWork[] = [];
  let acknowledge!: () => void;
  const receipt = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let handoffCommitted = false;
  let failLaterWrites = true;
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "settings_set" || args.key !== "unsentWork.v1") return null;
    const snapshot = structuredClone(args.value as SavedWork);
    if (!handoffCommitted && snapshot.queues[thread.key]?.blocks.length) {
      handoffCommitted = true;
      committed.push(snapshot);
      await receipt;
    } else if (handoffCommitted && failLaterWrites) {
      refused.push(snapshot);
      throw "FARFOLD_STORAGE:busy:fixture later write locked";
    } else committed.push(snapshot);
    return null;
  });
  const send = vi.spyOn(threads, "send");
  const prompts = () =>
    h.invoke.mock.calls.filter(([command]) => command === "session_prompt");
  try {
    await draftPersistence.load();
    composerDrafts.update(key, () => ({ text: submitted, attachments: [] }));
    composerDrafts.update(siblingKey, () => sibling);
    await draftPersistence.flush();

    const enqueue = render(thread).button(C.addQueued)!;
    expect(enqueue.props.disabled).toBe(false);
    (enqueue.props.onClick as () => void)();
    await vi.waitFor(() => expect(handoffCommitted).toBe(true));
    const atomic = committed.at(-1)!;
    expect(atomic.queues[thread.key]?.blocks).toEqual([blocks]);
    expect(atomic.composers[key]).toBeUndefined();
    expect(atomic.composers[siblingKey]).toEqual(sibling);
    expect(composerDrafts.read(key)).toMatchObject({
      text: submitted,
      sendPending: true,
    });
    expect(prompts()).toEqual([]);

    composerDrafts.update(key, (current) => ({ ...current, ...newer }));
    composerDrafts.update(siblingKey, () => newerSibling);
    acknowledge();
    await expect(send.mock.results[0]!.value).resolves.toEqual({
      status: "queued",
    });
    await vi.waitFor(() =>
      expect(composerDrafts.read(key).sendPending).not.toBe(true),
    );
    await expect(draftPersistence.flush()).rejects.toThrow(
      STRINGS.storageRecovery.issues.busy,
    );
    expect(refused[0]?.composers[key]).toMatchObject(newer);
    expect(refused[0]?.composers[siblingKey]).toEqual(newerSibling);
    expect(committed.at(-1)).toBe(atomic);
    expect(composerDrafts.read(key)).toMatchObject(newer);
    expect(composerDrafts.read(siblingKey)).toBe(newerSibling);
    expect(thread.queued).toEqual([blocks]);
    expect(thread.queuePaused).toBe("unavailable");
    expect(prompts()).toEqual([]);

    failLaterWrites = false;
    await draftPersistence.flush();
    expect(committed.at(-1)?.composers[key]).toMatchObject(newer);
    expect(committed.at(-1)?.composers[siblingKey]).toEqual(newerSibling);
    expect(committed.at(-1)?.queues[thread.key]?.blocks).toEqual([blocks]);
    expect(prompts()).toEqual([]);
  } finally {
    acknowledge();
    failLaterWrites = false;
    await send.mock.results[0]?.value.catch(() => undefined);
    threads.dequeue(thread.key, 0);
    composerDrafts.clear(key);
    composerDrafts.clear(siblingKey);
    await draftPersistence.flush();
  }
});

it("retains only one saved copy when a disconnected handoff cannot be rolled back", async () => {
  const id = "disconnected-handoff-rollback-refused";
  const thread = threads.markOpenFailed(id, "a", "/p", id, "fixture");
  thread.openError = null;
  thread.connectionId = `connection-${id}`;
  const key = `session:${thread.key}`;
  const draft: ComposerDraft = {
    text: "Unsent at disconnect",
    attachments: [],
  };
  const blocks: PromptBlock[] = [{ type: "text", text: draft.text }];
  const committed: SavedWork[] = [];
  const refused: SavedWork[] = [];
  const send = vi.spyOn(threads, "send");
  let acknowledge!: () => void;
  const receipt = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let committedHandoff = false;
  let failCompensation = true;
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "settings_set" || args.key !== "unsentWork.v1") return null;
    const snapshot = structuredClone(args.value as SavedWork);
    if (!committedHandoff && snapshot.queues[thread.key]?.blocks.length) {
      committedHandoff = true;
      committed.push(snapshot);
      await receipt;
    } else if (committedHandoff && failCompensation) {
      refused.push(snapshot);
      throw "FARFOLD_STORAGE:busy:fixture compensation locked";
    } else committed.push(snapshot);
    return null;
  });
  const prompts = () =>
    h.invoke.mock.calls.filter(([command]) => command === "session_prompt");
  try {
    await draftPersistence.load();
    composerDrafts.update(key, () => draft);
    await draftPersistence.flush();
    const submit = render(thread).button(STRINGS.composer.sendTitle)!;
    expect(submit.props.disabled).toBe(false);
    (submit.props.onClick as () => void)();
    await vi.waitFor(() => expect(committedHandoff).toBe(true));
    expect(composerDrafts.read(key)).toMatchObject({
      ...draft,
      sendPending: true,
    });
    expect(thread.queued).toEqual([blocks]);
    expect(prompts()).toEqual([]);
    (
      threads as unknown as {
        applyChannelEvent(key: string, event: unknown): void;
      }
    ).applyChannelEvent(thread.key, {
      kind: "connectionLost",
      closeReason: "unexpected",
    });
    expect(thread.connectionLost).toBe(true);

    acknowledge();
    await expect(send.mock.results[0]!.value).rejects.toThrow(
      STRINGS.repair.sendFailed,
    );
    expect(refused[0]?.composers[key]).toMatchObject(draft);
    expect(refused[0]?.queues[thread.key]).toBeUndefined();
    await vi.waitFor(() =>
      expect(composerDrafts.read(key).sendPending).not.toBe(true),
    );
    expect(composerDrafts.read(key)).toMatchObject(draft);
    expect(thread.queued).toEqual([]);
    expect(draftQueues.read(thread.key)).toBeNull();
    expect(prompts()).toEqual([]);

    const beforeRecovery = parseDraftSnapshot(committed.at(-1))!;
    expect(new Map(beforeRecovery.composers).has(key)).toBe(false);
    expect(new Map(beforeRecovery.queues).get(thread.key)).toEqual({
      blocks: [blocks],
      uncertainIndex: null,
    });
    failCompensation = false;
    await draftPersistence.flush();
    const afterRecovery = parseDraftSnapshot(committed.at(-1))!;
    expect(new Map(afterRecovery.composers).get(key)).toMatchObject({
      ...draft,
      sendPending: false,
    });
    expect(new Map(afterRecovery.queues).has(thread.key)).toBe(false);
    expect(composerDrafts.read(key)).toMatchObject(draft);
    expect(thread.queued).toEqual([]);
    expect(prompts()).toEqual([]);
  } finally {
    acknowledge();
    failCompensation = false;
    await send.mock.results[0]?.value.catch(() => undefined);
    threads.dequeue(thread.key, 0);
    composerDrafts.clear(key);
    await draftPersistence.flush();
  }
});

it("keeps the original draft when exit takes its lock before queue handoff", async () => {
  const id = "exit-lock-before-queue-handoff";
  const thread = threads.markOpenFailed(id, "a", "/p", id, "fixture");
  thread.openError = null;
  thread.connectionId = `connection-${id}`;
  const key = `session:${thread.key}`;
  const draft = { text: "Original unsent input at quit", attachments: [] };
  const snapshots: SavedWork[] = [];
  const send = vi.spyOn(threads, "send");
  let acknowledge!: () => void;
  const receipt = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let pendingSaveWaiting = false;
  let releaseExit: (() => void) | undefined;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "settings_set" && args.key === "unsentWork.v1") {
      const snapshot = structuredClone(args.value as SavedWork);
      snapshots.push(snapshot);
      if (snapshot.composers[key]?.sendPending && !pendingSaveWaiting) {
        pendingSaveWaiting = true;
        await receipt;
      }
    }
    return command === "session_prompt" ? { status: "accepted" } : null;
  });
  try {
    await draftPersistence.load();
    composerDrafts.update(key, () => draft);
    await draftPersistence.flush();
    const submit = render(thread).button(STRINGS.composer.sendTitle)!;
    expect(submit.props.disabled).toBe(false);
    (submit.props.onClick as () => void)();
    await vi.waitFor(() => expect(pendingSaveWaiting).toBe(true));
    expect(send).not.toHaveBeenCalled();
    expect(thread.queued).toEqual([]);

    threads.pauseQueuesForExit();
    releaseExit = draftPersistence.acquireInteractionLock();
    acknowledge();
    await vi.waitFor(() =>
      expect(composerDrafts.read(key).sendPending).not.toBe(true),
    );
    await draftPersistence.flush();
    expect(draftPersistence.snapshot().interactionLocked).toBe(true);
    expect(snapshots.every((value) => !value.queues[thread.key])).toBe(true);
    expect(snapshots.at(-1)?.composers[key]).toMatchObject(draft);
    expect(composerDrafts.read(key)).toMatchObject(draft);
    expect(thread.queued).toEqual([]);
    expect(
      h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
    ).toEqual([]);
  } finally {
    acknowledge();
    releaseExit?.();
    await send.mock.results[0]?.value.catch(() => undefined);
    threads.dequeue(thread.key, 0);
    composerDrafts.clear(key);
    await draftPersistence.flush();
  }
});

it.each(["quit pause", "no newer pause"] as const)(
  "keeps the correct outcome when a durable handoff receives %s",
  async (scenario) => {
    const id = `empty-pause-handoff-${scenario}`;
    const thread = threads.markOpenFailed(id, "a", "/p", id, "fixture");
    thread.openError = null;
    thread.connectionId = `connection-${id}`;
    thread.queuePaused = "stopped";
    const key = `session:${thread.key}`;
    const text = "One explicit message after a pause";
    const blocks: PromptBlock[] = [{ type: "text", text }];
    const send = vi.spyOn(threads, "send");
    let releaseSave!: () => void;
    const heldSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let handoffWaiting = false;
    h.invoke.mockImplementation(async (command, args) => {
      if (
        command === "settings_set" &&
        args.key === "unsentWork.v1" &&
        args.value.queues[thread.key]?.blocks.length &&
        !handoffWaiting
      ) {
        handoffWaiting = true;
        await heldSave;
      }
      return command === "session_prompt" ? { status: "accepted" } : null;
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    const prompts = () =>
      h.invoke.mock.calls
        .filter(([command]) => command === "session_prompt")
        .map(([, args]) => args.content);

    try {
      await draftPersistence.load();
      composerDrafts.update(key, () => ({ text, attachments: [] }));
      await draftPersistence.flush();
      const submit = render(thread).button(STRINGS.composer.sendTitle)!;
      expect(submit.props.disabled).toBe(false);
      (submit.props.onClick as () => void)();
      await vi.waitFor(() => expect(handoffWaiting).toBe(true));
      expect(thread.queued).toEqual([blocks]);
      expect(thread.queuePaused).toBe("stopped");
      expect(prompts()).toEqual([]);
      expect(composerDrafts.read(key).sendPending).toBe(true);

      const quitting = scenario === "quit pause";
      if (quitting) threads.pauseQueuesForExit();
      // The new exit pause has the same reason as the one seen by Send.
      expect(thread.queuePaused).toBe("stopped");
      releaseSave();
      const result = await send.mock.results[0]!.value;
      await vi.waitFor(() =>
        expect(composerDrafts.hasContent(key)).toBe(false),
      );
      await draftPersistence.flush();

      expect(prompts()).toEqual(quitting ? [] : [blocks]);
      expect(result).toEqual({ status: quitting ? "queued" : "accepted" });
      expect(thread.queuePaused).toBe(quitting ? "stopped" : null);
      expect(thread.queued).toEqual(quitting ? [blocks] : []);
      expect(draftQueues.read(thread.key)?.blocks ?? []).toEqual(
        quitting ? [blocks] : [],
      );
    } finally {
      releaseSave();
      await send.mock.results[0]?.value.catch(() => undefined);
      threads.dequeue(thread.key, 0);
      composerDrafts.clear(key);
      await draftPersistence.flush();
      vi.unstubAllGlobals();
    }
  },
);

it("keeps the edited resend open and unsent when its connection ends during the pending save", async () => {
  const id = "held-resend-disconnected";
  const thread = threads.markOpenFailed(id, "a", "/p", id, "fixture");
  thread.openError = null;
  thread.identity = "established";
  thread.connectionId = "owned-resend-connection";
  const key = `resend:${thread.key}`;
  const mainKey = `session:${thread.key}`;
  const mainDraft = { text: "Original main draft", attachments: [] };
  const edit = {
    text: "Edited draft stays here",
    attachments: [
      {
        id: "retained-attachment",
        kind: "file" as const,
        name: "retained.txt",
        uri: "file:///p/retained.txt",
        deliveryMode: "location" as const,
      },
    ],
  };
  composerDrafts.update(mainKey, () => mainDraft);
  composerDrafts.update(key, () => edit);

  let releaseSave!: () => void;
  const heldSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let pendingSaveStarted = false;
  vi.spyOn(draftPersistence, "flush").mockImplementation(async () => {
    if (!composerDrafts.read(key).sendPending) return;
    pendingSaveStarted = true;
    await heldSave;
  });

  const close = vi.fn();
  let composer: ComponentProps<typeof Composer> | undefined;
  function CaptureResend() {
    const dialog = MessageResendDialog({
      thread,
      imageEnabled: false,
      embedContext: false,
      continued: false,
      onClose: close,
      onGoSettings() {},
    });
    const visit = (node: ReactNode) =>
      Children.forEach(node, (child) => {
        if (!isValidElement<Record<string, unknown>>(child)) return;
        if (child.type === Composer)
          composer = child.props as ComponentProps<typeof Composer>;
        visit(child.props.children as ReactNode);
      });
    visit(dialog);
    return dialog;
  }
  expect(renderToStaticMarkup(<CaptureResend />)).toContain(R.editMessage);
  expect(composer?.draftKey).toBe(key);

  try {
    const send = renderComposer(composer!).button(R.resendSend)!;
    expect(send.props.disabled).toBe(false);
    (send.props.onClick as () => void)();
    await vi.waitFor(() => expect(pendingSaveStarted).toBe(true));
    expect(composerDrafts.read(key)).toMatchObject({
      ...edit,
      sendPending: true,
    });
    expect(thread.submitting).toBe(false);
    expect(close).not.toHaveBeenCalled();
    (
      threads as unknown as {
        applyChannelEvent(key: string, event: unknown): void;
      }
    ).applyChannelEvent(thread.key, {
      kind: "connectionLost",
      closeReason: "unexpected",
    });
    expect(threads.thread(thread.key)).toBe(thread);
    expect(thread.connectionLost).toBe(true);
    expect(thread.connectionOutcomeUnknown).toBe(false);
    expect(thread.queuePaused).toBe("unavailable");
    expect(thread.queued).toEqual([]);
  } finally {
    releaseSave();
  }

  await vi.waitFor(() =>
    expect(composerDrafts.read(key).sendPending).not.toBe(true),
  );
  expect.soft(composerDrafts.read(key)).toMatchObject(edit);
  expect.soft(composerDrafts.read(mainKey)).toMatchObject(mainDraft);
  expect.soft(thread.queued).toEqual([]);
  expect.soft(close).not.toHaveBeenCalled();
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_prompt"),
  ).toEqual([]);
  composerDrafts.clear(key);
  composerDrafts.clear(mainKey);
});

it("keeps the waiting confirmation beside the input with a disabled stop control", () => {
  const thread = freshThreadState("a:/p:waiting", "a", "/p", "waiting");
  thread.running = true;
  thread.stopping = true;
  const { html, button } = render(thread);
  expect(html).toContain(C.stopWaiting);
  expect(html).toContain(C.stopWaitingNote);
  expect(html).toContain(`aria-label="${C.stopStatus}"`);
  expect(button(STRINGS.repair.stopping)?.props.disabled).toBe(true);
  expect(html).not.toContain(STRINGS.composer.hintQueue);
  expect(html).not.toContain(STRINGS.thread.stopped);
});

it("moves unknown stop recovery out of the scrollable transcript and into the composer only once", () => {
  const thread = freshThreadState("a:/p:unknown", "a", "/p", "unknown");
  thread.stopUnconfirmed = true;
  thread.connectionOutcomeUnknown = true;
  const html = renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
  const composerIndex = html.indexOf('class="composer-wrap"');
  expect(composerIndex).toBeGreaterThan(-1);
  expect(html.indexOf(`aria-label="${C.stopStatus}"`)).toBeGreaterThan(
    composerIndex,
  );
  expect(html.match(/class="c-stop c-stop-retry"/g)).toHaveLength(1);
  expect(render(thread).button(STRINGS.repair.retryStop)?.props.disabled).toBe(
    false,
  );
  thread.connectionLost = true;
  expect(render(thread).button(STRINGS.repair.retryStop)?.props.disabled).toBe(
    true,
  );
});

it("keeps stop available while work or permission settings pause sending and preserves the queue on confirmation", async () => {
  vi.useFakeTimers();
  h.workEnabled = false;
  const thread = threads.markOpenFailed(
    "a:/p:stop-paused",
    "a",
    "/p",
    "stop-paused",
    "fixture",
  );
  thread.openError = null;
  thread.running = true;
  thread.permissionConfigId = "permission";
  thread.permissionState = "unknown";
  thread.queued = [[{ type: "text", text: "later" }]];
  composerDrafts.update(`session:${thread.key}`, () => ({
    text: "draft remains",
    attachments: [],
  }));
  const stop = render(thread).button(STRINGS.composer.stopTitle)!;
  expect(stop.props.disabled).toBe(false);
  (stop.props.onClick as () => void)();
  expect(h.invoke).toHaveBeenCalledWith(
    "session_cancel",
    expect.objectContaining({ sessionId: thread.nativeSessionId }),
  );
  expect(thread.stopping).toBe(true);
  expect(thread.queuePaused).toBe("stopped");
  applyTurnEnd(thread, { stopReason: "cancelled" });
  expect(render(thread).html).not.toContain(C.stopStatus);
  expect(thread.queued).toEqual([[{ type: "text", text: "later" }]]);
  expect(composerDrafts.read(`session:${thread.key}`).text).toBe(
    "draft remains",
  );
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("shows a failed cancel as unknown and offers an explicit retry without claiming nondelivery", async () => {
  vi.useFakeTimers();
  const thread = threads.markOpenFailed(
    "a:/p:stop-failed",
    "a",
    "/p",
    "stop-failed",
    "fixture",
  );
  thread.openError = null;
  thread.running = true;
  h.invoke.mockRejectedValueOnce(new Error("transport failure"));
  await threads.cancel(thread.key);
  const { html, button } = render(thread);
  expect(html).toContain(C.stopUnknown);
  expect(button(STRINGS.repair.retryStop)?.props.disabled).toBe(false);
  expect(html).not.toContain("停止请求未发送");
  expect(html).not.toContain(STRINGS.thread.stopped);
  expect(thread.queued).toEqual([]);
});
