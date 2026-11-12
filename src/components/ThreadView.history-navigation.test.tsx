import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => unknown)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = { current: initial };
    return h.slots[index];
  },
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = initial;
    return [
      h.slots[index],
      (value: unknown) => {
        h.slots[index] =
          typeof value === "function" ? value(h.slots[index]) : value;
      },
    ];
  },
  useMemo: (read: () => unknown) => read(),
  useEffect: (effect: () => unknown) => h.effects.push(effect),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
// These tests invoke ThreadView with a minimal hook harness; browser permissions
// have their own controller/component tests and are absent from these scenarios.
vi.mock("../runtime/browser_sharing", async (original) => {
  const actual = await original<typeof import("../runtime/browser_sharing")>();
  const noop = async () => {};
  const empty: import("../runtime/browser_sharing").BrowserSharingModel = {
    info: null,
    pendingRequest: null,
    operation: null,
    error: "",
    notice: "",
    ready: false,
    queryState: "no_session",
    refresh: noop,
    connect: noop,
    allow: noop,
    stop: noop,
    respond: noop,
  };
  return { ...actual, useBrowserSharing: () => empty };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
// These pre-existing error/retry scenarios have no associated worktree.
// Keep the real notice renderer, without starting catalogue IPC from this hook fixture.
vi.mock("../runtime/worktrees", () => {
  const empty = {
    ready: true,
    loading: false,
    error: null,
    archives: [],
    recoveries: [],
  };
  return {
    worktrees: {
      snapshot: () => empty,
      subscribe: () => () => {},
      load: vi.fn(),
    },
  };
});
import { ThreadView } from "./ThreadView";
import { ErrorNotice } from "./ErrorNotice";
import { ArchivedWorkLocationNotice } from "./ArchivedWorkLocationNotice";
import {
  threads,
  freshThreadState,
  type ThreadState,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { invoke } from "@tauri-apps/api/core";
import { composerDrafts, draftPersistence } from "../runtime/drafts";

let noticeSlots: typeof h.slots = [];
function renderArchivedNotice(
  props: ComponentProps<typeof ArchivedWorkLocationNotice>,
) {
  const parent = { slots: h.slots, cursor: h.cursor, effects: h.effects };
  h.slots = noticeSlots;
  h.cursor = 0;
  h.effects = [];
  try {
    return ArchivedWorkLocationNotice(props);
  } finally {
    noticeSlots = h.slots;
    // Child effects/lifetime are covered by dedicated notice tests, not this parent fixture.
    Object.assign(h, parent);
  }
}
type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    result.push(child);
    result.push(
      ...nodes(
        child.type === ArchivedWorkLocationNotice
          ? renderArchivedNotice(
              child.props as ComponentProps<typeof ArchivedWorkLocationNotice>,
            )
          : (child.props.children as ReactNode),
      ),
    );
  });
  return result;
}
function render(
  thread: ThreadState,
  active: boolean,
  opened: (key: string) => void,
  onRecover?: (key: string) => Promise<void>,
) {
  h.cursor = 0;
  return nodes(
    ThreadView({
      thread,
      active,
      agents: [],
      onGoSettings() {},
      onOpened: opened,
      onRecover,
    }),
  );
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function state(id: string, kind: "history" | "connection") {
  const s = freshThreadState(`fixture:/tmp:${id}`, "fixture", "/tmp", id);
  s.openError = "failed";
  s.identity = "established";
  if (kind === "history")
    s.historyUnavailable = { reason: "empty", sourceKnown: true };
  else s.connectionLost = true;
  return s;
}
async function complete() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  noticeSlots = [];
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(invoke).mockReset().mockResolvedValue(null);
});

it("retries a created but unsent draft's exact native target without a second action or automatic prompt", async () => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  let reject!: (reason: unknown) => void;
  const retry = new Promise<never>((_resolve, fail) => (reject = fail));
  vi.mocked(invoke).mockImplementation((command, args: any) => {
    if (command === "session_open") {
      if (args.nativeSessionId) return retry;
      const result = {
        cwd: args.cwd,
        nativeSessionId: "unsent-created-native",
        connectionId: "unsent-created-connection",
        resumed: false,
        configOptions: [],
      };
      args.channel.onmessage({
        kind: "sessionOpening",
        openToken: args.openToken,
        cwd: result.cwd,
        sessionId: result.nativeSessionId,
        connectionId: result.connectionId,
      });
      return Promise.resolve(result);
    }
    return Promise.resolve(command === "settings_get" ? null : []);
  });
  const s = await threads.open({
    agentId: "fixture-recovery-draft",
    cwd: "/created-draft",
    fresh: true,
  });
  expect(s.identity).toBe("draft");
  s.openError = STRINGS.repair.reconnectFailed;
  s.connectionLost = true;
  const draftKey = `session:${s.key}`;
  composerDrafts.update(draftKey, () => ({
    text: "Unsent draft",
    attachments: [],
  }));
  const opened = vi.fn();
  const button = render(s, true, opened).find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.thread.reconnect,
  )!;
  (button.props.onClick as () => void)();
  const busy = render(s, true, opened).find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.thread.reconnecting,
  )!;
  expect(busy.props.disabled).toBe(true);
  (busy.props.onClick as () => void)();
  const calls = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "session_open");
  expect(calls).toHaveLength(2);
  expect(calls[1][1]).toMatchObject({
    agentId: s.agentId,
    cwd: s.cwd,
    nativeSessionId: s.nativeSessionId,
  });
  reject("fixture retry failure");
  await vi.waitFor(() =>
    expect(
      render(s, true, opened).some(
        (node) => node.props.children === STRINGS.thread.reconnect,
      ),
    ).toBe(true),
  );
  expect(composerDrafts.read(draftKey).text).toBe("Unsent draft");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
  expect(opened).not.toHaveBeenCalled();
});

it.each(["history", "connection"] as const)(
  "follows the explicit %s retry's returned canonical failure target",
  async (kind) => {
    const s = state(`current-${kind}`, kind);
    const result = freshThreadState(
      `fixture:/private/tmp:${s.nativeSessionId}`,
      s.agentId,
      "/private/tmp",
      s.nativeSessionId,
    );
    result.historyUnavailable = { reason: "empty", sourceKnown: true };
    const opened = vi.fn();
    const wait = pending<ThreadState>();
    const reconnect = vi
      .spyOn(threads, "reconnect")
      .mockReturnValue(wait.promise);
    const button = render(s, true, opened).find(
      (node) =>
        node.props.children ===
        (kind === "history"
          ? STRINGS.repair.retryHistory
          : STRINGS.thread.reconnect),
    )!;
    (button.props.onClick as () => void)();
    expect(reconnect).toHaveBeenCalledWith(s.key);
    wait.resolve(result);
    await complete();
    expect(opened).toHaveBeenCalledWith(result.key);
  },
);

it("shows a pending index-open recovery instead of the old startup failure and blocks another recovery", async () => {
  // Installed OpenCode startup diagnostics: selecting its failed history starts
  // another open, while this view's local retry state has never been set.
  const s = state("pending-index-open", "connection");
  const owner = vi.fn().mockResolvedValue(undefined);
  const opened = vi.fn();
  const previousRetry = render(s, true, opened, owner).find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.thread.reconnect,
  )!;
  s.reconnecting = true;
  const waiting = render(s, true, opened, owner);
  const button = waiting.find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.thread.reconnecting,
  );
  expect(button).toBeDefined();
  expect(button!.props.disabled).toBe(true);
  expect(
    waiting.some(
      (node) =>
        node.type === ErrorNotice &&
        (node.props.title === STRINGS.thread.openFailed ||
          node.props.message === s.openError),
    ),
  ).toBe(false);
  (previousRetry.props.onClick as () => void)();
  (button!.props.onClick as () => void)();
  expect(owner).not.toHaveBeenCalled();

  s.reconnecting = false;
  const failed = render(s, true, opened, owner);
  const retry = failed.find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.thread.reconnect,
  )!;
  expect(retry.props.disabled).toBe(false);
  expect(
    failed.some(
      (node) => node.type === ErrorNotice && node.props.message === s.openError,
    ),
  ).toBe(true);
  (retry.props.onClick as () => void)();
  await complete();
  expect(owner).toHaveBeenCalledExactlyOnceWith(s.key);
  expect(opened).not.toHaveBeenCalled();
});

it.each(["inactive", "other-target", "unmounted"] as const)(
  "does not pull a late retry back after the view became %s",
  async (exit) => {
    const s = state(`late-${exit}`, "history");
    const opened = vi.fn();
    const wait = pending<ThreadState>();
    vi.spyOn(threads, "reconnect").mockReturnValue(wait.promise);
    const button = render(s, true, opened).find(
      (node) => node.props.children === STRINGS.repair.retryHistory,
    )!;
    (button.props.onClick as () => void)();
    if (exit === "unmounted") {
      for (const effect of h.effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanup();
      }
    } else
      render(
        exit === "other-target" ? state("other", "history") : s,
        exit !== "inactive",
        opened,
      );
    wait.resolve(
      freshThreadState(
        "canonical",
        "fixture",
        "/private/tmp",
        s.nativeSessionId,
      ),
    );
    await complete();
    expect(opened).not.toHaveBeenCalled();
  },
);

it.each(["history", "connection"] as const)(
  "delegates %s retry to the persistent owner without a second reconnect or local navigation",
  async (kind) => {
    const s = state(`owned-${kind}`, kind);
    const wait = pending<void>();
    const owner = vi.fn().mockReturnValue(wait.promise);
    const opened = vi.fn();
    const reconnect = vi.spyOn(threads, "reconnect");
    const button = render(s, true, opened, owner).find(
      (node) =>
        node.props.children ===
        (kind === "history"
          ? STRINGS.repair.retryHistory
          : STRINGS.thread.reconnect),
    )!;
    (button.props.onClick as () => void)();
    expect(owner).toHaveBeenCalledExactlyOnceWith(s.key);
    for (const effect of h.effects) {
      const cleanup = effect();
      if (typeof cleanup === "function") cleanup();
    }
    wait.resolve();
    await complete();
    expect(reconnect).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  },
);

it("opens the explicit empty-history draft while its view still owns the action", async () => {
  const s = state("new-current", "history");
  const opened = vi.fn();
  const wait = pending<ThreadState>();
  const create = vi
    .spyOn(threads, "newAfterRecoveryFailure")
    .mockReturnValue(wait.promise);
  const button = render(s, true, opened).find(
    (node) => node.props.children === STRINGS.repair.newDraft,
  )!;
  (button.props.onClick as () => void)();
  expect(create).toHaveBeenCalledExactlyOnceWith(s.key);
  wait.resolve(freshThreadState("new-draft", "fixture", "/tmp", "draft"));
  await complete();
  expect(opened).toHaveBeenCalledExactlyOnceWith("new-draft");
});

it.each(["inactive", "other-target", "unmounted"] as const)(
  "does not navigate to a late empty-history draft after the view became %s",
  async (exit) => {
    const s = state(`new-late-${exit}`, "history");
    const opened = vi.fn();
    const wait = pending<ThreadState>();
    vi.spyOn(threads, "newAfterRecoveryFailure").mockReturnValue(wait.promise);
    const button = render(s, true, opened).find(
      (node) => node.props.children === STRINGS.repair.newDraft,
    )!;
    (button.props.onClick as () => void)();
    if (exit === "unmounted") {
      for (const effect of h.effects) {
        const cleanup = effect();
        if (typeof cleanup === "function") cleanup();
      }
    } else
      render(
        exit === "other-target" ? state("new-other", "history") : s,
        exit !== "inactive",
        opened,
      );
    wait.resolve(freshThreadState("late-draft", "fixture", "/tmp", "draft"));
    await complete();
    expect(opened).not.toHaveBeenCalled();
  },
);

it.each(["new-draft", "read"] as const)(
  "keeps recovery actions exclusive while %s is pending and releases its busy state",
  async (first) => {
    const s = state(`exclusive-${first}`, "history");
    const wait = pending<ThreadState>();
    const create = vi
      .spyOn(threads, "newAfterRecoveryFailure")
      .mockReturnValue(wait.promise);
    const reconnect = vi
      .spyOn(threads, "reconnect")
      .mockReturnValue(wait.promise);
    const opened = vi.fn();
    const labels = [STRINGS.repair.newDraft, STRINGS.repair.retryHistory];
    const firstLabel = labels[first === "new-draft" ? 0 : 1];
    const secondLabel = labels[first === "new-draft" ? 1 : 0];
    const firstButton = render(s, true, opened).find(
      (node) => node.props.children === firstLabel,
    )!;
    (firstButton.props.onClick as () => void)();
    const secondButton = render(s, true, opened).find(
      (node) => node.props.children === secondLabel,
    )!;
    // Exercise the handler too: it must honor the same busy guard as the button.
    (secondButton.props.onClick as () => void)();
    expect(create).toHaveBeenCalledTimes(first === "new-draft" ? 1 : 0);
    expect(reconnect).toHaveBeenCalledTimes(first === "read" ? 1 : 0);
    expect(secondButton.props.disabled).toBe(true);
    wait.resolve(s);
    await complete();
    await complete();
    const buttons = render(s, true, opened);
    for (const label of labels)
      expect(
        buttons.find((node) => node.props.children === label)?.props.disabled,
      ).toBe(false);
  },
);
