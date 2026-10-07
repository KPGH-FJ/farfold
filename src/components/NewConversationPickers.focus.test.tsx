import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentCardModel } from "../runtime/agents";

const h = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
  portalTargets: [] as unknown[],
}));
vi.mock("react-dom", () => ({
  createPortal: (children: ReactNode, target: unknown) => {
    h.portalTargets.push(target);
    return children;
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [
    typeof value === "function" ? value() : value,
    vi.fn(),
  ],
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
}));
vi.mock("../runtime/credentials", () => ({
  listCredentials: vi.fn(async () => []),
  getServiceCapabilities: vi.fn(async () => ({ apiTypes: [] })),
  subscribeCredentialChanges: vi.fn(() => () => {}),
}));
import {
  NewConversationAgentDialog,
  NewConversationModelDialog,
} from "./NewConversationPickers";

type Element = ReactElement<Record<string, unknown>>;
const page = { activeElement: null as FocusTarget | null, body: {} };
const events: string[] = [];
class FocusTarget {
  isConnected = true;
  hidden = false;
  constructor(readonly name: string) {}
  closest() {
    return this.hidden ? {} : null;
  }
  getClientRects() {
    return this.isConnected && !this.hidden ? [{}] : [];
  }
  focus() {
    page.activeElement = this;
    events.push(this.name);
  }
  scrollIntoView(options: ScrollIntoViewOptions) {
    events.push(`scroll:${this.name}:${options.block}`);
  }
}
function nodes(tree: ReactNode): Element[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...nodes(child.props.children as ReactNode)]
      : [],
  );
}
function unmount() {
  for (const cleanup of h.cleanups.splice(0)) cleanup();
}
function mount(picker: Element) {
  const parentEffects = h.effects.splice(0);
  const Wrapper = picker.type as (props: Record<string, unknown>) => Element;
  const tree = Wrapper(picker.props);
  const search = new FocusTarget("search");
  const selected = new FocusTarget("selected");
  const close = new FocusTarget("close");
  const element = {
    open: false,
    showModal: () => {
      events.push("showModal");
      element.open = true;
      close.focus(); // WebKit initially picks the first dialog control.
    },
    close: () => {
      events.push("closeDialog");
      element.open = false;
      page.activeElement = null;
    },
  };
  for (const node of nodes(tree)) {
    const ref = node.props.ref as { current: unknown } | undefined;
    if (ref)
      ref.current =
        node.type === "dialog"
          ? element
          : node.type === "button"
            ? selected
            : search;
  }
  for (const effect of [...h.effects.splice(0), ...parentEffects]) {
    const cleanup = effect();
    if (cleanup) h.cleanups.push(cleanup);
  }
  return { tree, element, search, close };
}
const agent = { id: "A", name: "Agent A" } as AgentCardModel;
beforeEach(() => {
  h.effects = [];
  h.cleanups = [];
  h.portalTargets = [];
  events.length = 0;
  page.activeElement = new FocusTarget("body");
  vi.stubGlobal("document", page);
  vi.stubGlobal("HTMLElement", FocusTarget);
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

it("focuses Agent search after native showModal, then Escape returns to the actual opener", () => {
  const opener = new FocusTarget("agentTrigger");
  const onClose = vi.fn(unmount);
  const picker = NewConversationAgentDialog({
    cards: [],
    picked: null,
    prepared: () => true,
    onPick: vi.fn(),
    onPrepare: vi.fn(),
    onClose,
    returnFocusRef: { current: opener as unknown as HTMLElement },
  });
  const { tree } = mount(picker);
  expect(h.portalTargets).toEqual([page.body]);
  expect(page.activeElement?.name).toBe("search");
  expect(events).toEqual(["showModal", "close", "search"]);
  const preventDefault = vi.fn();
  (tree.props.onCancel as (event: unknown) => void)({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  expect(page.activeElement?.name).toBe(opener.name);
  expect(events.slice(-2)).toEqual(["closeDialog", "agentTrigger"]);
});

it("focuses model search, reveals the current model after opening, then restores its trigger on cancel", () => {
  const opener = new FocusTarget("modelTrigger");
  const onApply = vi.fn();
  const onClose = vi.fn(unmount);
  const picker = NewConversationModelDialog({
    agent,
    value: { service: null, modelValue: null },
    existingOption: null,
    onApply,
    onPrepare: vi.fn(),
    onClose,
    returnFocusRef: { current: opener as unknown as HTMLElement },
  });
  const { tree } = mount(picker);
  expect(h.portalTargets).toEqual([page.body]);
  expect(page.activeElement?.name).toBe("search");
  expect(events).toEqual([
    "showModal",
    "close",
    "search",
    "scroll:selected:nearest",
  ]);
  (tree.props.onCancel as (event: unknown) => void)({
    preventDefault: vi.fn(),
  });
  expect(page.activeElement?.name).toBe(opener.name);
  expect(onApply).not.toHaveBeenCalled();
});

it.each(["hidden", "removed"])(
  "does not restore focus to a %s opener after navigating away",
  (state) => {
    const opener = new FocusTarget("agentTrigger");
    mount(
      NewConversationAgentDialog({
        cards: [],
        picked: null,
        prepared: () => true,
        onPick: vi.fn(),
        onPrepare: vi.fn(),
        onClose: vi.fn(),
        returnFocusRef: { current: opener as unknown as HTMLElement },
      }),
    );
    if (state === "hidden") opener.hidden = true;
    else opener.isConnected = false;
    unmount();
    expect(events).not.toContain("agentTrigger");
  },
);
