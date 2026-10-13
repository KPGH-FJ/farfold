import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { approvedWorkbook } from "../runtime/xlsx_draft.test-support";
import type { DraftAttachment } from "../runtime/drafts";
import { DOCUMENT_INPUT_STRINGS as S } from "../runtime/document_input_strings";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  invoke: vi.fn(),
  read: vi.fn(),
  confirm: vi.fn(),
  saved: vi.fn(),
  failApproved: false,
  hold: null as null | Promise<void>,
  writes: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const i = h.cursor++;
    const state = h.slots[i] ?? (h.slots[i] = { value: initial });
    return [
      state.value,
      (value: unknown) => {
        state.value = value;
      },
    ];
  },
  useRef(current: unknown) {
    const i = h.cursor++;
    return (h.slots[i] ?? (h.slots[i] = { value: { current } })).value;
  },
  useEffect(setup: () => void | (() => void), deps: unknown[]) {
    const i = h.cursor++,
      old = h.slots[i];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps?.[n]))) {
      const next = (h.slots[i] = { deps, cleanup: old?.cleanup });
      h.effects.push(() => {
        old?.cleanup?.();
        next.cleanup = setup() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
// This narrow UI ownership test controls the conversion boundary. The complete
// App browser receipt separately uses an actual ZIP and the real XLSX Worker.
vi.mock("../runtime/document_input", () => ({
  readDocumentInput: h.read,
  confirmDocumentInput: h.confirm,
}));
type Node = ReactElement<Record<string, unknown>>;
const flatten = (tree: ReactNode): Node[] =>
  Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...flatten(child.props.children as ReactNode)]
      : [],
  );
const text = (tree: ReactNode): string =>
  Children.toArray(tree)
    .map((child) =>
      isValidElement<{ children: ReactNode }>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join("");
const original: DraftAttachment = {
  id: "file",
  kind: "file",
  name: "report.xlsx",
  uri: "file:///owned/report.xlsx",
};
const approved = approvedWorkbook();
let d: typeof import("../runtime/drafts");
let component: typeof import("./DocumentComposerAttachments").DocumentComposerAttachments;
let context = "original-choice",
  enabled = true;
function render() {
  h.cursor = 0;
  const tree = component({
    draftKey: "new",
    context,
    enabled,
    items: d.composerDrafts.read("new").attachments,
    onRemove: () => {},
    onSaved: h.saved,
  });
  for (const effect of h.effects.splice(0)) effect();
  return flatten(tree);
}
function review() {
  return render().find(
    (node) =>
      typeof node.type === "function" &&
      node.type.name === "DocumentInputReview",
  );
}
function action(
  label: string,
  item = d.composerDrafts.read("new").attachments[0],
) {
  const node = render().find(
    (n) =>
      typeof n.type === "function" && n.type.name === "ComposerAttachments",
  )!;
  const actions = flatten(
    (node.props.action as (item: DraftAttachment) => ReactNode)(item),
  );
  const button = actions.find(
    (n) => n.type === "button" && text(n.props.children as ReactNode) === label,
  )!;
  (button.props.onClick as () => void)();
}
function alerts() {
  return render()
    .filter((node) => node.props.role === "alert")
    .map((node) => text(node.props.children as ReactNode));
}
async function confirmAndFail() {
  action(S.read);
  await vi.waitFor(() => expect(review()?.props.result).toBeTruthy());
  h.failApproved = true;
  (review()!.props.onConfirm as () => void)();
  await vi.waitFor(() => expect(alerts()).toEqual([S.saveFailed]));
  return d.composerDrafts.read("new").attachments[0];
}
beforeEach(async () => {
  vi.resetModules();
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.writes = [];
  h.failApproved = false;
  h.hold = null;
  context = "original-choice";
  enabled = true;
  h.saved.mockReset();
  h.read
    .mockReset()
    .mockResolvedValue({ ...approved, actualTextChars: approved.text.length });
  h.confirm.mockReset().mockResolvedValue(approved);
  h.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "settings_get") return null;
    if (command !== "settings_set") throw new Error(`Unexpected ${command}`);
    if (
      h.failApproved &&
      args.value.composers?.new?.attachments?.[0]?.documentText
    )
      throw new Error("controlled disk failure");
    if (h.hold) await h.hold;
    h.writes.push(args.value);
  });
  d = await import("../runtime/drafts");
  component = (await import("./DocumentComposerAttachments"))
    .DocumentComposerAttachments;
  await d.draftPersistence.load();
  d.composerDrafts.update("new", () => ({
    text: "KEEP_BODY",
    attachments: [original],
  }));
  await d.draftPersistence.flush();
  render();
});
afterEach(async () => {
  for (const slot of h.slots) slot.cleanup?.();
  h.failApproved = false;
  h.hold = null;
  await d?.draftPersistence.flush();
});
it("updates only its failed document-save notice after actual retry writes the same complete approved attachment", async () => {
  const applied = await confirmAndFail();
  expect(h.saved).not.toHaveBeenCalled();
  h.failApproved = false;
  await d.draftPersistence.flush();
  expect(alerts()).toEqual([]);
  expect(
    render().some(
      (node) =>
        node.props.role === "status" &&
        text(node.props.children as ReactNode) === S.saved,
    ),
  ).toBe(true);
  expect(h.saved).toHaveBeenCalledExactlyOnceWith({
    draftKey: "new",
    attachment: original,
    applied,
    approved,
  });
  expect(d.composerDrafts.read("new").attachments[0]).toBe(applied);
  expect(h.writes.at(-1)).toMatchObject({
    composers: {
      new: { text: "KEEP_BODY", attachments: [{ documentText: approved }] },
    },
  });
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(h.confirm).toHaveBeenCalledTimes(1);
  expect(h.invoke.mock.calls.every(([name]) => name !== "session_prompt")).toBe(
    true,
  );
});

it("keeps its failure while retry has merely cleared the global error and still awaits the actual write", async () => {
  await confirmAndFail();
  let finish!: () => void;
  h.hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  h.failApproved = false;
  const retry = d.draftPersistence.flush();
  await vi.waitFor(() =>
    expect(d.draftPersistence.snapshot().saving).toBe(true),
  );
  expect(d.draftPersistence.snapshot().error).toBeNull();
  expect(alerts()).toEqual([S.saveFailed]);
  expect(h.saved).not.toHaveBeenCalled();
  finish();
  await retry;
  expect(alerts()).toEqual([]);
  expect(h.saved).toHaveBeenCalledTimes(1);
});

it("retains the complete memory and the owned hint if retry also fails", async () => {
  const applied = await confirmAndFail();
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(alerts()).toEqual([S.saveFailed]);
  expect(d.composerDrafts.read("new").attachments[0]).toBe(applied);
  expect(h.saved).not.toHaveBeenCalled();
});

it.each([
  "same-id-copy",
  "different-attachment",
  "remove-readd-original",
] as const)(
  "cannot acknowledge a failed save for a retired %s owner",
  async (change) => {
    const applied = await confirmAndFail();
    if (change === "remove-readd-original") {
      d.composerDrafts.update("new", (draft) => ({
        ...draft,
        attachments: [],
      }));
      d.composerDrafts.update("new", (draft) => ({
        ...draft,
        attachments: [applied],
      }));
    } else {
      d.composerDrafts.update("new", (draft) => ({
        ...draft,
        attachments: [
          { ...applied, id: change === "same-id-copy" ? applied.id : "other" },
        ],
      }));
    }
    h.failApproved = false;
    await d.draftPersistence.flush();
    expect(h.saved).not.toHaveBeenCalled();
    expect(alerts()).toEqual([S.saveFailed]);
    expect(render().some((node) => node.props.role === "status")).toBe(false);
  },
);

it("does not revoke or reread a retained attachment when unrelated draft text is saved with its exact owner", async () => {
  const applied = await confirmAndFail();
  d.composerDrafts.update("new", (draft) => ({ ...draft, text: "NEW_BODY" }));
  h.failApproved = false;
  await d.draftPersistence.flush();
  expect(alerts()).toEqual([]);
  expect(h.saved).toHaveBeenCalledTimes(1);
  expect(d.composerDrafts.read("new").attachments[0]).toBe(applied);
  expect(h.read).toHaveBeenCalledTimes(1);
});

it.each([
  "choice-away-back",
  "disabled-away-back",
  "new-choice-ABA",
  "unmount",
] as const)("a late successful write cannot acknowledge %s", async (change) => {
  await confirmAndFail();
  let finish!: () => void;
  h.hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  h.failApproved = false;
  const retry = d.draftPersistence.flush();
  await vi.waitFor(() =>
    expect(d.draftPersistence.snapshot().saving).toBe(true),
  );
  if (change === "choice-away-back") {
    context = "different-choice";
    render();
    context = "original-choice";
    render();
  } else if (change === "disabled-away-back") {
    enabled = false;
    render();
    enabled = true;
    render();
  } else if (change === "new-choice-ABA") {
    d.newConversationChoice.cwd = "/other-folder";
    d.newConversationChoice.cwd = null;
  } else for (const slot of h.slots) slot.cleanup?.();
  finish();
  await retry;
  expect(h.saved).not.toHaveBeenCalled();
  expect(h.read).toHaveBeenCalledTimes(1);
});

it("a successor read owns its own error after the retired save completes", async () => {
  await confirmAndFail();
  let finish!: () => void;
  h.hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  h.failApproved = false;
  const retry = d.draftPersistence.flush();
  await vi.waitFor(() =>
    expect(d.draftPersistence.snapshot().saving).toBe(true),
  );
  h.read.mockRejectedValueOnce(new Error("replacement read failure"));
  action(S.reread);
  await vi.waitFor(() => expect(review()?.props.error).toBe(S.failed));
  finish();
  await retry;
  expect(review()?.props.error).toBe(S.failed);
  expect(h.saved).not.toHaveBeenCalled();
  expect(h.invoke.mock.calls.every(([name]) => name !== "session_prompt")).toBe(
    true,
  );
});

it("the same durable retry path preserves DOCX text, source, continuous layout and image-reference metadata", async () => {
  const docx: DraftAttachment = {
    ...original,
    name: "report.docx",
    uri: "file:///owned/report.docx",
  };
  const reviewValue = {
    text: "DOCX_COMPLETE_END",
    actualTextChars: 17,
    local: {
      schema: 1 as const,
      format: "docx" as const,
      selection: "read-visible-text" as const,
      source: {
        root: "/owned",
        path: "/owned/report.docx",
        resolvedPath: "/owned/report.docx",
        name: "report.docx",
        size: 100,
        version: "docx-version",
        sha256: "a".repeat(64),
      },
      textSha256: "b".repeat(64),
      utf8Bytes: 17,
      partial: false,
      partialSelected: false,
      warnings: [{ code: "continuousLayout" as const, count: 1 }],
      imageReferences: 2,
    },
  };
  const docxApproved = { text: reviewValue.text, local: reviewValue.local };
  h.read.mockResolvedValue(reviewValue);
  h.confirm.mockResolvedValue(docxApproved);
  d.composerDrafts.update("new", (draft) => ({
    ...draft,
    attachments: [docx],
  }));
  await d.draftPersistence.flush();
  const applied = await confirmAndFail();
  h.failApproved = false;
  await d.draftPersistence.flush();
  expect(alerts()).toEqual([]);
  expect(h.saved).toHaveBeenCalledExactlyOnceWith({
    draftKey: "new",
    attachment: docx,
    applied,
    approved: docxApproved,
  });
  expect(d.composerDrafts.read("new").attachments[0].documentText).toBe(
    docxApproved,
  );
  expect(h.writes.at(-1)).toMatchObject({
    composers: { new: { attachments: [{ documentText: docxApproved }] } },
  });
});
