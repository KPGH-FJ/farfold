import { NewConversationLocationBar } from "./NewConversationLocationBar";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ThreadState } from "../runtime/session_types";

// Use the existing archived-draft hook harness. Only the external bridge is
// controlled; EmptyState, first-send admission and draft persistence are real.
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  open: vi.fn(),
  send: vi.fn(),
  setConfig: vi.fn(),
  discard: vi.fn(),
  threads: new Map<string, ThreadState>(),
  workReady: true,
  workError: null as string | null,
  workRetry: vi.fn(),
  renderingComposer: false,
  composerWorkReady: false,
  catalogue: {
    ready: true,
    loading: false,
    error: null as string | null,
    archives: [] as unknown[],
    recoveries: [] as unknown[],
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, index) => !Object.is(value, slot.deps?.[index]))
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
  useLayoutEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
vi.mock("../runtime/worktrees", () => ({
  worktrees: {
    snapshot: () => h.catalogue,
    subscribe: () => () => {},
    load: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../runtime/dialogs", () => ({ chooseDirectory: vi.fn() }));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string | null) => {
    const child = h.renderingComposer;
    const ready = cwd !== null && (child ? h.composerWorkReady : h.workReady);
    return {
      cwd: ready ? cwd : undefined,
      ready,
      error: cwd && !ready ? h.workError : null,
      enabled: () => cwd === null || ready,
      retry: () => {
        if (!cwd) return;
        if (child) h.composerWorkReady = true;
        else h.workRetry(cwd);
      },
    };
  },
}));
vi.mock("../runtime/connection_hold", () => ({ useConnectionHold: () => {} }));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  listCredentials: vi.fn().mockResolvedValue([]),
  subscribeCredentialChanges: () => () => {},
}));
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: () => ({
      service: null,
      config: { model: "saved-model", reasoning: "high" },
    }),
  },
}));
vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: (key: string | null) =>
    key ? (h.threads.get(key) ?? null) : null,
  threads: {
    open: h.open,
    thread: (key: string) => h.threads.get(key),
    discardDraft: h.discard,
    setConfig: h.setConfig,
    confirmRestoredConfig: vi.fn().mockResolvedValue(undefined),
    send: h.send,
    dequeue: vi.fn(),
  },
}));
import { EmptyState } from "./EmptyState";
import { invoke } from "@tauri-apps/api/core";
import { ZERO_SEND_STRINGS } from "../runtime/conversation_access";
import { Composer } from "./Composer";
import { ComposerWorkNotice } from "./ComposerWorkNotice";
import { PreservedDrafts } from "./PreservedDrafts";
import { NewConversationAgentDialog } from "./NewConversationPickers";
import { chooseDirectory } from "../runtime/dialogs";
import { ERROR_STRINGS } from "../runtime/error_strings";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS } from "../runtime/workspace_strings";
import {
  composerDrafts,
  draftPersistence,
  newConversationChoice,
} from "../runtime/drafts";
import { allowAutomaticConnection } from "../runtime/connection_intent";
import { freshThreadState } from "../runtime/session_projection";
import { pauseQueueForExit } from "../runtime/prompt_admission";
import type { AgentCardModel } from "../runtime/agents";
import { removalArchive } from "../runtime/worktree_remove.test-fixtures";

type Element = ReactElement<Record<string, unknown>>;
const props: ComponentProps<typeof EmptyState> = {
  active: true,
  agents: [
    { id: "ready-agent", name: "Agent", status: "installed" } as AgentCardModel,
  ],
  onGoSettings: vi.fn(),
  onStarted: vi.fn(),
  onPreparedKey: vi.fn(),
  onProjectChange: vi.fn(),
};
function nodes(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [
          child,
          ...nodes(
            child.type === NewConversationLocationBar
              ? NewConversationLocationBar(
                  child.props as ComponentProps<
                    typeof NewConversationLocationBar
                  >,
                )
              : (child.props.children as ReactNode),
          ),
        ]
      : [],
  );
}
function render(): Element[] {
  for (let pass = 0; pass < 10; pass++) {
    h.cursor = 0;
    const view = nodes(EmptyState(props));
    if (!h.effects.length) return view;
    h.effects.splice(0).forEach((effect) => effect());
  }
  throw new Error("render loop");
}
function composer(): Element {
  return render().find((node) => node.type === Composer)!;
}
function control(label: string): Element {
  return nodes(composer().props.controls as ReactNode).find(
    (node) => node.props["aria-label"] === label,
  )!;
}
function composerControls(): Element[] {
  const view = composer();
  const { slots, cursor, effects } = h;
  h.slots = [];
  h.cursor = 0;
  h.effects = [];
  h.renderingComposer = true;
  try {
    return nodes(Composer(view.props as ComponentProps<typeof Composer>));
  } finally {
    Object.assign(h, { slots, cursor, effects, renderingComposer: false });
  }
}
function chooseSameAgent() {
  (control("选择 Agent").props.onClick as () => void)();
  const picker = render().find(
    (node) => node.type === NewConversationAgentDialog,
  )!;
  (picker.props.onPick as (id: string) => void)("ready-agent");
  render();
}
function prepared(key = "prepared") {
  const state = freshThreadState(key, "ready-agent", "/project", "native");
  state.configOptions = [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "saved-model",
      options: [
        { value: "saved-model", name: "Saved" },
        { value: "other-model", name: "Other" },
      ],
    },
    {
      id: "reasoning",
      name: "Reasoning",
      type: "select",
      currentValue: "high",
      options: [
        { value: "high", name: "High" },
        { value: "low", name: "Low" },
      ],
    },
  ];
  return state;
}
async function settle() {
  for (let step = 0; step < 20; step++) await Promise.resolve();
}
function unmount() {
  h.slots.forEach((slot) => slot.cleanup?.());
  h.slots = [];
  h.effects = [];
}
async function beginSend() {
  // Composer marks its actual submitted snapshot before invoking onSend.
  const view = composer();
  composerDrafts.update("new", (draft) => ({ ...draft, sendPending: true }));
  const result = await (
    view.props.onSend as (
      blocks: unknown[],
      draft: unknown,
    ) => Promise<void | false>
  )([{ type: "text", text: "Explicit request" }], composerDrafts.read("new"));
  // Honor Composer.tsx's false acknowledgment: preparation did not send, so
  // release its submit marker without clearing the retained input.
  if (
    result === false &&
    composerDrafts.read("new").sendPending &&
    !composerDrafts.read("new").pendingConversation
  )
    composerDrafts.update("new", (draft) => ({ ...draft, sendPending: false }));
  return result;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockResolvedValue(null);
  h.slots = [];
  h.effects = [];
  h.workReady = true;
  h.workError = null;
  h.composerWorkReady = false;
  h.workRetry.mockReset();
  vi.mocked(chooseDirectory).mockReset();
  h.catalogue = {
    ready: true,
    loading: false,
    error: null,
    archives: [],
    recoveries: [],
  };
  h.threads.clear();
  h.open.mockReset().mockImplementation(async () => {
    const state = prepared();
    h.threads.set(state.key, state);
    return state;
  });
  h.send.mockReset().mockImplementation(async (key: string) => {
    h.threads.get(key)!.identity = "established";
  });
  h.setConfig.mockReset().mockImplementation(async (key, id, value) => {
    h.threads
      .get(key)!
      .configOptions.find((option) => option.id === id)!.currentValue = value;
  });
  h.discard.mockReset().mockImplementation(async (key: string) => {
    h.threads.delete(key);
  });
  props.active = true;
  vi.mocked(props.onStarted).mockClear();
  vi.mocked(props.onPreparedKey!).mockClear();
  allowAutomaticConnection("ready-agent");
  Object.assign(newConversationChoice, {
    agentId: "ready-agent",
    cwd: "/project",
    reviewRequired: false,
    service: null,
    config: { model: "saved-model", reasoning: "high" },
  });
  composerDrafts.update("new", () => ({
    text: "Keep this draft",
    attachments: [
      {
        id: "kept",
        kind: "file",
        name: "keep.txt",
        content: "Keep this attachment",
      },
    ],
  }));
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  composerDrafts.clear("new");
});

it("restores a complete ready choice and draft without opening a new conversation on mount", async () => {
  const original = composerDrafts.read("new");
  const choice = structuredClone({ ...newConversationChoice });
  composer();
  await vi.advanceTimersByTimeAsync(300);
  render();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
  expect(composerDrafts.read("new")).toBe(original);
  expect({ ...newConversationChoice }).toEqual(choice);
});

it("opens the declared checked conversation only on the ordinary open action and preserves unsent text", async () => {
  vi.mocked(invoke).mockImplementation(async (name) =>
    name === "agent_preparation"
      ? {
          officialConversationCheck: {
            id: "official-check",
            modelOptionId: "model",
            reasoningOptionId: "reasoning",
          },
        }
      : null,
  );
  const state = prepared();
  state.identity = "established";
  state.conversationAccess = {
    kind: "zero-send",
    receipt: {
      accountVerified: true,
      provider: "openai",
      fileAccess: "read-only",
      toolNetwork: false,
      approval: "on-request",
      model: "saved-model",
      effort: "high",
    },
  };
  h.open.mockResolvedValue(state);
  const original = composerDrafts.read("new");
  render();
  await settle();
  chooseSameAgent();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).not.toHaveBeenCalled();
  expect(composer().props.disabled).toBe(true);
  const action = render().find(
    (node) =>
      node.type === "button" && node.props.children === ZERO_SEND_STRINGS.open,
  )!;
  expect(action.props.disabled).toBe(false);
  (action.props.onClick as () => void)();
  (action.props.onClick as () => void)();
  await settle();
  expect(h.open).toHaveBeenCalledExactlyOnceWith({
    agentId: "ready-agent",
    cwd: "/project",
    configOptions: { model: "saved-model", reasoning: "high" },
    fresh: true,
    openPurpose: "codex-official-check",
  });
  expect(props.onStarted).toHaveBeenCalledExactlyOnceWith(state.key);
  expect(h.send).not.toHaveBeenCalled();
  expect(composerDrafts.read("new")).toBe(original);
});

it.each(["retry", "reselect"] as const)(
  "recovers the same restored working folder through %s with the draft intact",
  async (action) => {
    const original = composerDrafts.read("new");
    const choice = structuredClone({ ...newConversationChoice });
    h.workReady = false;
    h.workError = ERROR_STRINGS.workDirectoryUnavailable;
    h.workRetry.mockImplementation(() => {
      h.workReady = true;
      h.workError = null;
    });
    const sendButton = () =>
      composerControls().find(
        (node) => node.props["aria-label"] === STRINGS.composer.sendTitle,
      )!;
    const workNotice = () =>
      composerControls().find((node) => node.type === ComposerWorkNotice);
    expect(sendButton().props.disabled).toBe(true);
    expect(workNotice()?.props.message).toBe(
      ERROR_STRINGS.workDirectoryUnavailable,
    );
    if (action === "retry") {
      const notice = workNotice()!;
      const retry = nodes(
        ComposerWorkNotice(
          notice.props as ComponentProps<typeof ComposerWorkNotice>,
        ),
      ).find(
        (node) =>
          node.type === "button" &&
          node.props.children === STRINGS.service.retry,
      )!;
      (retry.props.onClick as () => void)();
    } else {
      vi.mocked(chooseDirectory).mockResolvedValue("/project");
      const folder = render().find(
        (node) => node.props["aria-label"] === WORKSPACE_STRINGS.changeFolder,
      )!;
      (folder.props.onClick as () => void)();
      await settle();
    }
    render();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.workRetry).toHaveBeenCalledExactlyOnceWith("/project");
    if (action === "retry") expect(h.open).not.toHaveBeenCalled();
    expect(workNotice()?.props.message).not.toBe(
      ERROR_STRINGS.workDirectoryUnavailable,
    );
    expect(sendButton().props.disabled).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
    expect(composerDrafts.read("new")).toBe(original);
    expect({ ...newConversationChoice }).toEqual(choice);
  },
);

it.each(["hidden-return", "remount", "ready-refresh"])(
  "%s does not turn the restored choice into a new preparation intent",
  async (change) => {
    const original = composerDrafts.read("new");
    if (change === "ready-refresh") h.workReady = false;
    composer();
    if (change === "hidden-return") {
      props.active = false;
      render();
      props.active = true;
    } else if (change === "remount") unmount();
    else h.workReady = true;
    render();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(composerDrafts.read("new")).toBe(original);
  },
);

it.each(["agent", "model"])(
  "an explicit %s action may prepare once without changing the saved choice or sending",
  async (action) => {
    const original = composerDrafts.read("new");
    const choice = structuredClone({ ...newConversationChoice });
    if (action === "agent") chooseSameAgent();
    else (control("模型与来源").props.onClick as () => void)();
    render();
    await vi.advanceTimersByTimeAsync(300);
    render();
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ready-agent", cwd: "/project" }),
    );
    expect(h.open.mock.calls[0][0].nativeSessionId).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    expect(composerDrafts.read("new")).toBe(original);
    expect({ ...newConversationChoice }).toEqual(choice);
    expect(props.onPreparedKey).toHaveBeenLastCalledWith("prepared");
  },
);

it("retains an already prepared draft and its browser owner while hidden without another preparation", async () => {
  const original = composerDrafts.read("new");
  chooseSameAgent();
  await vi.advanceTimersByTimeAsync(300);
  render();
  const state = h.threads.get("prepared");
  expect(props.onPreparedKey).toHaveBeenLastCalledWith("prepared");
  props.active = false;
  render();
  await vi.advanceTimersByTimeAsync(300);
  props.active = true;
  render();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.threads.get("prepared")).toBe(state);
  expect(props.onPreparedKey).toHaveBeenLastCalledWith("prepared");
  expect(h.discard).not.toHaveBeenCalled();
  expect(h.open).toHaveBeenCalledOnce();
  expect(h.send).not.toHaveBeenCalled();
  expect(composerDrafts.read("new")).toBe(original);
});

it.each(["duplicate", "different source", "retry after failure"] as const)(
  "protects prepared work while restoring a retained draft (%s)",
  async (action) => {
    const ticket = await composerDrafts.preserveNew();
    const [[savedKey, saved]] = composerDrafts.preserved();
    composerDrafts.clearPreservedNew(ticket);
    const otherText = "another retained draft";
    if (action === "different source") {
      composerDrafts.update("new", () => ({
        text: otherText,
        attachments: [],
      }));
      composerDrafts.clearPreservedNew(await composerDrafts.preserveNew());
    }
    composerDrafts.update("new", () => ({
      text: "active input",
      attachments: [],
    }));
    const restore = vi.fn(async (key: string) => {
      await composerDrafts.restorePreserved(key);
    });
    props.onRestoreDraft = restore;
    let releaseWrite!: () => void;
    let rejectWrite!: (reason: Error) => void;
    const writing = new Promise<void>((resolve, reject) => {
      releaseWrite = resolve;
      rejectWrite = reject;
    });
    vi.mocked(draftPersistence.flush)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(writing);
    const retainedSlots: typeof h.slots = [];
    function restoreButton(text = saved.text) {
      const retained = render().find((node) => node.type === PreservedDrafts)!;
      const { slots, cursor } = h;
      h.slots = retainedSlots;
      h.cursor = 0;
      try {
        const row = nodes(
          PreservedDrafts(
            retained.props as ComponentProps<typeof PreservedDrafts>,
          ),
        )
          .filter((node) => node.type === "article")
          .find((node) =>
            nodes(node.props.children as ReactNode).some(
              (child) =>
                child.type === "strong" && child.props.children === text,
            ),
          )!;
        return nodes(row.props.children as ReactNode).find(
          (node) => node.type === "button",
        )!;
      } finally {
        h.slots = slots;
        h.cursor = cursor;
      }
    }
    try {
      await (restoreButton().props.onClick as () => Promise<void>)();
      expect(restore).toHaveBeenCalledExactlyOnceWith(savedKey);
      expect(composerDrafts.preserved()).toContainEqual([savedKey, saved]);
      chooseSameAgent();
      await vi.advanceTimersByTimeAsync(300);
      render();
      const prepared = h.threads.get("prepared");
      expect(prepared).toBeDefined();
      expect(props.onPreparedKey).toHaveBeenLastCalledWith("prepared");
      const draft = composerDrafts.read("new");

      if (action === "different source") {
        const otherKey = composerDrafts
          .preserved()
          .find(([, value]) => value.text === otherText)![0];
        vi.mocked(draftPersistence.flush).mockReturnValueOnce(writing);
        const second = (
          restoreButton(otherText).props.onClick as () => Promise<void>
        )();
        expect(restore.mock.calls).toEqual([[savedKey], [otherKey]]);
        releaseWrite();
        await second;
        expect(composerDrafts.read("new").text).toBe(otherText);
        expect(h.send).not.toHaveBeenCalled();
        return;
      }

      if (action === "retry after failure") {
        rejectWrite(new Error("retained draft write failed"));
        await settle();
        expect(composerDrafts.preserved()).toContainEqual([savedKey, saved]);
        await (restoreButton().props.onClick as () => Promise<void>)();
        await settle();
        expect(restore.mock.calls).toEqual([[savedKey], [savedKey]]);
        expect(composerDrafts.read("new").text).toBe(saved.text);
        expect(composerDrafts.preserved()).not.toContainEqual([
          savedKey,
          saved,
        ]);
        expect(h.send).not.toHaveBeenCalled();
        return;
      }

      const duplicate = restoreButton();
      expect(duplicate.props.disabled).toBe(false);
      await (duplicate.props.onClick as () => Promise<void>)();
      render();
      expect.soft(restore).toHaveBeenCalledExactlyOnceWith(savedKey);
      expect.soft(h.discard).not.toHaveBeenCalled();
      expect.soft(h.threads.get("prepared")).toBe(prepared);
      expect.soft(props.onPreparedKey).toHaveBeenLastCalledWith("prepared");
      expect(composerDrafts.read("new")).toBe(draft);
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      releaseWrite();
      await settle();
      delete props.onRestoreDraft;
      for (const [key] of composerDrafts.preserved()) composerDrafts.clear(key);
    }
  },
);

it.each(["agent", "model"])(
  "reuses the pending preparation when another explicit %s action occurs during config confirmation",
  async (action) => {
    const original = composerDrafts.read("new");
    const state = prepared("confirming");
    state.configOptions[0].currentValue = "other-model";
    // The real store deduplicates an in-flight open to this same object.
    h.open.mockImplementation(async () => {
      h.threads.set(state.key, state);
      return state;
    });
    let release = () => {};
    const confirmation = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.setConfig.mockImplementation(async (_key, id, value) => {
      if (id === "model") await confirmation;
      state.configOptions.find((option) => option.id === id)!.currentValue =
        value;
    });
    try {
      chooseSameAgent();
      await vi.advanceTimersByTimeAsync(300);
      render();
      expect(h.open).toHaveBeenCalledOnce();
      expect(h.setConfig).toHaveBeenCalledExactlyOnceWith(
        "confirming",
        "model",
        "saved-model",
      );
      expect(props.onPreparedKey).not.toHaveBeenCalledWith("confirming");
      expect(h.threads.get(state.key)).toBe(state);
      if (action === "agent") chooseSameAgent();
      else (control("模型与来源").props.onClick as () => void)();
      render();
      await vi.advanceTimersByTimeAsync(300);
      expect(h.open).toHaveBeenCalledOnce();
      expect(h.discard).not.toHaveBeenCalled();
      expect(h.threads.get(state.key)).toBe(state);
      expect(h.send).not.toHaveBeenCalled();
      release();
      await settle();
      render();
      expect(props.onPreparedKey).toHaveBeenLastCalledWith("confirming");
      expect(composer().props.disabled).toBe(false);
      expect(state.configOptions.map((option) => option.currentValue)).toEqual([
        "saved-model",
        "high",
      ]);
      expect(h.open).toHaveBeenCalledOnce();
      expect(h.setConfig).toHaveBeenCalledOnce();
      expect(h.discard).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
      expect(composerDrafts.read("new")).toBe(original);
    } finally {
      release();
      await settle();
    }
  },
);

it("an earlier send callback reuses the now-confirmed same draft after attachment preparation", async () => {
  const oldSend = composer().props.onSend as (
    blocks: unknown[],
    draft: unknown,
  ) => Promise<boolean>;
  const original = composerDrafts.read("new");
  (control("模型与来源").props.onClick as () => void)();
  render();
  await vi.advanceTimersByTimeAsync(300);
  render();
  const state = h.threads.get("prepared");
  expect(h.open).toHaveBeenCalledOnce();
  expect(composer().props.disabled).toBe(false);
  expect(composerDrafts.read("new")).toBe(original);
  // Composer may finish attachment work/flush after this same-pair view is
  // ready. Its captured callback still belongs to the original submitted input.
  composerDrafts.update("new", (draft) => ({ ...draft, sendPending: true }));
  const blocks = [{ type: "text", text: original.text }];
  const result = await oldSend(blocks, composerDrafts.read("new"));
  if (
    result === false &&
    composerDrafts.read("new").sendPending &&
    !composerDrafts.read("new").pendingConversation
  )
    composerDrafts.update("new", (draft) => ({ ...draft, sendPending: false }));
  render();
  await vi.advanceTimersByTimeAsync(300);
  render();
  expect(h.open).toHaveBeenCalledOnce();
  expect(h.discard).not.toHaveBeenCalled();
  expect(h.threads.get("prepared")).toBe(state);
  expect(h.send).toHaveBeenCalledExactlyOnceWith("prepared", blocks);
  expect(props.onStarted).toHaveBeenCalledExactlyOnceWith("prepared");
  expect(newConversationChoice.config).toEqual({
    model: "saved-model",
    reasoning: "high",
  });
});

it("first send prepares once, confirms the saved configuration before one send, then consumes that intent", async () => {
  const state = prepared();
  state.configOptions[0].currentValue = "other-model";
  state.configOptions[1].currentValue = "low";
  h.open.mockImplementation(async () => {
    h.threads.set(state.key, state);
    return state;
  });
  let releaseModel = () => {};
  const modelConfirmation = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  h.setConfig.mockImplementation(async (key, id, value) => {
    if (id === "model") await modelConfirmation;
    h.threads
      .get(key)!
      .configOptions.find((option) => option.id === id)!.currentValue = value;
  });
  const sentConfigurations: unknown[] = [];
  h.send.mockImplementation(async (key: string) => {
    const target = h.threads.get(key)!;
    sentConfigurations.push(
      Object.fromEntries(
        target.configOptions.map((o) => [o.id, o.currentValue]),
      ),
    );
    target.identity = "established";
  });
  const sending = beginSend();
  const settled = sending.catch(() => {});
  let preparedOnly = false;
  void sending.then(
    (result) => {
      preparedOnly = result === false;
    },
    () => {},
  );
  try {
    await settle();
    if (preparedOnly) {
      render();
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.setConfig).toHaveBeenNthCalledWith(
      1,
      "prepared",
      "model",
      "saved-model",
    );
    expect(h.send).not.toHaveBeenCalled();
    expect(composerDrafts.read("new").text).toBe("Keep this draft");
    expect(composerDrafts.read("new").attachments[0].name).toBe("keep.txt");
    releaseModel();
    await sending;
    await settle();
    render();
    if (preparedOnly) {
      // Consume only the real one-shot request raised after config is ready.
      expect(composer().props.sendRequest).toBeGreaterThan(0);
      await beginSend();
    }
    expect(h.setConfig).toHaveBeenNthCalledWith(
      2,
      "prepared",
      "reasoning",
      "high",
    );
    expect(h.send).toHaveBeenCalledExactlyOnceWith("prepared", [
      { type: "text", text: "Explicit request" },
    ]);
    expect(sentConfigurations).toEqual([
      { model: "saved-model", reasoning: "high" },
    ]);
    expect(props.onStarted).toHaveBeenCalledExactlyOnceWith("prepared");
    render();
    await vi.advanceTimersByTimeAsync(600);
    props.active = false;
    render();
    props.active = true;
    render();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledOnce();
  } finally {
    releaseModel();
    await settled;
  }
});

it.each(["hidden", "archived"])(
  "a late explicitly prepared reply after becoming %s cannot present or send the draft",
  async (change) => {
    const original = composerDrafts.read("new");
    const state = prepared("late");
    let finish!: (state: ThreadState) => void;
    h.open.mockImplementation(
      () =>
        new Promise<ThreadState>((resolve) => {
          finish = resolve;
        }),
    );
    chooseSameAgent();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.open).toHaveBeenCalledOnce();
    if (change === "hidden") props.active = false;
    else
      h.catalogue.archives = [{ ...removalArchive, originalPath: "/project" }];
    render();
    h.threads.set(state.key, state);
    finish(state);
    await settle();
    render();
    expect(h.discard).toHaveBeenCalledExactlyOnceWith("late");
    expect(props.onPreparedKey).not.toHaveBeenCalledWith("late");
    expect(h.send).not.toHaveBeenCalled();
    expect(composerDrafts.read("new")).toBe(original);
  },
);

it("an unknown first-send result retains its target and never prepares or sends again on return", async () => {
  h.send.mockImplementation(async (key: string, blocks) => {
    h.threads.get(key)!.uncertainPrompt = blocks;
  });
  let result: void | false;
  let failure: unknown;
  try {
    result = await beginSend();
    if (result === false) {
      render();
      await vi.advanceTimersByTimeAsync(300);
      render();
      expect(composer().props.sendRequest).toBeGreaterThan(0);
      await beginSend();
    }
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(h.open).toHaveBeenCalledOnce();
  expect(h.send).toHaveBeenCalledOnce();
  const pending = composerDrafts.read("new");
  expect(pending.pendingConversation?.nativeSessionId).toBe("native");
  expect(pending.sendPending).toBe(true);
  expect(pending.text).toBe("Keep this draft");
  props.active = false;
  render();
  props.active = true;
  render();
  await vi.advanceTimersByTimeAsync(600);
  expect(h.open).toHaveBeenCalledOnce();
  expect(h.send).toHaveBeenCalledOnce();
  expect(composerDrafts.read("new")).toBe(pending);
});

it("returns an undispatched first send without closing a same-key replacement after quit", async () => {
  chooseSameAgent();
  await vi.advanceTimersByTimeAsync(300);
  render();
  const original = h.threads.get("prepared")!;
  original.connectionId = "original-prepared-connection";
  let release!: () => void;
  const check = new Promise<void>((resolve) => (release = resolve));
  h.send.mockImplementation(
    async (_key, blocks: ThreadState["queued"][number]) => {
      original.submitting = true;
      original.queued.push(blocks);
      original.promptSubmission = {
        blocks,
        connectionId: original.connectionId,
        dispatched: false,
        deliveryConfirmed: false,
      };
      await check;
      original.submitting = false;
      return { status: "rejected", reason: "unavailable" };
    },
  );
  const sending = beginSend();
  try {
    await settle();
    expect(h.send).toHaveBeenCalledOnce();
    expect(
      composerDrafts.read("new").pendingConversation?.nativeSessionId,
    ).toBe(original.nativeSessionId);
    pauseQueueForExit(original, true);
    const returned = composerDrafts.read("new");
    expect(returned.pendingConversation).toBeUndefined();
    unmount();
    h.discard.mockClear();
    const replacement = prepared();
    replacement.connectionId = "replacement-prepared-connection";
    h.threads.set(replacement.key, replacement);
    release();
    expect(await sending).toBe(false);
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.threads.get(replacement.key)).toBe(replacement);
    expect(composerDrafts.read("new")).toBe(returned);
  } finally {
    release();
    await sending;
  }
});
