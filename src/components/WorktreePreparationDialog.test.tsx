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
  slots: [] as { value?: unknown; cleanup?: () => void }[],
  load: vi.fn(),
  check: vi.fn(),
  inspect: vi.fn(),
  validate: vi.fn(),
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
vi.mock("./WorkspaceDialog", () => ({
  WorkspaceDialog: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../runtime/worktrees", () => ({
  worktrees: { load: h.load, check: h.check, snapshot: () => h.state },
}));
vi.mock("../runtime/worktree_preparation", () => ({
  inspectWorktreePreparation: h.inspect,
  validateWorktreePreparation: h.validate,
}));
import { WorktreePreparationDialog } from "./WorktreePreparationDialog";
import { WORKTREE_PREPARATION_STRINGS as S } from "../runtime/worktree_preparation_strings";
import { WORKTREE_STRINGS } from "../runtime/worktree_strings";
import {
  preparationLocation as location,
  preparationWire,
} from "../runtime/worktree_preparation.test-fixtures";
import { parsePreparationInspection } from "../runtime/worktree_preparation_types";
let props: ComponentProps<typeof WorktreePreparationDialog>;
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  const all: Node[] = [];
  Children.forEach(value, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      all.push(child, ...nodes(child.props.children as ReactNode));
  });
  return all;
}
function render() {
  h.cursor = 0;
  return WorktreePreparationDialog(props);
}
function button(label: string) {
  return nodes(render()).find(
    (n) => n.type === "button" && n.props.children === label,
  )!;
}
function click(label: string) {
  (button(label).props.onClick as () => void)();
}
function field(label: string, type = "input") {
  const wrapper = nodes(render()).find(
    (n) =>
      n.type === "label" &&
      Children.toArray(n.props.children as ReactNode)[0] === label,
  )!;
  return nodes(wrapper.props.children as ReactNode).find(
    (n) => n.type === type,
  )!;
}
function change(label: string, value: string, type = "input") {
  (
    field(label, type).props.onChange as (e: {
      target: { value: string };
    }) => void
  )({ target: { value } });
  render();
}
async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.load.mockReset().mockResolvedValue(undefined);
  h.check.mockReset().mockResolvedValue(location);
  h.inspect
    .mockReset()
    .mockResolvedValue(
      parsePreparationInspection(preparationWire(), location, ""),
    );
  h.validate.mockReset().mockResolvedValue(undefined);
  h.state = {
    ready: true,
    loading: false,
    error: null,
    locations: [location],
    archives: [],
  };
  props = {
    target: {
      owner: {},
      cwd: location.path,
      isCurrent: () => true,
      retire: vi.fn(),
      appendOnce: vi.fn(async (_text, validate) => {
        await validate();
        return "added-saved" as const;
      }),
      retrySave: vi.fn().mockResolvedValue("saved"),
    },
    onClose: vi.fn(),
    returnFocusRef: { current: null },
  };
});
afterEach(() => h.slots.forEach((s) => s.cleanup?.()));
it("mount reads nothing; checking and reviewing cannot append until a separate explicit action", async () => {
  render();
  expect(h.load).not.toHaveBeenCalled();
  expect(h.inspect).not.toHaveBeenCalled();
  change(S.task, "运行项目测试", "textarea");
  click(S.inspect);
  await settle();
  expect(h.check).toHaveBeenCalledExactlyOnceWith(location);
  expect(h.inspect).toHaveBeenCalledExactlyOnceWith(location, "");
  expect(props.target.appendOnce).not.toHaveBeenCalled();
  expect(h.validate).not.toHaveBeenCalled();
  expect(button(S.add).props.disabled).toBe(false);
  click(S.add);
  await settle();
  expect(h.validate).toHaveBeenCalledOnce();
  expect(props.target.appendOnce).toHaveBeenCalledOnce();
  expect(nodes(render()).some((n) => n.props.children === S.added)).toBe(true);
  expect(props.onClose).not.toHaveBeenCalled();
});
it("ordinary folders can review an explicitly unchecked request without auto-adopting or probing", async () => {
  h.state.locations = [];
  change(S.task, "运行现有测试", "textarea");
  click(S.inspect);
  await settle();
  expect(
    nodes(render()).some((n) => n.props.children === S.notRegistered),
  ).toBe(true);
  expect(h.check).not.toHaveBeenCalled();
  expect(h.inspect).not.toHaveBeenCalled();
  click(S.manual);
  await settle();
  click(S.add);
  await settle();
  const call = vi.mocked(props.target.appendOnce).mock.calls[0];
  expect(call[0]).toContain(S.manualBoundary);
  expect(h.validate).not.toHaveBeenCalled();
});
it("a pending check has a working close control and its late result cannot append or close a later owner", async () => {
  let resolve!: (value: ReturnType<typeof parsePreparationInspection>) => void;
  h.inspect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  change(S.task, "测试", "textarea");
  click(S.inspect);
  await settle();
  expect(button(S.close).props.disabled).not.toBe(true);
  click(S.close);
  resolve(parsePreparationInspection(preparationWire(), location, ""));
  await settle();
  expect(props.target.retire).toHaveBeenCalledOnce();
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.target.appendOnce).not.toHaveBeenCalled();
  expect(button(S.add).props.disabled).toBe(true);
});
it("failed or expired validation preserves the draft and permits a new explicit inspection", async () => {
  change(S.task, "测试", "textarea");
  click(S.inspect);
  await settle();
  h.validate.mockRejectedValueOnce({
    code: "inspectionExpired",
    raw: "private",
  });
  click(S.add);
  await settle();
  expect(
    nodes(render()).some(
      (n) => n.props.children === S.errors.inspectionExpired,
    ),
  ).toBe(true);
  expect(nodes(render()).some((n) => n.props.children === "private")).toBe(
    false,
  );
  expect(button(S.inspect).props.disabled).toBe(false);
  expect(h.inspect).toHaveBeenCalledOnce();
});
it("edits invalidate the displayed request, and no form default Enter can skip review", async () => {
  change(S.task, "测试", "textarea");
  click(S.manual);
  await settle();
  expect(button(S.add).props.disabled).toBe(false);
  change(S.task, "新的任务", "textarea");
  expect(button(S.add).props.disabled).toBe(true);
  expect(nodes(render()).filter((n) => n.type === "form")).toHaveLength(0);
  expect(
    nodes(render())
      .filter((n) => n.type === "button")
      .every((n) => n.props.type === "button"),
  ).toBe(true);
  expect(props.target.appendOnce).not.toHaveBeenCalled();
});
it("save retry does not inspect, validate or append again", async () => {
  vi.mocked(props.target.appendOnce).mockResolvedValueOnce("added-unsaved");
  change(S.task, "测试", "textarea");
  click(S.manual);
  await settle();
  click(S.add);
  await settle();
  click(S.retrySave);
  await settle();
  expect(props.target.retrySave).toHaveBeenCalledOnce();
  expect(props.target.appendOnce).toHaveBeenCalledOnce();
  expect(h.inspect).not.toHaveBeenCalled();
  expect(nodes(render()).some((n) => n.props.children === S.added)).toBe(true);
});
it("a fresh location check failure retains its safe explanation and cannot inspect or append", async () => {
  h.check.mockRejectedValueOnce(new Error(WORKTREE_STRINGS.errors.changed));
  change(S.task, "测试", "textarea");
  click(S.inspect);
  await settle();
  expect(
    nodes(render()).some(
      (n) => n.props.children === WORKTREE_STRINGS.errors.changed,
    ),
  ).toBe(true);
  expect(h.inspect).not.toHaveBeenCalled();
  expect(props.target.appendOnce).not.toHaveBeenCalled();
});

it("a refused save retry explains the changed draft and removes the ineffective retry action", async () => {
  vi.mocked(props.target.appendOnce).mockResolvedValueOnce("added-unsaved");
  vi.mocked(props.target.retrySave).mockResolvedValueOnce("stale");
  change(S.task, "测试", "textarea");
  click(S.manual);
  await settle();
  click(S.add);
  await settle();
  click(S.retrySave);
  await settle();
  expect(
    nodes(render()).some(
      (n) =>
        n.props.children ===
        "内容已加入，但原草稿或当前选择已变化，无法在此重试保存。请关闭后在输入框确认并保存。",
    ),
  ).toBe(true);
  expect(button(S.retrySave)).toBeUndefined();
  expect(button(S.close).props.disabled).not.toBe(true);
  expect(props.target.appendOnce).toHaveBeenCalledOnce();
  expect(props.target.retrySave).toHaveBeenCalledOnce();
  expect(h.inspect).not.toHaveBeenCalled();
});

it("repeatable storage failure retains save retry without validating or adding a second time", async () => {
  vi.mocked(props.target.appendOnce).mockResolvedValueOnce("added-unsaved");
  vi.mocked(props.target.retrySave).mockResolvedValueOnce("unsaved");
  change(S.task, "测试", "textarea");
  click(S.manual);
  await settle();
  click(S.add);
  await settle();
  click(S.retrySave);
  await settle();
  expect(nodes(render()).some((n) => n.props.children === S.unsaved)).toBe(
    true,
  );
  expect(button(S.retrySave).props.disabled).toBe(false);
  expect(props.target.appendOnce).toHaveBeenCalledOnce();
  expect(h.inspect).not.toHaveBeenCalled();
});
