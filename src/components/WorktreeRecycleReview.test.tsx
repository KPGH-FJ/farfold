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
  slots: [] as {
    value?: unknown;
    cleanup?: () => void;
    deps?: readonly unknown[];
  }[],
  inspect: vi.fn(),
  recycle: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current } }).value,
  useState: (initial: unknown) => {
    const s = (h.slots[h.cursor++] ??= { value: initial });
    return [
      s.value,
      (v: unknown) => {
        s.value = typeof v === "function" ? v(s.value) : v;
      },
    ];
  },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => {
    const i = h.cursor++,
      old = h.slots[i];
    if (!old || deps.some((v, n) => !Object.is(v, old.deps?.[n]))) {
      old?.cleanup?.();
      h.slots[i] = { deps, cleanup: fn() || undefined };
    }
  },
}));
vi.mock("../runtime/worktrees", () => ({
  worktrees: { inspectRecycle: h.inspect, recycle: h.recycle },
}));
import { WorktreeRecycleReview } from "./WorktreeRecycleReview";
import { WORKTREE_STRINGS as S } from "../runtime/worktree_strings";
const record = {
  id: "tree",
  revision: 1,
  path: "/tree",
  repositoryRoot: "/repo",
  branch: null,
  headOid: "a".repeat(40),
  ownership: "created",
  availability: "verified",
} as const;
const ticket = {
  inspectionId: "inspect",
  action: "archive",
  recordId: "tree",
  revision: 1,
  originalPath: "/tree",
  retainedPath: "/keep/tree",
  repositoryRoot: "/repo",
  headOid: record.headOid,
  branch: null,
  blockers: [],
  impact: { conversations: 2, unsent: false },
  material: { entries: 2, bytes: 15, sha256: "b".repeat(64) },
  draftBaseline: { unsentWork: null, agentSetup: null },
};
let props: ComponentProps<typeof WorktreeRecycleReview>;
function render() {
  h.cursor = 0;
  return WorktreeRecycleReview(props);
}
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      out.push(child, ...nodes(child.props.children as ReactNode));
  });
  return out;
}
function button(label: string) {
  return nodes(render()).find(
    (n) => n.type === "button" && n.props.children === label,
  )!;
}
function click(label: string) {
  (button(label).props.onClick as () => void)();
}
function ack() {
  const input = nodes(render()).find((n) => n.type === "input")!;
  (input.props.onChange as (e: unknown) => void)({
    currentTarget: { checked: true },
  });
  render();
}
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  render();
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.inspect.mockReset().mockResolvedValue(ticket);
  h.recycle.mockReset().mockResolvedValue(undefined);
  props = {
    selection: { action: "archive", record },
    current: () => true,
    onClose: vi.fn(),
  };
});
afterEach(() => h.slots.forEach((s) => s.cleanup?.()));
it("inspection is read-only and exact path confirmation needs an explicit independent acknowledgement", async () => {
  render();
  await settle();
  expect(h.inspect).toHaveBeenCalledExactlyOnceWith("archive", record);
  expect(h.recycle).not.toHaveBeenCalled();
  expect(button(S.archive).props.disabled).toBe(true);
  click(S.archive);
  expect(h.recycle).not.toHaveBeenCalled();
  ack();
  expect(button(S.archive).props.disabled).toBe(false);
  click(S.archive);
  await settle();
  expect(h.recycle.mock.calls[0][0]).toBe(ticket);
  expect(props.onClose).toHaveBeenCalledOnce();
});
it("unsent/active blockers cannot be waived and render their fixed reason", async () => {
  h.inspect.mockResolvedValue({
    ...ticket,
    blockers: ["connectionUnconfirmed"],
    impact: { conversations: 2, unsent: true },
  });
  render();
  await settle();
  expect(nodes(render()).some((n) => n.type === "input")).toBe(false);
  expect(renderToStaticMarkup(render())).toContain(
    S.errors.connectionUnconfirmed,
  );
  click(S.archive);
  expect(h.recycle).not.toHaveBeenCalled();
});
it("rechecking requires a new acknowledgement and does not apply a new ticket via an old enabled button", async () => {
  render();
  await settle();
  ack();
  const old = button(S.archive).props.onClick as () => void;
  click(S.recycleRetry);
  render();
  old();
  expect(h.recycle).not.toHaveBeenCalled();
  await settle();
  expect(button(S.archive).props.disabled).toBe(true);
});
it("late inspection and old confirmation cannot act for another management selection", async () => {
  let done!: (v: unknown) => void;
  h.inspect.mockReturnValueOnce(
    new Promise((r) => {
      done = r;
    }),
  );
  render();
  props = {
    ...props,
    selection: { action: "archive", record: { ...record, id: "other" } },
    current: () => false,
  };
  render();
  done(ticket);
  await settle();
  expect(renderToStaticMarkup(render())).not.toContain("/keep/tree");
  expect(h.recycle).not.toHaveBeenCalled();
});
it("cancel during the pending operation invalidates its owner but does not invoke a second write", async () => {
  let current = true;
  props.current = () => current;
  let done!: () => void;
  h.recycle.mockReturnValueOnce(
    new Promise<void>((r) => {
      done = r;
    }),
  );
  render();
  await settle();
  ack();
  click(S.archive);
  click(S.recycleCancel);
  current = false;
  const valid = h.recycle.mock.calls[0][1] as () => boolean;
  expect(valid()).toBe(false);
  done();
  await settle();
  expect(h.recycle).toHaveBeenCalledOnce();
});
it("a late completed call cannot close a replacement selection", async () => {
  let done!: () => void;
  h.recycle.mockReturnValueOnce(
    new Promise<void>((r) => {
      done = r;
    }),
  );
  render();
  await settle();
  ack();
  click(S.archive);
  props = {
    ...props,
    selection: { action: "archive", record: { ...record, id: "other" } },
  };
  render();
  done();
  await settle();
  expect(props.onClose).not.toHaveBeenCalled();
});
it("shows one unsent explanation when distinct blocker sources report the same reason", async () => {
  h.inspect.mockResolvedValue({
    ...ticket,
    blockers: ["unsentWork", "unsentWork"],
    impact: { conversations: 2, unsent: true },
  });
  render();
  await settle();
  const html = renderToStaticMarkup(render());
  expect(html.split(S.errors.unsentWork)).toHaveLength(2);
  expect(button(S.archive).props.disabled).toBe(true);
  expect(h.recycle).not.toHaveBeenCalled();
});
it("an occupied restore destination explains the fixed original path rather than suggesting a new name", async () => {
  props.selection = {
    action: "restore",
    record: {
      id: record.id,
      revision: 2,
      originalPath: record.path,
      retainedPath: "/keep/tree",
      repositoryRoot: record.repositoryRoot,
      branch: record.branch,
      headOid: record.headOid,
      ownership: "created",
      availability: "verified",
    },
  };
  h.inspect.mockResolvedValue({
    ...ticket,
    action: "restore",
    blockers: ["targetExists"],
  });
  render();
  await settle();
  const html = renderToStaticMarkup(render());
  expect(html).toContain(
    "原位置已有文件夹，请先处理或移走该文件夹，再重新检查。",
  );
  expect(html).not.toContain(S.errors.targetExists);
  expect(button(S.restore).props.disabled).toBe(true);
  expect(h.recycle).not.toHaveBeenCalled();
});
