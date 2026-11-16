import { Children, isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ThreadState } from "../runtime/session_types";
import type { SessionForkControl } from "../runtime/session_fork_control";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value: unknown }[],
  thread: null as ThreadState | null,
  control: null as SessionForkControl | null,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value =
          typeof next === "function"
            ? (next as (value: unknown) => unknown)(slot.value)
            : next;
      },
    ];
  },
  useRef: (current: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current } }).value,
  useEffect: () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../runtime/sessions", () => ({
  useThread: () => h.thread,
  useThreadsSnapshot: () => ({ index: [], version: 0 }),
  threads: { needsAttention: () => false },
  hasActiveWork: () => false,
  basename: (value: string) => value,
}));
vi.mock("../runtime/session_fork_ui", () => ({
  sessionForkControl: () => h.control,
}));
vi.mock("../runtime/conversation_read_state", () => ({
  useVisibleConversation: () => {},
  canMarkConversationRead: () => false,
}));
vi.mock("../runtime/archive_blockers", () => ({
  useArchiveBlockReasons: () => new Map(),
}));
vi.mock("../runtime/collections", () => ({
  CollectionActionScope: class {
    invalidate() {}
  },
  useCollections: () => ({ ready: true, groups: [], assignments: {} }),
  collections: {},
}));
vi.mock("../runtime/browser_surface", () => ({
  browserSurfaceGuard: { runLatest: (run: () => void) => run() },
  useBrowserSurfaceBarrier: () => true,
}));
vi.mock("./ThreadView", () => ({ ThreadView: () => null }));
vi.mock("./ConversationExportHost", () => ({
  ConversationExportHost: () => null,
}));
vi.mock("./MoveConversationsDialog", () => ({
  MoveConversationsDialog: () => null,
}));
vi.mock("./DeleteConversationsDialog", () => ({
  DeleteConversationsDialog: () => null,
}));
import { ThreadPage } from "./ThreadPage";
import { ThreadView } from "./ThreadView";
import { SessionForkDialog } from "./SessionForkDialog";
import { SESSION_FORK_STRINGS as S } from "../runtime/session_fork_strings";
import { LIBRARY } from "../runtime/library_strings";
type Element = { type: unknown; props: Record<string, unknown> };
let active: boolean;
const opened = vi.fn();
function render() {
  h.cursor = 0;
  return ThreadPage({
    viewKey: h.thread?.key ?? "parent",
    active,
    agents: { cards: [] } as unknown as Parameters<
      typeof ThreadPage
    >[0]["agents"],
    onGoSettings: vi.fn(),
    onOpened: opened,
    onBack: vi.fn(),
    onNew: vi.fn(),
    navToggle: null,
  });
}
function nodes(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [
          { type: child.type, props: child.props },
          ...nodes(child.props.children as ReactNode),
          ...nodes(child.props.header as ReactNode),
        ]
      : [],
  );
}
const button = (label: string, tree = nodes(render())) =>
  tree.find((node) => node.type === "button" && node.props.children === label);
function menu() {
  const entry = nodes(render()).find(
    (node) => node.props["aria-label"] === LIBRARY.actions("父对话"),
  )!;
  (entry.props.onClick as () => void)();
  return nodes(render());
}
function dialog() {
  return nodes(render()).find((node) => node.type === SessionForkDialog);
}
function openReview() {
  const tree = menu();
  (button(S.title, tree)!.props.onClick as () => void)();
  return dialog()!;
}
beforeEach(() => {
  h.slots = [];
  active = true;
  opened.mockReset();
  h.thread = {
    key: "parent",
    connectionId: "connection-a",
    agentId: "agent-a",
    cwd: "/work",
    nativeSessionId: "native-parent",
    title: "父对话",
    items: [],
    activeToolCallIds: [],
    pendingPermissions: [],
    pendingElicitations: [],
    queued: [],
    identity: "established",
  } as unknown as ThreadState;
  h.control = {
    owner: {},
    phase: "idle",
    isCurrent: () => true,
    start: vi.fn(),
  };
});

it("has no copy entry without the current official capability descriptor", () => {
  h.control = null;
  expect(button(S.title, menu())).toBeUndefined();
  expect(dialog()).toBeUndefined();
});

function pointAction() {
  const view = nodes(render()).find((node) => node.type === ThreadView)!;
  return view.props.onForkFromMessage as (
    item: ThreadState["items"][number],
  ) => void;
}
it("opens a message point review without dispatch and retires it on navigation", () => {
  h.thread!.sessionOperations = {
    forkCurrentContext: true,
    forkHistoricalPoint: true,
  };
  const item: ThreadState["items"][number] = {
    kind: "agent",
    id: "local",
    messageId: "official",
    text: "Earlier",
    streaming: false,
    time: 0,
    historyForkPoint: { connectionId: "connection-a", messageId: "official" },
  };
  h.thread!.items.push(item);
  const start = h.control!.start;
  const select = pointAction();
  select(item);
  expect(dialog()).toBeDefined();
  expect(start).not.toHaveBeenCalled();
  active = false;
  render();
  active = true;
  render();
  select(item);
  expect(dialog()).toBeUndefined();
  expect(start).not.toHaveBeenCalled();
});
it("does not use local message IDs or unqualified metadata as a historical point", () => {
  h.thread!.sessionOperations = {
    forkCurrentContext: true,
    forkHistoricalPoint: true,
  };
  const item: ThreadState["items"][number] = {
    kind: "agent",
    id: "local",
    messageId: "official",
    text: "Earlier",
    streaming: false,
    time: 0,
  };
  h.thread!.items.push(item);
  pointAction()(item);
  expect(dialog()).toBeUndefined();
  expect(h.control!.start).not.toHaveBeenCalled();
});

it("opens a confirmation without dispatch and suppresses underlying interaction", () => {
  const review = openReview();
  expect(review.props.control).toBe(h.control);
  expect(h.control!.start).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();
  expect(
    nodes(render()).find((node) => node.type === ThreadView)!.props.active,
  ).toBe(false);
  (review.props.onClose as () => void)();
  expect(dialog()).toBeUndefined();
  expect(h.control!.start).not.toHaveBeenCalled();
});

it("shows a truthful busy reason and rejects even a retained disabled click", () => {
  h.control = { ...h.control!, blockedReason: "当前工作尚未完成" };
  const entry = button(S.title, menu())!;
  expect(entry.props.disabled).toBe(true);
  expect(entry.props["aria-describedby"]).toBe("thread-fork-reason");
  (entry.props.onClick as () => void)();
  expect(dialog()).toBeUndefined();
});

it.each(["hidden", "owner", "connection", "thread"] as const)(
  "retires a prior confirmation across %s A to B to A",
  (change) => {
    const review = openReview();
    const firstThread = h.thread!;
    const firstControl = h.control!;
    if (change === "hidden") active = false;
    if (change === "owner") h.control = { ...firstControl, owner: {} };
    if (change === "connection") firstThread.connectionId = "connection-b";
    if (change === "thread") h.thread = { ...firstThread };
    render();
    active = true;
    h.thread = firstThread;
    firstThread.connectionId = "connection-a";
    h.control = firstControl;
    render();
    expect((review.props.isCurrent as () => boolean)()).toBe(false);
    expect(dialog()).toBeUndefined();
    expect(firstControl.start).not.toHaveBeenCalled();
  },
);

it("does not revive an old menu action after navigating away and back", () => {
  const entry = button(S.title, menu())!;
  active = false;
  render();
  active = true;
  render();
  (entry.props.onClick as () => void)();
  expect(dialog()).toBeUndefined();
});

it.each(["pending", "unknown", "created-unavailable", "ready"] as const)(
  "retains the actual %s operation for explicit inspection without restarting",
  (phase) => {
    h.control = {
      ...h.control!,
      phase,
      blockedReason: "新工作暂不可执行",
      child: { nativeSessionId: "actual-known-child" },
    };
    const entry = button(phase === "pending" ? S.progress : S.result, menu())!;
    expect(entry.props.disabled).toBe(false);
    (entry.props.onClick as () => void)();
    expect(dialog()!.props.control).toBe(h.control);
    expect(h.control.start).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  },
);

it.each(["ready", "rejected"] as const)(
  "returns %s to a fresh explicit confirmation and retires the old one",
  (phase) => {
    const nextStart = vi.fn();
    const prepare = vi.fn(() => {
      h.control = { ...h.control!, owner: {}, phase: "idle", start: nextStart };
      delete h.control.prepareNew;
    });
    h.control = { ...h.control!, phase, prepareNew: prepare };
    const previousOwner = h.control.owner;
    (button(S.result, menu())!.props.onClick as () => void)();
    const previous = dialog()!;
    const adapted = previous.props.control as SessionForkControl;
    adapted.prepareNew!();
    const next = dialog()!;
    expect(prepare).toHaveBeenCalledOnce();
    expect((next.props.control as SessionForkControl).owner).not.toBe(
      previousOwner,
    );
    expect((next.props.control as SessionForkControl).phase).toBe("idle");
    expect((previous.props.isCurrent as () => boolean)()).toBe(false);
    adapted.prepareNew!();
    expect(prepare).toHaveBeenCalledOnce();
    expect(dialog()!.props.control).toBe(next.props.control);
    expect(nextStart).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  },
);

it("does not invent a fresh confirmation unless the runtime changed the owner", () => {
  h.control = { ...h.control!, phase: "ready", prepareNew: vi.fn() };
  (button(S.result, menu())!.props.onClick as () => void)();
  const previous = dialog()!;
  (previous.props.control as SessionForkControl).prepareNew!();
  expect(h.control.prepareNew).toHaveBeenCalledOnce();
  expect(dialog()).toBeUndefined();
  expect((previous.props.isCurrent as () => boolean)()).toBe(false);
  expect(h.control.start).not.toHaveBeenCalled();
});
