import { afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown }[],
  cursor: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value:
        typeof initial === "function" ? (initial as () => unknown)() : initial,
    });
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
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
}));
import { UserMessageActions } from "./UserMessageActions";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";
import { SESSION_FORK_STRINGS as F } from "../runtime/session_fork_strings";

type Props = ComponentProps<typeof UserMessageActions>;
const render = (props: Props) => {
  h.cursor = 0;
  const elements: ReactElement<Record<string, unknown>>[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(UserMessageActions(props));
  return elements;
};
const button = (tree: ReactElement<Record<string, unknown>>[], label: string) =>
  tree.find(
    (element) =>
      element.type === "button" &&
      (element.props.children === label ||
        element.props["aria-label"] === label),
  );
const click = (element: ReactElement<Record<string, unknown>>) => {
  expect(element, "expected button to exist").toBeDefined();
  (element.props.onClick as () => void)();
};

afterEach(() => {
  h.slots.length = 0;
  vi.unstubAllGlobals();
});

it("renders nothing when no action is wired", () => {
  expect(UserMessageActions({ text: "hi" })).toBeNull();
});

it("keeps historical context branching distinct from a single-message new draft", () => {
  const review = vi.fn();
  const draft = vi.fn();
  const props = {
    text: "Selected message",
    onForkFromMessage: review,
    onNewFromMessage: draft,
  };
  click(button(render(props), T.messageActions)!);
  const tree = render(props);
  expect(button(tree, T.newFromHere)).toBeDefined();
  expect(button(tree, F.pointTitle)).toBeDefined();
  click(button(tree, F.pointTitle)!);
  expect(review).toHaveBeenCalledOnce();
  expect(draft).not.toHaveBeenCalled();
  expect(button(render(props), F.pointTitle)).toBeUndefined();
});

it("offers copy, edit-resend, send-again, and new-conversation in one menu", () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const props: Props = {
    text: "原始消息",
    onEditResend: vi.fn(),
    onSendAgain: vi.fn(),
    onNewFromMessage: vi.fn(),
  };
  let tree = render(props);
  // Only the trigger until the menu opens.
  expect(button(tree, R.editMessage)).toBeUndefined();
  click(button(tree, T.messageActions)!);
  tree = render(props);
  for (const label of [
    T.copyMessage,
    R.editMessage,
    R.prepareAgain,
    T.newFromHere,
  ])
    expect(button(tree, label), label).toBeDefined();

  click(button(tree, T.copyMessage)!);
  expect(writeText).toHaveBeenCalledWith("原始消息");
  click(button(tree, R.editMessage)!);
  expect(props.onEditResend).toHaveBeenCalledTimes(1);
  click(button(tree, R.prepareAgain)!);
  expect(props.onSendAgain).toHaveBeenCalledTimes(1);
  click(button(tree, T.newFromHere)!);
  expect(props.onNewFromMessage).toHaveBeenCalledTimes(1);
  // Choosing an action closes the menu again.
  expect(button(render(props), T.messageActions)!.props["aria-expanded"]).toBe(
    false,
  );
});

it("hides actions that are not wired and keeps the trigger disabled", () => {
  const props: Props = { text: "t", onSendAgain: vi.fn(), disabled: true };
  let tree = render(props);
  const trigger = button(tree, T.messageActions)!;
  expect(trigger.props.disabled).toBe(true);
  click(trigger);
  tree = render(props);
  expect(button(tree, T.copyMessage)).toBeUndefined();
  expect(button(tree, R.prepareAgain)).toBeUndefined();
  expect(button(tree, R.editMessage)).toBeUndefined();
  expect(button(tree, T.newFromHere)).toBeUndefined();
});
