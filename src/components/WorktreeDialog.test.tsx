import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; cleanup?: () => void }[],
  check: vi.fn(),
  forget: vi.fn(),
  acknowledge: vi.fn(),
  inspect: vi.fn(),
  state: {} as Record<string, unknown>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current } }).value,
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (value: unknown) => {
        slot.value = typeof value === "function" ? value(slot.value) : value;
      },
    ];
  },
  useEffect: (fn: () => void | (() => void)) => {
    const i = h.cursor++;
    if (!h.slots[i]) h.slots[i] = { cleanup: fn() || undefined };
  },
}));
vi.mock("../runtime/worktrees", () => ({
  useWorktrees: () => h.state,
  worktrees: {
    check: h.check,
    forget: h.forget,
    acknowledge: h.acknowledge,
    inspect: h.inspect,
  },
}));
vi.mock("./WorkspaceDialog", () => ({
  WorkspaceDialog: ({ children }: { children: ReactNode }) => children,
}));
import { WorktreeDialog } from "./WorktreeDialog";
import { WORKTREE_STRINGS as S } from "../runtime/worktree_strings";
import { parseWorktreeReply } from "../runtime/worktree_types";
const location = {
  id: "one",
  revision: 1,
  path: "/repo/linked",
  repositoryRoot: "/repo",
  branch: "feature",
  headOid: "a".repeat(40),
  ownership: "created",
  availability: "verified",
} as const;
let props: ComponentProps<typeof WorktreeDialog>;
type Element = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Element[] {
  const out: Element[] = [];
  Children.forEach(value, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      out.push(child, ...nodes(child.props.children as ReactNode));
  });
  return out;
}
function render() {
  h.cursor = 0;
  return WorktreeDialog(props);
}
function button(label: string, index = 0) {
  return nodes(render()).filter(
    (n) => n.type === "button" && n.props.children === label,
  )[index]!;
}
const click = (label: string, index = 0) =>
  (button(label, index).props.onClick as () => void)();
async function settle() {
  for (let n = 0; n < 8; n++) await Promise.resolve();
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.check.mockReset().mockResolvedValue(location);
  h.forget.mockReset().mockResolvedValue(undefined);
  h.acknowledge.mockReset().mockResolvedValue(undefined);
  h.inspect.mockReset();
  h.state = {
    locations: [location],
    materials: [],
    ready: true,
    loading: false,
    working: false,
    uncertain: false,
    error: null,
    operationId: null,
    operation: null,
  };
  props = {
    cwd: "/repo",
    target: { isCurrent: () => true, apply: vi.fn().mockResolvedValue(true) },
    onClose: vi.fn(),
  };
});
afterEach(() => h.slots.forEach((s) => s.cleanup?.()));
it("never applies a listed result until an explicit use passes fresh verification", async () => {
  render();
  expect(h.check).not.toHaveBeenCalled();
  expect(props.target.apply).not.toHaveBeenCalled();
  click(S.use);
  await settle();
  expect(h.check).toHaveBeenCalledExactlyOnceWith(location);
  expect(props.target.apply).toHaveBeenCalledExactlyOnceWith(location.path);
  expect(props.onClose).toHaveBeenCalledOnce();
});
it("a late location check cannot apply after its original draft departs", async () => {
  let done!: (v: typeof location) => void;
  let current = true;
  props.target = { isCurrent: () => current, apply: vi.fn() };
  h.check.mockReturnValueOnce(
    new Promise((r) => {
      done = r;
    }),
  );
  click(S.use);
  current = false;
  done(location);
  await settle();
  expect(props.target.apply).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(renderToStaticMarkup(render())).toContain(S.changed);
});
it("a departed dialog does not close a replacement dialog after applying", async () => {
  let done!: (v: boolean) => void;
  props.target = {
    isCurrent: () => true,
    apply: vi.fn(
      () =>
        new Promise<boolean>((r) => {
          done = r;
        }),
    ),
  };
  click(S.use);
  await settle();
  props.target = { isCurrent: () => true, apply: vi.fn() };
  render();
  done(true);
  await settle();
  expect(props.onClose).not.toHaveBeenCalled();
});
it("forgets only after a second explicit choice and never restores it from the old operation", async () => {
  h.state.operationId = "operation";
  h.state.operation = {
    kind: "operation",
    state: "ready",
    settled: true,
    location,
  };
  click(S.forget);
  expect(h.forget).not.toHaveBeenCalled();
  click(S.forget, 1);
  await settle();
  expect(h.forget).toHaveBeenCalledExactlyOnceWith(location);
  h.state.locations = [];
  expect(
    nodes(render()).filter(
      (n) => n.type === "button" && n.props.children === S.use,
    ),
  ).toHaveLength(0);
});
it("shows unknown operation recovery and keeps the ordinary-folder fallback", () => {
  h.state.operationId = "lost";
  h.state.operation = { kind: "unknownOperation", operationId: "lost" };
  h.state.uncertain = true;
  const html = renderToStaticMarkup(render());
  expect(html).toContain(S.unknownId);
  expect(html).toContain(S.unknown);
  expect(button(S.ordinary).props.disabled).toBe(false);
  expect(button(S.inspect).props.disabled).toBe(true);
  expect(button(S.check).props.disabled).toBe(false);
});
it("shows the confirmed reason for a rejected creation without presenting success", () => {
  h.state.operationId = "rejected";
  h.state.operation = {
    kind: "operation",
    state: "failed",
    settled: true,
    code: "targetExists",
  };
  const html = renderToStaticMarkup(render());
  expect(html).toContain(S.errors.targetExists);
  expect(html).toContain(S.states.failed);
  expect(html).not.toContain(S.states.ready);
});
it("preserves unknown after a cancellation left material instead of claiming no creation began", () => {
  h.state.operationId = "cancelled-after-mkdir";
  h.state.operation = parseWorktreeReply({
    kind: "operation",
    operationId: "cancelled-after-mkdir",
    state: "unknown",
    settled: true,
    cancelRequested: true,
    code: "cancelled",
    targetPath: "/repo/possibly-created",
  });
  h.state.uncertain = true;
  const html = renderToStaticMarkup(render());
  expect(html).toContain(S.states.unknown);
  expect(html).toContain(S.unknown);
  expect(html).toContain("/repo/possibly-created");
  expect(html).not.toContain("未开始创建");
  expect(html).not.toContain(S.errors.cancelled);
  expect(button(S.inspect).props.disabled).toBe(true);
});
it("only a confirmed pre-creation cancellation describes creation as not started", () => {
  h.state.operationId = "cancel-before-start";
  h.state.operation = parseWorktreeReply({
    kind: "operation",
    operationId: "cancel-before-start",
    state: "cancelled",
    settled: true,
    cancelRequested: true,
    code: "cancelled",
  });
  const html = renderToStaticMarkup(render());
  expect(html).toContain(S.states.cancelled);
  expect(html).toContain(S.errors.cancelled);
  expect(html).not.toContain(S.states.unknown);
});
it("requires explicit review of unknown materials and never presents them as usable", async () => {
  h.state.operationId = "unknown";
  h.state.operation = {
    kind: "operation",
    operationId: "unknown",
    state: "unknown",
    settled: true,
    targetPath: "/possible",
  };
  h.state.uncertain = true;
  click(S.review);
  expect(h.acknowledge).not.toHaveBeenCalled();
  expect(renderToStaticMarkup(render())).toContain(S.reviewNote);
  click(S.confirmReview);
  await settle();
  expect(h.acknowledge).toHaveBeenCalledExactlyOnceWith("unknown");
  h.state.locations = [];
  h.state.materials = [
    { operationId: "unknown", path: "/possible", repositoryRoot: "/repo" },
  ];
  expect(
    nodes(render()).some(
      (n) => n.type === "button" && n.props.children === S.use,
    ),
  ).toBe(false);
});
it("displays a fixed mapped failure from a fresh location check", async () => {
  h.check.mockRejectedValueOnce(new Error(S.errors.inspectionExpired));
  click(S.use);
  await settle();
  expect(renderToStaticMarkup(render())).toContain(S.errors.inspectionExpired);
  expect(props.target.apply).not.toHaveBeenCalled();
});
it("lets an unknown target be inspected through its canonical repository, without applying it", async () => {
  h.state.locations = [];
  h.state.materials = [
    { operationId: "lost", path: "/trees/target", repositoryRoot: "/repo" },
  ];
  const result = {
    inspectionId: "new-check",
    root: "/trees/target",
    repositoryRoot: "/repo",
    kind: "linked",
    head: { oid: "a".repeat(40), branch: "refs/heads/x" },
    trees: [{ path: "/trees/target", branch: "refs/heads/x", locked: false }],
    blockers: [],
  };
  h.inspect.mockResolvedValue(result);
  click(S.check);
  await settle();
  expect(h.inspect).toHaveBeenCalledExactlyOnceWith("/trees/target");
  expect(
    nodes(render()).find((n) => n.props.inspection)?.props.inspection,
  ).toEqual(result);
  expect(props.target.apply).not.toHaveBeenCalled();
});
it.each([
  {
    root: "/trees/target",
    repositoryRoot: "/another",
    trees: [{ path: "/trees/target", branch: null, locked: false }],
  },
  {
    root: "/another-target",
    repositoryRoot: "/repo",
    trees: [{ path: "/trees/target", branch: null, locked: false }],
  },
  { root: "/trees/target", repositoryRoot: "/repo", trees: [] },
])(
  "rejects a material inspected under another repository, target or registration: %j",
  async (mismatch) => {
    h.state.locations = [];
    h.state.materials = [
      { operationId: "lost", path: "/trees/target", repositoryRoot: "/repo" },
    ];
    h.inspect.mockResolvedValue({
      inspectionId: "other",
      ...mismatch,
      kind: "linked",
      head: { oid: "a".repeat(40), branch: null },
      blockers: [],
    });
    click(S.check);
    await settle();
    expect(nodes(render()).some((n) => n.props.inspection)).toBe(false);
    expect(props.target.apply).not.toHaveBeenCalled();
  },
);
