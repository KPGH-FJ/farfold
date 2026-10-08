import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { expect, it, vi } from "vitest";
import { DeleteConversationsDialog } from "./DeleteConversationsDialog";
import { LIBRARY } from "../runtime/library_strings";

function collect(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    out.push(child);
    out.push(...collect(child.props.children as ReactNode));
  });
  return out;
}

const text = (node: ReactNode): string =>
  Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join("");

it("states the deleted scope, what stays, and the agent-side handling before confirming", () => {
  const onDelete = vi.fn();
  const onClose = vi.fn();
  const tree = collect(
    DeleteConversationsDialog({
      title: LIBRARY.deleteTitle(2),
      hint: LIBRARY.deleteHint,
      busy: false,
      error: null,
      onDelete,
      onClose,
    }),
  );
  const dialog = tree[0];
  expect(dialog.props.title).toBe("删除 2 段对话");
  const body = text(
    tree.find((node) => node.props.className === "workspace-dialog-body")?.props
      .children as ReactNode,
  );
  expect(body).toContain("从列表移除");
  expect(body).toContain("磁盘文件不受影响");
  expect(body).toContain("不可撤销");
  expect(body).toContain(LIBRARY.deleteAgentNote);
  const buttons = tree.filter((node) => node.type === "button");
  const confirm = buttons.find(
    (node) => node.props.children === LIBRARY.deleteConfirm,
  )!;
  expect(confirm.props.disabled).toBe(false);
  (confirm.props.onClick as () => void)();
  expect(onDelete).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

it("keeps the confirm disabled while busy and surfaces the failure inline", () => {
  const tree = collect(
    DeleteConversationsDialog({
      title: LIBRARY.clearArchivedTitle,
      hint: LIBRARY.clearArchivedHint(4),
      busy: true,
      error: LIBRARY.error,
      onDelete: vi.fn(),
      onClose: vi.fn(),
    }),
  );
  const confirm = tree.find(
    (node) => node.type === "button" && node.props.children === "删除",
  )!;
  expect(confirm.props.disabled).toBe(true);
  expect(
    tree.some(
      (node) =>
        node.props.role === "alert" &&
        text(node.props.children as ReactNode) === LIBRARY.error,
    ),
  ).toBe(true);
});
