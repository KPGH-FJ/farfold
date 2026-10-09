import { beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  cursor: 0,
  ref: 0,
  pick: vi.fn(),
  write: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (i >= h.states.length) h.states.push(initial);
    return [
      h.states[i],
      (v: unknown) =>
        (h.states[i] = typeof v === "function" ? v(h.states[i]) : v),
    ];
  },
  useRef: (current: unknown) => (h.refs[h.ref++] ??= { current }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: h.pick }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: { exportText: h.write },
}));
import { ConversationExportDialog } from "./ConversationExportDialog";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
const close = vi.fn();
let text = "最初已载入的内容";
function render() {
  h.cursor = 0;
  h.ref = 0;
  return ConversationExportDialog({
    text,
    name: "conversation.md",
    onClose: close,
    returnFocusRef: { current: null },
  });
}
function nodes(
  node: ReactNode = render(),
): { type: unknown; props: Record<string, unknown> }[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [
          { type: child.type, props: child.props },
          ...nodes(child.props.children as ReactNode),
        ]
      : [],
  );
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const visible = (value: string) =>
  nodes().some((n) => n.props.children === value);
function save() {
  (
    nodes().find((n) => n.props.children === R.exportSave)!.props
      .onClick as () => void
  )();
}
beforeEach(() => {
  h.states = [];
  h.refs = [];
  h.pick.mockReset();
  h.write.mockReset();
  close.mockReset();
  text = "最初已载入的内容";
});

it.each(["pickerFailure", "writeFailure", "cancel"] as const)(
  "a second %s cannot leave the previous success presented as this attempt's receipt",
  async (outcome) => {
    h.pick.mockResolvedValueOnce("/first.md");
    h.write.mockResolvedValueOnce(undefined);
    save();
    await flush();
    expect(visible(R.exportSaved)).toBe(true);
    if (outcome === "pickerFailure")
      h.pick.mockRejectedValueOnce(new Error("PICKER_SECRET"));
    else
      h.pick.mockResolvedValueOnce(outcome === "cancel" ? null : "/second.md");
    if (outcome === "writeFailure")
      h.write.mockRejectedValueOnce(new Error("WRITE_SECRET"));
    save();
    await flush();
    expect(visible(R.exportSaved)).toBe(false);
    expect(visible("/first.md")).toBe(false);
    expect(nodes().filter((n) => n.props.role === "status")).toHaveLength(1);
    expect(visible("PICKER_SECRET")).toBe(false);
    expect(visible("WRITE_SECRET")).toBe(false);
    expect(h.write).toHaveBeenCalledTimes(outcome === "writeFailure" ? 2 : 1);
  },
);
it("clears an old success as soon as the next location picker opens", async () => {
  h.pick.mockResolvedValueOnce("/first.md");
  h.write.mockResolvedValueOnce(undefined);
  save();
  await flush();
  h.pick.mockReturnValueOnce(new Promise(() => {}));
  save();
  expect(visible("/first.md")).toBe(false);
  expect(visible(R.exportSaved)).toBe(false);
  expect(visible(R.exportSaving)).toBe(true);
});
it("keeps one in-flight write, blocks close and preserves the chosen snapshot while events continue", async () => {
  let resolvePicker: (path: string) => void = () => {};
  let resolveWrite: () => void = () => {};
  h.pick.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      resolvePicker = resolve;
    }),
  );
  h.write.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }),
  );
  const first = nodes();
  const click = first.find((n) => n.props.children === R.exportSave)!.props
    .onClick as () => void;
  click();
  click();
  expect(h.pick).toHaveBeenCalledOnce();
  text = "后续新消息";
  render();
  resolvePicker("/snapshot.md");
  await flush();
  expect(h.write).toHaveBeenCalledWith("最初已载入的内容", "/snapshot.md");
  (
    nodes().find((n) => n.type === WorkspaceDialog)!.props.onClose as () => void
  )();
  expect(close).not.toHaveBeenCalled();
  resolveWrite();
  await flush();
  expect(visible(R.exportSaved)).toBe(true);
});

it("shows the exact included and excluded content categories before saving", () => {
  const text = nodes()
    .filter((n) => n.type === "p")
    .map((n) => n.props.children)
    .join(" ");
  for (const category of [
    "用户与助手消息",
    "附件说明",
    "工具摘要",
    "报告位置",
    "计划",
    "批准或拒绝记录",
    "不是完整对话归档",
    "思考内容",
    "一般通知",
    "上下文整理记录",
    "原始事件",
    "折叠的工具详情",
    "未载入的历史",
  ])
    expect(text).toContain(category);
  expect(h.pick).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
});

it("keeps the default explanation short and the full scope accessible in closed native details", () => {
  const view = nodes();
  const details = view.find((node) => node.type === "details");
  expect(details).toBeDefined();
  expect(details!.props.open).not.toBe(true);
  expect(
    nodes(details!.props.children as ReactNode).find(
      (node) => node.type === "summary",
    )?.props.children,
  ).toBe("范围与隐私");
  const body = view.find(
    (node) => node.props.className === "conversation-export-body",
  )!;
  const primary = Children.toArray(body.props.children as ReactNode).filter(
    (node) => isValidElement(node) && node.type === "p",
  );
  expect(primary).toHaveLength(1);
  expect(
    isValidElement<Record<string, unknown>>(primary[0]) &&
      primary[0].props.children,
  ).toBe("已载入内容的 Markdown 快照，附件未打包。");
});
