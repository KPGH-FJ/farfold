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
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  invoke: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (current: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import { AttachmentRecovery } from "./AttachmentRecovery";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { composerDrafts, draftPersistence } from "../runtime/drafts";
import { threads } from "../runtime/sessions";
import { ATTACHMENT_REVIEW as S } from "../runtime/attachment_review_strings";
type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof AttachmentRecovery>;
function nodes(tree: ReactNode): Element[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...nodes(child.props.children as ReactNode)]
      : [],
  );
}
function render() {
  for (let pass = 0; pass < 5; pass++) {
    h.cursor = 0;
    const tree = nodes(AttachmentRecovery(props));
    if (!h.effects.length) return tree;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw new Error("render loop");
}
function button(label: string) {
  return render().find(
    (node) => node.type === "button" && node.props.children === label,
  )!;
}
function open() {
  (button(S.open).props.onClick as () => void)();
  return render();
}
function confirm() {
  (button(S.confirm).props.onClick as () => void)();
  render();
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.invoke.mockReset().mockResolvedValue("read now");
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  props = {
    draftKey: "attachment-review-ui",
    thread: null,
    active: true,
    embed: true,
  };
  composerDrafts.update(props.draftKey, () => ({
    text: "Preserve this body",
    attachments: [
      {
        id: "a",
        name: "a.md",
        kind: "file",
        uri: "file:///p/a.md",
        recovered: true,
      },
      {
        id: "b",
        name: "b.md",
        kind: "file",
        uri: "file:///p/b.md",
        recovered: true,
      },
    ],
  }));
  vi.spyOn(threads, "send");
  vi.spyOn(threads, "continueQueue");
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
  composerDrafts.clear("attachment-review-ui");
  composerDrafts.clear("attachment-review-other");
  vi.restoreAllMocks();
});

it("offers checked recovered attachments, applies the selected subset after validation and never sends", async () => {
  const inputs = open().filter((node) => node.type === "input");
  expect(inputs).toHaveLength(2);
  expect(inputs.every((input) => input.props.checked === true)).toBe(true);
  (inputs[1].props.onChange as (event: unknown) => void)({
    target: { checked: false },
  });
  render();
  confirm();
  await vi.waitFor(() =>
    expect(composerDrafts.read(props.draftKey).attachments).toHaveLength(1),
  );
  expect(composerDrafts.read(props.draftKey)).toMatchObject({
    text: "Preserve this body",
    attachments: [{ name: "a.md", recovered: false, content: "read now" }],
  });
  expect(render().some((node) => node.type === WorkspaceDialog)).toBe(false);
  expect(render().some((node) => node.props.children === S.done)).toBe(true);
  expect(threads.send).not.toHaveBeenCalled();
  expect(threads.continueQueue).not.toHaveBeenCalled();
});

it("keeps input untouched and exposes the file failure with checkboxes available for another choice", async () => {
  const original = composerDrafts.read(props.draftKey);
  h.invoke.mockRejectedValue(new Error("missing"));
  open();
  confirm();
  await vi.waitFor(() =>
    expect(render().some((node) => node.props.role === "alert")).toBe(true),
  );
  expect(composerDrafts.read(props.draftKey)).toBe(original);
  expect(button(S.confirm).props.disabled).toBe(false);
  expect(
    render()
      .filter((node) => node.type === "input")
      .every((node) => !node.props.disabled),
  ).toBe(true);
});

it.each(["close", "navigate", "hide"])(
  "discards late validation after %s without modifying either draft",
  async (action) => {
    const original = composerDrafts.read(props.draftKey);
    composerDrafts.update("attachment-review-other", () => ({
      text: "Other draft",
      attachments: [],
    }));
    const other = composerDrafts.read("attachment-review-other");
    let finish!: (value: string) => void;
    h.invoke.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    open();
    confirm();
    expect(h.invoke).toHaveBeenCalledOnce();
    if (action === "close") {
      const dialog = render().find((node) => node.type === WorkspaceDialog)!;
      (dialog.props.onClose as () => void)();
    } else if (action === "navigate")
      props = { ...props, draftKey: "attachment-review-other" };
    else props = { ...props, active: false };
    render();
    finish("late");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(composerDrafts.read("attachment-review-ui")).toBe(original);
    expect(composerDrafts.read("attachment-review-other")).toBe(other);
    expect(render().some((node) => node.type === WorkspaceDialog)).toBe(false);
    expect(threads.send).not.toHaveBeenCalled();
  },
);

it("shows unknown-sending attachments as locked instead of allowing a confirmation to release their protection", () => {
  composerDrafts.update(props.draftKey, (draft) => ({
    ...draft,
    sendPending: true,
  }));
  const original = composerDrafts.read(props.draftKey);
  const tree = open();
  expect(
    tree
      .filter((node) => node.type === "input")
      .every((node) => node.props.disabled),
  ).toBe(true);
  expect(button(S.confirm).props.disabled).toBe(true);
  expect(composerDrafts.read(props.draftKey)).toBe(original);
  expect(h.invoke).not.toHaveBeenCalled();
});
