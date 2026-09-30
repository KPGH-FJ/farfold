import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { expect, it, vi } from "vitest";
import { MoveConversationsDialog } from "./MoveConversationsDialog";
import { LIBRARY } from "../runtime/library_strings";

it("offers ungrouped and saved groups as actions, preserving their actual IDs", () => {
  const onMove = vi.fn();
  const tree = MoveConversationsDialog({
    count: 2,
    groups: [{ id: "actual-id", name: "研究" }],
    busy: false,
    error: null,
    onMove,
    onClose: vi.fn(),
  });
  const buttons: ReactElement<{ children?: ReactNode; onClick: () => void }>[] =
    [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<{ children?: ReactNode; onClick: () => void }>(child))
        return;
      if (child.type === "button") buttons.push(child);
      visit(child.props.children);
    });
  visit(tree);
  expect(tree.props.title).toBe(LIBRARY.moveTitle(2));
  expect(buttons.map((button) => button.props.children)).toEqual([
    LIBRARY.withoutGroup,
    "研究",
  ]);
  expect(onMove).not.toHaveBeenCalled();
  buttons[1].props.onClick();
  expect(onMove).toHaveBeenLastCalledWith("actual-id");
  buttons[0].props.onClick();
  expect(onMove).toHaveBeenLastCalledWith("");
});
