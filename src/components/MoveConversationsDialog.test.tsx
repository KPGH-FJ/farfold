import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { MoveConversationsDialog } from "./MoveConversationsDialog";
import { LIBRARY } from "../runtime/library_strings";
import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";
const h = vi.hoisted(() => ({ destination: null as string | null }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [
    h.destination,
    (next: string) => {
      h.destination = next;
    },
  ],
}));
type Element = ReactElement<Record<string, unknown>>;
const onMove = vi.fn();
function render(
  groupId = "old-group",
  groups = [{ id: "actual-id", name: "研究" }],
) {
  const tree = MoveConversationsDialog({
    count: 1,
    rows: [{ title: "具体对话", groupId }],
    groups,
    busy: false,
    error: null,
    onMove,
    onClose: vi.fn(),
  });
  const elements: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return elements;
}
function button(
  label: string,
  groupId?: string,
  groups?: { id: string; name: string }[],
) {
  return render(groupId, groups).find(
    (node) => node.type === "button" && node.props.children === label,
  )!;
}
function click(node: Element) {
  (node.props.onClick as () => void)();
}
beforeEach(() => {
  h.destination = null;
  onMove.mockReset();
});
it("selects the actual destination without moving until explicit confirmation", () => {
  expect(button(R.moveConfirm).props.disabled).toBe(true);
  click(button("研究"));
  expect(onMove).not.toHaveBeenCalled();
  expect(button("研究").props["aria-pressed"]).toBe(true);
  click(button(R.moveConfirm));
  expect(onMove).toHaveBeenCalledExactlyOnceWith("actual-id");
});
it("supports ungrouped while preventing unchanged and removed destinations", () => {
  click(button(LIBRARY.withoutGroup));
  expect(button(R.moveConfirm, "").props.disabled).toBe(true);
  click(button(R.moveConfirm, ""));
  expect(onMove).not.toHaveBeenCalled();
  click(button(R.moveConfirm));
  expect(onMove).toHaveBeenCalledExactlyOnceWith("");
  click(button("研究"));
  expect(button(R.moveConfirm, "", []).props.disabled).toBe(true);
  click(button(R.moveConfirm, "", []));
  expect(onMove).toHaveBeenCalledTimes(1);
});
