import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ThreadState } from "../runtime/session_types";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  open: vi.fn(),
  live: null as ThreadState | null,
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
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !deps ||
      !slot.deps ||
      deps.some((v, i) => !Object.is(v, slot.deps?.[i]))
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({ cwd, ready: true, enabled: () => true }),
}));
vi.mock("../runtime/connection_hold", () => ({ useConnectionHold: () => {} }));
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: () => ({ service: null, config: { model: "chosen" } }),
  },
}));
vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: (key: string) => (key === h.live?.key ? h.live : null),
  threads: {
    open: h.open,
    setConfig: vi.fn(),
    confirmRestoredConfig: vi.fn(),
    discardDraft: vi.fn(),
    thread: (key: string) => (key === h.live?.key ? h.live : undefined),
  },
}));
vi.mock(
  "../runtime/worktrees",
  () => import("../runtime/worktree_catalogue.test-fixture"),
);
import { EmptyState } from "./EmptyState";
import { Composer } from "./Composer";
import {
  composerDrafts,
  draftPersistence,
  fileFeedbackDrafts,
  newConversationChoice,
} from "../runtime/drafts";
import { freshThreadState } from "../runtime/session_projection";
import { allowAutomaticConnection } from "../runtime/connection_intent";
import { SessionToolChangeGuards } from "../runtime/session_tool_change_guards";
import { BrowserSurfaceGuard } from "../runtime/browser_surface_guard";

let props: ComponentProps<typeof EmptyState>;
function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  const result: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
function render() {
  for (let pass = 0; pass < 12; pass++) {
    h.cursor = 0;
    const tree = nodes(EmptyState(props));
    if (!h.effects.length) return tree.find((node) => node.type === Composer)!;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw new Error("render loop");
}
beforeEach(() => {
  vi.useFakeTimers();
  h.slots = [];
  h.effects = [];
  h.open.mockReset();
  allowAutomaticConnection("saved-editor-agent");
  newConversationChoice.agentId = "saved-editor-agent";
  newConversationChoice.cwd = "/owned-editor";
  newConversationChoice.service = null;
  newConversationChoice.config = { model: "chosen" };
  newConversationChoice.reviewRequired = false;
  h.live = freshThreadState(
    "saved-editor",
    "saved-editor-agent",
    "/owned-editor",
    "native-owned",
  );
  h.live.connectionId = "connection-owned";
  h.live.configOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "chosen",
      options: [{ value: "chosen", name: "Chosen" }],
    },
  ];
  h.open.mockResolvedValue(h.live);
  composerDrafts.clear("session:saved-editor");
  composerDrafts.update("new", () => ({
    text: "Keep my prepared input",
    attachments: [
      {
        id: "owned",
        kind: "file",
        name: "owned.txt",
        uri: "file:///owned-editor/owned.txt",
      },
    ],
  }));
  props = {
    agents: [
      {
        id: "saved-editor-agent",
        name: "Selected",
        status: "connected",
      } as never,
    ],
    initialAgentId: "saved-editor-agent",
    onGoSettings: vi.fn(),
    onProjectChange: vi.fn(),
    onStarted: vi.fn(),
    onPreparedKey: vi.fn(),
    onPreparedComposerOwner: vi.fn(),
    onPreparedSaved: (state, move) => {
      if (!move()) return false;
      props.onStarted(state.key);
      return true;
    },
  };
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(draftPersistence, "snapshot").mockReturnValue({
    ready: true,
    saving: false,
    error: null,
  });
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
  composerDrafts.clear("new");
  composerDrafts.clear("session:saved-editor");
});

async function prepare() {
  render();
  await vi.advanceTimersByTimeAsync(300);
  expect(render().props.disabled).toBe(false);
  expect(props.onPreparedKey).toHaveBeenLastCalledWith("saved-editor");
  const guard = new SessionToolChangeGuards({
    current: () => h.live!,
    emit: () => {},
  });
  const operationId = "aaaaaaaa-aaaa-aaaa-aaaa-000000000077";
  expect(guard.claim(h.live!, operationId)).toBe(true);
  return { guard, operationId, owner: h.live! };
}
it("hands the same prepared editor to its saved conversation after a confirmed tool change, without opening or sending again", async () => {
  const { guard, operationId, owner } = await prepare();
  const original = composerDrafts.read("new");
  const formerEditor = vi.mocked(props.onPreparedComposerOwner!).mock
    .lastCall![0]!;
  fileFeedbackDrafts.update(owner.key, "/owned-editor/owned.txt", {
    text: "Keep separate file opinion",
    selection: null,
    contentId: "version-owned",
  });
  const opinions = fileFeedbackDrafts.entries(owner.key);
  const choice = structuredClone({ ...newConversationChoice });
  expect(guard.saved(h.live!, operationId)).toBe(true);
  expect(guard.settle(h.live!, operationId)).toBe(true);
  expect(h.live!.identity).toBe("established");
  render();
  await Promise.resolve();
  render();
  expect(props.onStarted).toHaveBeenCalledExactlyOnceWith("saved-editor");
  expect(composerDrafts.read("session:saved-editor")).toBe(original);
  expect(composerDrafts.hasContent("new")).toBe(false);
  expect(formerEditor()).toBe(false);
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(fileFeedbackDrafts.entries(owner.key)).toBe(opinions);
  expect({ ...newConversationChoice }).toEqual(choice);
});

it("keeps the prepared editor while a saved tool mutation remains unconfirmed, then hands off once it settles", async () => {
  const { guard, operationId, owner } = await prepare();
  const input = composerDrafts.read("new");
  guard.saved(owner, operationId);
  guard.markUnknown(owner, operationId);
  expect(render().props.disabled).toBe(true);
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(composerDrafts.read("new")).toBe(input);
  expect(guard.settle(owner, operationId)).toBe(true);
  render();
  expect(props.onStarted).toHaveBeenCalledExactlyOnceWith(owner.key);
  expect(composerDrafts.read(`session:${owner.key}`)).toBe(input);
});

it.each([
  "hidden",
  "replacement",
  "connection",
  "service",
  "selected-source",
  "new-generation",
])(
  "does not adopt another editor after %s changes while the tool result is arriving",
  async (change) => {
    const { guard, operationId, owner } = await prepare();
    guard.saved(owner, operationId);
    guard.settle(owner, operationId);
    if (change === "hidden") props.active = false;
    if (change === "replacement") h.live = { ...owner };
    if (change === "connection") owner.connectionId = "replacement-connection";
    if (change === "service") owner.serviceContext = "replacement-service";
    if (change === "selected-source")
      newConversationChoice.cwd = "/another-choice";
    if (change === "new-generation") composerDrafts.clear("new");
    composerDrafts.update("new", (value) => ({
      ...value,
      text: "Newer content to keep",
    }));
    const input = composerDrafts.read("new");
    render();
    expect(props.onStarted).not.toHaveBeenCalled();
    expect(composerDrafts.read("new")).toBe(input);
    expect(composerDrafts.hasContent(`session:${owner.key}`)).toBe(false);
    expect(h.open).toHaveBeenCalledTimes(1);
  },
);

it.each(["delayed", "rejected"])(
  "does not hide unsent input behind a %s ordinary browser navigation",
  async (outcome) => {
    const route = new BrowserSurfaceGuard();
    let reject!: (reason: unknown) => void;
    const hide = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const surface = route.register(async () => {}, hide);
    const opened = vi.fn();
    props.onStarted = (key) => route.runLatest(() => opened(key));
    props.onPreparedSaved = undefined;
    const { guard, operationId, owner } = await prepare();
    const original = composerDrafts.read("new");
    guard.saved(owner, operationId);
    guard.settle(owner, operationId);
    render();
    if (outcome === "rejected" && hide.mock.calls.length)
      reject(new Error("synthetic native hide rejection"));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    try {
      // No successful route handoff: the still-visible new editor must retain its input.
      expect(opened).not.toHaveBeenCalled();
      expect(composerDrafts.read("new")).toBe(original);
      expect(hide).not.toHaveBeenCalled();
    } finally {
      surface.release();
    }
  },
);

it("waits for a pending file read, then moves its complete result without duplicating the connection", async () => {
  const { guard, operationId, owner } = await prepare();
  composerDrafts.update("new", (input) => ({
    ...input,
    attachments: input.attachments.map((item) => ({ ...item, loading: true })),
  }));
  guard.saved(owner, operationId);
  guard.settle(owner, operationId);
  render();
  expect(props.onStarted).not.toHaveBeenCalled();
  composerDrafts.update("new", (input) => ({
    ...input,
    attachments: input.attachments.map((item) => ({
      ...item,
      loading: false,
      content: "complete owned bytes",
    })),
  }));
  const completed = composerDrafts.read("new");
  render();
  expect(props.onStarted).toHaveBeenCalledExactlyOnceWith(owner.key);
  expect(composerDrafts.read(`session:${owner.key}`)).toBe(completed);
  expect(h.open).toHaveBeenCalledTimes(1);
});

it.each([
  "destination",
  "sendPending",
  "pendingConversation",
  "interactionLocked",
  "sessionToolRecoveryRequired",
  "uncertainPrompt",
  "connectionOutcomeUnknown",
  "stopUnconfirmed",
])(
  "preserves both inputs instead of transferring through %s",
  async (blocked) => {
    const { guard, operationId, owner } = await prepare();
    guard.saved(owner, operationId);
    guard.settle(owner, operationId);
    if (blocked === "destination")
      composerDrafts.update(`session:${owner.key}`, () => ({
        text: "Existing conversation draft",
        attachments: [],
      }));
    if (blocked === "sendPending")
      composerDrafts.update("new", (input) => ({
        ...input,
        sendPending: true,
      }));
    if (blocked === "pendingConversation")
      composerDrafts.update("new", (input) => ({
        ...input,
        pendingConversation: {
          agentId: owner.agentId,
          cwd: owner.cwd,
          nativeSessionId: owner.nativeSessionId,
        },
      }));
    if (blocked === "interactionLocked")
      vi.mocked(draftPersistence.snapshot).mockReturnValue({
        ready: true,
        saving: false,
        error: null,
        interactionLocked: true,
      });
    if (blocked === "sessionToolRecoveryRequired")
      owner.sessionToolRecoveryRequired = true;
    if (blocked === "uncertainPrompt")
      owner.uncertainPrompt = [{ type: "text", text: "unknown" }];
    if (blocked === "connectionOutcomeUnknown")
      owner.connectionOutcomeUnknown = true;
    if (blocked === "stopUnconfirmed") owner.stopUnconfirmed = true;
    const source = composerDrafts.read("new"),
      target = composerDrafts.read(`session:${owner.key}`);
    render();
    expect(props.onStarted).not.toHaveBeenCalled();
    expect(composerDrafts.read("new")).toBe(source);
    expect(composerDrafts.read(`session:${owner.key}`)).toBe(target);
  },
);
