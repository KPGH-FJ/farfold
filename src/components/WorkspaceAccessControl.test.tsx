import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  cleanups: [] as (() => void)[],
  invoke: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) => (h.slots[h.cursor++] ??= { current: initial }),
  useMemo: (read: () => unknown, deps: unknown[]) => {
    const index = h.cursor++;
    const previous = h.slots[index] as
      { deps: unknown[]; value: unknown } | undefined;
    if (!previous || deps.some((v, i) => previous.deps[i] !== v))
      h.slots[index] = { deps, value: read() };
    return (h.slots[index] as { value: unknown }).value;
  },
  useLayoutEffect: (setup: () => void | (() => void)) => {
    const index = h.cursor++;
    if (!h.slots[index]) {
      const cleanup = setup();
      h.slots[index] = true;
      if (cleanup) h.cleanups.push(cleanup);
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import { WorkspaceAccessControl } from "./WorkspaceAccessControl";
import { WorkspaceDialog } from "./WorkspaceDialog";
import {
  freshThreadState,
  threads,
  type ThreadState,
} from "../runtime/sessions";
import { WORKSPACE_ACCESS as S } from "../runtime/workspace_access_strings";
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  const all: Node[] = [];
  Children.forEach(value, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      all.push(child, ...nodes(child.props.children as ReactNode));
  });
  return all;
}
function draw(thread: ThreadState | null, active = true) {
  h.cursor = 0;
  return nodes(WorkspaceAccessControl({ thread, active }));
}
const state = () => {
  const thread = freshThreadState("owned", "fixture", "/owned", "native");
  thread.connectionId = "connection";
  thread.workspaceAccess = {
    statusQuery: true,
    provenance: "reviewed-official-supplement",
  };
  vi.spyOn(threads, "thread").mockImplementation((key) =>
    key === thread.key ? thread : undefined,
  );
  return thread;
};
const answer = {
  connectionId: "connection",
  nativeSessionId: "native",
  cwd: "/owned",
  status: "session",
  details: null,
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.cleanups = [];
  h.invoke.mockReset();
});
afterEach(() => {
  for (const cleanup of h.cleanups) cleanup();
  vi.restoreAllMocks();
});
it("uses one common entry for prepared and established owners without an automatic read", () => {
  const thread = state();
  expect(draw(thread).some((n) => n.props["aria-label"] === S.entry)).toBe(
    true,
  );
  thread.identity = "established";
  expect(draw(thread).some((n) => n.props["aria-label"] === S.entry)).toBe(
    true,
  );
  expect(h.invoke).not.toHaveBeenCalled();
});
it("has no fabricated entry for an empty draft or absent capability", () => {
  expect(draw(null)).toEqual([]);
  const thread = state();
  thread.workspaceAccess = null;
  expect(draw(thread)).toEqual([]);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("one explicit click reads the exact owner and shows a bounded reported status with no decision actions", async () => {
  const thread = state();
  h.invoke.mockResolvedValue(answer);
  const entry = draw(thread).find((n) => n.props["aria-label"] === S.entry)!;
  (entry.props.onClick as () => void)();
  await flush();
  const dialog = draw(thread).find((n) => n.type === WorkspaceDialog)!;
  const html = renderToStaticMarkup(<>{dialog.props.children as ReactNode}</>);
  expect(html).toContain(S.statuses.session);
  expect(html).toContain(S.temporaryScope);
  expect(html).toContain(S.noDetails);
  expect(
    nodes(dialog.props.children as ReactNode).filter(
      (n) => n.type === "button",
    ),
  ).toHaveLength(1);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    "session_workspace_access_status",
    {
      agentId: "fixture",
      cwd: "/owned",
      sessionId: "native",
      connectionId: "connection",
    },
  );
});
it("never displays raw error text or a trusted status after a rejected read", async () => {
  const thread = state();
  h.invoke.mockRejectedValue({
    code: "queryFailed",
    message: "PRIVATE_SECRET_TEXT",
  });
  (
    draw(thread).find((n) => n.props["aria-label"] === S.entry)!.props
      .onClick as () => void
  )();
  await flush();
  const dialog = draw(thread).find((n) => n.type === WorkspaceDialog)!;
  const html = renderToStaticMarkup(<>{dialog.props.children as ReactNode}</>);
  expect(html).toContain(S.errors.queryFailed);
  expect(html).not.toContain("PRIVATE_SECRET_TEXT");
  expect(html).not.toContain(S.statuses.trusted);
});
it("retires the focus-return guard on navigation/unmount even while the registry keeps the old owner", async () => {
  const thread = state();
  let resolve!: (v: unknown) => void;
  h.invoke.mockReturnValue(new Promise((done) => (resolve = done)));
  (
    draw(thread).find((n) => n.props["aria-label"] === S.entry)!.props
      .onClick as () => void
  )();
  const dialog = draw(thread).find((n) => n.type === WorkspaceDialog)!;
  const shouldReturnFocus = dialog.props.returnFocusWhen as () => boolean;
  expect(shouldReturnFocus()).toBe(true);
  for (const cleanup of h.cleanups) cleanup();
  expect(threads.thread(thread.key)).toBe(thread);
  expect(shouldReturnFocus()).toBe(false);
  resolve(answer);
  await flush();
  expect(shouldReturnFocus()).toBe(false);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
it("drops a cross-connection result and never transfers focus permission to the replacement", async () => {
  const thread = state();
  let resolve!: (v: unknown) => void;
  h.invoke.mockReturnValue(new Promise((done) => (resolve = done)));
  (
    draw(thread).find((n) => n.props["aria-label"] === S.entry)!.props
      .onClick as () => void
  )();
  const oldDialog = draw(thread).find((n) => n.type === WorkspaceDialog)!;
  thread.connectionId = "replacement";
  expect(draw(thread).some((n) => n.type === WorkspaceDialog)).toBe(false);
  resolve(answer);
  await flush();
  expect(draw(thread).some((n) => n.type === WorkspaceDialog)).toBe(false);
  expect((oldDialog.props.returnFocusWhen as () => boolean)()).toBe(false);
});
