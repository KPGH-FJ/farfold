import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  state: {
    items: [] as { id: string; label: string; text: string }[],
    ready: true,
    saving: false,
    error: null as string | null,
    uncertain: false,
  },
  edit: null as null | {
    id: string;
    label: string;
    text: string;
    original?: { id: string; label: string; text: string };
  },
  draftStatus: {
    ready: true,
    interactionLocked: false,
    error: null as string | null,
  },
  save: vi.fn(),
  remove: vi.fn(),
  reload: vi.fn(),
  recoverUnknown: vi.fn(),
  flush: vi.fn(),
  close: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [
      h.slots[i],
      (next: unknown) => {
        h.slots[i] = next;
      },
    ];
  },
  useRef: (current: unknown) => {
    const i = h.cursor++;
    return h.slots[i] ?? (h.slots[i] = { current });
  },
}));
vi.mock("../runtime/prompt_templates", () => ({
  usePromptTemplates: () => h.state,
  promptTemplates: {
    snapshot: () => h.state,
    save: h.save,
    remove: h.remove,
    reload: h.reload,
    recoverUnknown: h.recoverUnknown,
  },
}));
vi.mock("../runtime/drafts", () => ({
  useTemplateEditDraft: () => h.edit,
  templateEditDrafts: {
    read: () => h.edit,
    update: (value: typeof h.edit) => {
      h.edit = value;
    },
  },
}));
vi.mock("../runtime/draft_storage", () => ({
  useDraftSaveStatus: () => h.draftStatus,
  draftPersistence: { flush: h.flush, snapshot: () => h.draftStatus },
}));
import { PromptTemplatesDialog } from "./PromptTemplatesDialog";
import { PROMPT_TEMPLATES as S } from "../runtime/prompt_template_strings";
type Node = ReactElement<Record<string, unknown>>;
const flatten = (tree: ReactNode): Node[] =>
  Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...flatten(child.props.children as ReactNode)]
      : [],
  );
const render = () => {
  h.cursor = 0;
  return flatten(PromptTemplatesDialog({ onClose: h.close }));
};
const text = (node: ReactNode): string =>
  Children.toArray(node)
    .map((c) =>
      isValidElement<{ children: ReactNode }>(c)
        ? text(c.props.children)
        : String(c),
    )
    .join("");
const button = (label: string) =>
  render().find(
    (n) => n.type === "button" && text(n.props.children as ReactNode) === label,
  )!;
const click = (label: string) => (button(label).props.onClick as () => void)();
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const submit = () => {
  const form = render().find((n) => n.type === "form")!;
  (form.props.onSubmit as (e: { preventDefault: () => void }) => void)({
    preventDefault: () => {},
  });
};
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.state = {
    items: [],
    ready: true,
    saving: false,
    error: null,
    uncertain: false,
  };
  h.edit = null;
  h.draftStatus = { ready: true, interactionLocked: false, error: null };
  h.save.mockReset().mockResolvedValue(undefined);
  h.remove.mockReset().mockResolvedValue(undefined);
  h.reload.mockReset().mockResolvedValue(undefined);
  h.recoverUnknown.mockReset().mockResolvedValue(undefined);
  h.flush.mockReset().mockResolvedValue(undefined);
  h.close.mockReset();
});

it("edits a retained draft and saves only its name and text, then clears that exact edit", async () => {
  click(S.new);
  const id = h.edit!.id;
  for (const [tag, value] of [
    ["input", "Review"],
    ["textarea", "Review the changes"],
  ]) {
    const input = render().find((n) => n.type === tag)!;
    (input.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value },
    });
  }
  expect(h.edit).toEqual({ id, label: "Review", text: "Review the changes" });
  submit();
  await settle();
  expect(h.save).toHaveBeenCalledWith(
    { id, label: "Review", text: "Review the changes" },
    undefined,
  );
  expect(h.edit).toBeNull();
  expect(h.flush).toHaveBeenCalledTimes(2);
});
it("keeps a rejected edit and does not silently close or repeat the save", async () => {
  const original = { id: "a", label: "Old", text: "Old body" };
  h.state.items = [original];
  h.edit = { ...original, text: "New body", original };
  const edit = h.edit;
  h.save.mockRejectedValue(new Error("unknown"));
  submit();
  await settle();
  expect(h.edit).toBe(edit);
  expect(h.close).not.toHaveBeenCalled();
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(
    render().some(
      (n) => n.props.role === "alert" && n.props.children === S.saveFailed,
    ),
  ).toBe(true);
});
it("late save success does not clear a newer edit and duplicate submission is suppressed", async () => {
  let finish!: () => void;
  h.save.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  h.edit = { id: "a", label: "One", text: "One" };
  submit();
  submit();
  await settle();
  const newer = { id: "a", label: "Newer", text: "Keep" };
  h.edit = newer;
  finish();
  await settle();
  expect(h.save).toHaveBeenCalledTimes(1);
  expect(h.edit).toBe(newer);
});
it("closing preserves editor content and starting another item requires clearing the edit", () => {
  h.edit = { id: "retained", label: "Work", text: "Keep this" };
  const saved = h.edit;
  const dialog = render()[0];
  (dialog.props.onClose as () => void)();
  expect(h.edit).toBe(saved);
  expect(h.close).toHaveBeenCalledOnce();
  expect(button(S.new)).toBeUndefined();
  click(S.discard);
  expect(h.edit).toBeNull();
});
it("deletion needs a second explicit action and passes the exact selected saved value", async () => {
  const item = { id: "a", label: "Name", text: "Body" };
  h.state.items = [item];
  click(S.delete);
  expect(h.remove).not.toHaveBeenCalled();
  click(S.confirmDelete);
  await settle();
  expect(h.remove).toHaveBeenCalledExactlyOnceWith(item);
  expect(h.edit).toBeNull();
});
it("unknown storage disables editing and exposes a read-only recovery action", async () => {
  h.state = { ...h.state, uncertain: true, error: S.saveFailed };
  expect(button(S.new).props.disabled).toBe(true);
  click(S.retry);
  await settle();
  expect(h.reload).toHaveBeenCalledOnce();
  expect(h.save).not.toHaveBeenCalled();
  expect(h.remove).not.toHaveBeenCalled();
});

it("explicit unknown recovery only reads storage and keeps the edit", async () => {
  h.state = { ...h.state, uncertain: true, error: S.saveFailed };
  const edit = { id: "a", label: "Work", text: "Keep" };
  h.edit = edit;
  click(S.recoverUnknown);
  await settle();
  expect(h.recoverUnknown).toHaveBeenCalledOnce();
  expect(h.edit).toBe(edit);
  expect(h.save).not.toHaveBeenCalled();
  expect(h.remove).not.toHaveBeenCalled();
});

it("preserves an edit on conflict until the user explicitly accepts the displayed current baseline", () => {
  const original = { id: "a", label: "Old", text: "Old content" };
  const current = { id: "a", label: "Current", text: "Changed elsewhere" };
  h.edit = { id: "a", label: "My name", text: "My work", original };
  h.state.items = [current];
  expect(button(S.save).props.disabled).toBe(true);
  submit();
  expect(h.save).not.toHaveBeenCalled();
  expect(
    render().some((n) => n.type === "pre" && n.props.children === current.text),
  ).toBe(true);
  click(S.useCurrent);
  expect(h.edit).toEqual({
    id: "a",
    label: "My name",
    text: "My work",
    original: current,
  });
  expect(button(S.save).props.disabled).toBe(false);
});

it("offers a new identity for a deleted target without losing text", () => {
  const original = { id: "a", label: "Deleted", text: "Old" };
  h.edit = { ...original, text: "Keep my work", original };
  click(S.saveCopy);
  expect(h.edit!.id).not.toBe("a");
  expect(h.edit!.text).toBe("Keep my work");
  expect(h.edit!.original).toBeUndefined();
  expect(h.save).not.toHaveBeenCalled();
});

it("finishes an already saved edit without submitting it again", async () => {
  const item = { id: "a", label: "Saved", text: "Body" };
  h.edit = { ...item };
  h.state.items = [item];
  expect(button(S.save).props.disabled).toBe(true);
  click(S.finishSaved);
  await settle();
  expect(h.edit).toBeNull();
  expect(h.flush).toHaveBeenCalledOnce();
  expect(h.save).not.toHaveBeenCalled();
});

it("a stale finish action cannot clear an edit after the stored value changes", async () => {
  const item = { id: "a", label: "Saved", text: "Body" };
  h.edit = { ...item };
  h.state.items = [item];
  const edit = h.edit;
  const finish = button(S.finishSaved).props.onClick as () => void;
  h.state = { ...h.state, items: [{ ...item, text: "Changed" }] };
  finish();
  await settle();
  expect(h.edit).toBe(edit);
  expect(h.save).not.toHaveBeenCalled();
});

it("keeps controls locked while unsent work is still loading", () => {
  h.draftStatus.ready = false;
  expect(button(S.new).props.disabled).toBe(true);
  click(S.new);
  expect(h.edit).toBeNull();
});

const attach = (node: Node, element: unknown) =>
  (node.props.ref as ((element: unknown) => void) | undefined)?.(element);
const focusable = (disabled = false) => ({ disabled, focus: vi.fn() });

it("hands an explicit new edit to its name once without stealing focus on later renders", () => {
  const name = focusable();
  click(S.new);
  attach(
    render().find((n) => n.type === "input")!,
    name,
  );
  expect(name.focus).toHaveBeenCalledOnce();
  attach(
    render().find((n) => n.type === "input")!,
    name,
  );
  expect(name.focus).toHaveBeenCalledOnce();
  click(S.discard);
  const entry = focusable();
  attach(button(S.new), entry);
  expect(entry.focus).toHaveBeenCalledOnce();
});

it("returns a discarded existing edit to that exact row, not the first template", () => {
  const a = { id: "a", label: "A", text: "A" };
  const b = { id: "b", label: "B", text: "B" };
  h.state.items = [a, b];
  const edits = render().filter(
    (n) =>
      n.type === "button" && text(n.props.children as ReactNode) === S.edit,
  );
  (edits[1].props.onClick as () => void)();
  const name = focusable();
  attach(
    render().find((n) => n.type === "input")!,
    name,
  );
  expect(name.focus).toHaveBeenCalledOnce();
  click(S.discard);
  const entries = render().filter(
    (n) =>
      n.type === "button" && text(n.props.children as ReactNode) === S.edit,
  );
  const first = focusable(),
    exact = focusable();
  attach(entries[0], first);
  attach(entries[1], exact);
  expect(first.focus).not.toHaveBeenCalled();
  expect(exact.focus).toHaveBeenCalledOnce();
});

it("defaults deletion review to Cancel and returns to its entry without deleting", () => {
  h.state.items = [{ id: "a", label: "A", text: "A" }];
  click(S.delete);
  const confirm = focusable(),
    cancel = focusable();
  attach(button(S.confirmDelete), confirm);
  attach(button(S.cancel), cancel);
  expect(confirm.focus).not.toHaveBeenCalled();
  expect(cancel.focus).toHaveBeenCalledOnce();
  click(S.cancel);
  const entry = focusable();
  attach(button(S.delete), entry);
  expect(entry.focus).toHaveBeenCalledOnce();
  expect(h.remove).not.toHaveBeenCalled();
});

it("returns a successful save only after its exact edit is cleared and controls unlock", async () => {
  h.edit = { id: "a", label: "A", text: "A" };
  let finish!: () => void;
  h.flush.mockResolvedValueOnce(undefined).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  h.save.mockImplementation(async () => {
    h.state.items = [{ id: "a", label: "A", text: "A" }];
  });
  submit();
  await settle();
  expect(h.edit).toBeNull();
  const entry = focusable(true);
  attach(button(S.edit), entry);
  expect(entry.focus).not.toHaveBeenCalled();
  finish();
  await settle();
  entry.disabled = false;
  attach(button(S.edit), entry);
  expect(entry.focus).toHaveBeenCalledOnce();
  attach(button(S.edit), entry);
  expect(entry.focus).toHaveBeenCalledOnce();
});

it("does not focus a newer edit after an older save settles", async () => {
  let finish!: () => void;
  h.save.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  h.edit = { id: "a", label: "A", text: "A" };
  submit();
  await settle();
  h.edit = { id: "b", label: "B", text: "Keep" };
  finish();
  await settle();
  const name = focusable();
  attach(
    render().find((n) => n.type === "input")!,
    name,
  );
  expect(name.focus).not.toHaveBeenCalled();
  expect(h.edit?.id).toBe("b");
});

it("does not hand an entry action to a different edit that replaces it before attachment", () => {
  click(S.new);
  h.edit = { id: "replacement", label: "Newer", text: "Keep" };
  const name = focusable();
  attach(
    render().find((n) => n.type === "input")!,
    name,
  );
  expect(name.focus).not.toHaveBeenCalled();
});

it("falls back to the dialog close control when the returned row becomes read-only", () => {
  const item = { id: "a", label: "A", text: "A" };
  h.state.items = [item];
  h.edit = { ...item };
  h.state.uncertain = true;
  click(S.discard);
  const close = focusable();
  const entry = {
    ...focusable(true),
    closest: () => ({ querySelector: () => close }),
  };
  attach(button(S.edit), entry);
  expect(entry.focus).not.toHaveBeenCalled();
  expect(close.focus).toHaveBeenCalledOnce();
  entry.disabled = false;
  attach(button(S.edit), entry);
  expect(entry.focus).not.toHaveBeenCalled();
});

it("returns a rejected save to its retained edit after unlocking", async () => {
  h.edit = { id: "a", label: "A", text: "Keep" };
  h.save.mockRejectedValue(new Error("rejected"));
  submit();
  await settle();
  const name = focusable();
  attach(
    render().find((n) => n.type === "input")!,
    name,
  );
  expect(name.focus).toHaveBeenCalledOnce();
  expect(h.edit?.text).toBe("Keep");
  attach(
    render().find((n) => n.type === "input")!,
    name,
  );
  expect(name.focus).toHaveBeenCalledOnce();
});

it("does not focus a newer edit when an older save rejects", async () => {
  let reject!: () => void;
  h.save.mockImplementation(
    () =>
      new Promise<void>((_, fail) => {
        reject = () => fail(new Error("rejected"));
      }),
  );
  h.edit = { id: "a", label: "A", text: "A" };
  submit();
  await settle();
  h.edit = { id: "a", label: "Newer same ID", text: "Keep" };
  reject();
  await settle();
  const name = focusable();
  attach(
    render().find((n) => n.type === "input")!,
    name,
  );
  expect(name.focus).not.toHaveBeenCalled();
  expect(h.edit?.text).toBe("Keep");
});
