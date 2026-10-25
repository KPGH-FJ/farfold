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
import { WorkspaceAccessDecisionReview } from "./WorkspaceAccessDecisionReview";
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

it("offers explicit trust actions only after a capable owner reports the actual choices", async () => {
  const thread = state();
  thread.workspaceAccess = {
    ...thread.workspaceAccess!,
    decisionManagement: true,
  } as never;
  h.invoke.mockResolvedValue({
    ...answer,
    status: "untrusted",
    details: {
      cwd: "/owned",
      repoRoot: "/",
      repoScopeVerified: true,
      offeredDecisions: ["trust_cwd", "trust_repo", "decline"],
    },
  });
  (
    draw(thread).find((n) => n.props["aria-label"] === S.entry)!.props
      .onClick as () => void
  )();
  await flush();
  const dialog = draw(thread).find((n) => n.type === WorkspaceDialog)!;
  const html = renderToStaticMarkup(<>{dialog.props.children as ReactNode}</>);
  expect(html).toContain("信任此文件夹");
  expect(html).toContain("信任此项目范围");
  expect(html).toContain("设为不信任");
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.invoke.mock.calls[0][0]).toBe("session_workspace_access_status");
});

it.each([null, []])(
  "does not invent a trust action when reported choices are %j",
  async (offeredDecisions) => {
    const thread = state();
    thread.workspaceAccess = {
      ...thread.workspaceAccess!,
      decisionManagement: true,
    } as never;
    h.invoke.mockResolvedValue({
      ...answer,
      details: {
        cwd: "/owned",
        repoRoot: null,
        repoScopeVerified: false,
        offeredDecisions,
      },
    });
    (
      draw(thread).find((n) => n.props["aria-label"] === S.entry)!.props
        .onClick as () => void
    )();
    await flush();
    const dialog = draw(thread).find((n) => n.type === WorkspaceDialog)!;
    expect(
      nodes(dialog.props.children as ReactNode).filter(
        (n) => n.type === "button",
      ),
    ).toHaveLength(1);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);

it("stages a review without writing, then dispatches one confirmed store operation that survives dialog dismissal", async () => {
  const thread = state();
  thread.workspaceAccess = {
    ...thread.workspaceAccess!,
    decisionManagement: true,
  };
  const details = {
    cwd: "/owned",
    repoRoot: "/",
    repoScopeVerified: true,
    offeredDecisions: ["trust_cwd", "trust_repo", "decline"],
  };
  const result = { ...answer, status: "untrusted", details };
  let resolve!: (value: unknown) => void;
  h.invoke.mockImplementation((command) => {
    if (command === "session_workspace_access_status")
      return Promise.resolve(result);
    if (command === "session_workspace_access_decide")
      return new Promise((done) => {
        resolve = done;
      });
    throw new Error("unexpected command");
  });
  (
    draw(thread).find((n) => n.props["aria-label"] === S.entry)!.props
      .onClick as () => void
  )();
  await flush();
  let all = draw(thread);
  const choose = all.find(
    (node) =>
      node.type === "button" && node.props.children === S.decisions.trust_cwd,
  )!;
  (choose.props.onClick as () => void)();
  all = draw(thread);
  const review = all.find(
    (node) => node.type === WorkspaceAccessDecisionReview,
  )!;
  expect(review.props.snapshot).toMatchObject({
    phase: "review",
    decision: "trust_cwd",
    scope: details,
  });
  expect(h.invoke).toHaveBeenCalledTimes(1);
  (review.props.onConfirm as () => void)();
  (review.props.onConfirm as () => void)();
  expect(thread.configuring).toBe(true);
  const dialog = draw(thread).find((node) => node.type === WorkspaceDialog)!;
  expect(dialog.props.busy).toBe(true);
  (dialog.props.onClose as () => void)();
  expect(thread.configuring).toBe(true);
  expect(draw(thread).some((node) => node.type === WorkspaceDialog)).toBe(
    false,
  );
  resolve({ ...result, status: "trusted" });
  await vi.waitFor(() => expect(thread.configuring).toBe(false));
  expect(draw(thread).some((node) => node.type === WorkspaceDialog)).toBe(
    false,
  );
  expect(h.invoke).toHaveBeenCalledTimes(2);
  expect(h.invoke.mock.calls[1]).toEqual([
    "session_workspace_access_decide",
    {
      agentId: "fixture",
      cwd: "/owned",
      sessionId: "native",
      connectionId: "connection",
      decision: "trust_cwd",
      expectedScope: details,
    },
  ]);
});

it("keeps actual offers read-only when decision capability was not declared", async () => {
  const thread = state();
  h.invoke.mockResolvedValue({
    ...answer,
    details: {
      cwd: "/owned",
      repoRoot: "/",
      repoScopeVerified: true,
      offeredDecisions: ["trust_cwd", "trust_repo", "decline"],
    },
  });
  (
    draw(thread).find((n) => n.props["aria-label"] === S.entry)!.props
      .onClick as () => void
  )();
  await flush();
  const dialog = draw(thread).find((node) => node.type === WorkspaceDialog)!;
  const html = renderToStaticMarkup(<>{dialog.props.children as ReactNode}</>);
  expect(html).not.toContain(S.decisions.trust_cwd);
  expect(html).not.toContain(S.decisions.trust_repo);
  expect(html).not.toContain(S.decisions.decline);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("shows a fixed unconfirmed write notice, never a raw error or a trusted result", async () => {
  const thread = state();
  thread.workspaceAccess = {
    ...thread.workspaceAccess!,
    decisionManagement: true,
  };
  h.invoke.mockResolvedValueOnce({
    ...answer,
    details: {
      cwd: "/owned",
      repoRoot: null,
      repoScopeVerified: false,
      offeredDecisions: ["trust_cwd"],
    },
  });
  (
    draw(thread).find((node) => node.props["aria-label"] === S.entry)!.props
      .onClick as () => void
  )();
  await flush();
  (
    draw(thread).find(
      (node) =>
        node.type === "button" && node.props.children === S.decisions.trust_cwd,
    )!.props.onClick as () => void
  )();
  h.invoke.mockRejectedValueOnce({
    code: "timeout",
    message: "PRIVATE_WRITE_ERROR",
  });
  const review = draw(thread).find(
    (node) => node.type === WorkspaceAccessDecisionReview,
  )!;
  (review.props.onConfirm as () => void)();
  await vi.waitFor(() =>
    expect(thread.configError).toBe(S.decisionUnconfirmed),
  );
  await flush();
  const dialog = draw(thread).find((node) => node.type === WorkspaceDialog)!;
  const html = renderToStaticMarkup(<>{dialog.props.children as ReactNode}</>);
  expect(html).toContain(S.decisionUnconfirmed);
  expect(html).not.toContain("PRIVATE_WRITE_ERROR");
  expect(html).not.toContain(S.statuses.trusted);
  expect(html).not.toContain(S.readOnly);
  expect(thread.connectionOutcomeUnknown).toBe(false);
  expect(h.invoke).toHaveBeenCalledTimes(2);
});
