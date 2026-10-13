import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DraftAttachment } from "../runtime/drafts";
import type { LocalPdfDocumentText } from "../runtime/document_input_types";
import { DOCUMENT_INPUT_STRINGS as S } from "../runtime/document_input_strings";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  invoke: vi.fn(),
  read: vi.fn(),
  confirm: vi.fn(),
  saved: vi.fn(),
  failApprovedSave: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const state =
      h.slots[h.cursor++] ?? (h.slots[h.cursor - 1] = { value: initial });
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
// Controls only the conversion boundary; real PDF Worker/full-App proof is separate.
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
  id: "pdf",
  kind: "file",
  name: "report.pdf",
  uri: "file:///owned/report.pdf",
};
const pdf: LocalPdfDocumentText = {
  schema: 1,
  format: "pdf",
  selection: "read-decoded-page-text",
  source: {
    root: "/owned",
    path: "/owned/report.pdf",
    resolvedPath: "/owned/report.pdf",
    name: "report.pdf",
    size: 100,
    sha256: "a".repeat(64),
    version: "pdf-version",
  },
  textSha256: "b".repeat(64),
  utf8Bytes: 17,
  partial: true,
  partialSelected: true,
  scope: {
    mode: "decoded-page-text",
    includePossiblyInvisibleText: true,
    pageCount: 2,
    readPageNumbers: [1, 2],
    extraction: "pdfjs-text-content-v1",
  },
  warnings: [
    { code: "decodedTextOnly", count: 1, unit: "scope" },
    { code: "visibilityUnverified", count: 1, unit: "scope" },
    { code: "readingOrderUnverified", count: 1, unit: "scope" },
    { code: "textDecodingUnverified", count: 1, unit: "scope" },
  ],
};
const approved = { text: "PDF_COMPLETE_TAIL", local: pdf };
const readValue = {
  ...approved,
  local: { ...pdf, partialSelected: false },
  actualTextChars: approved.text.length,
};
let d: typeof import("../runtime/drafts");
let component: typeof import("./DocumentComposerAttachments").DocumentComposerAttachments;
let context = "same-owner",
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
const review = () =>
  render().find(
    (n) =>
      typeof n.type === "function" && n.type.name === "DocumentInputReview",
  );
function action(label: string) {
  const attachments = render().find(
    (n) =>
      typeof n.type === "function" && n.type.name === "ComposerAttachments",
  )!;
  const item = d.composerDrafts.read("new").attachments[0];
  const nodes = flatten(
    (attachments.props.action as (item: DraftAttachment) => ReactNode)(item),
  );
  const button = nodes.find(
    (n) => n.type === "button" && text(n.props.children as ReactNode) === label,
  );
  expect(button, `PDF attachment action ${label}`).toBeTruthy();
  (button!.props.onClick as () => void)();
}
function chooseAndRead() {
  expect(review()?.props.pdfScopeRequired).toBe(true);
  (review()!.props.onPdfScopeSelected as (selected: boolean) => void)(true);
  (review()!.props.onReadPdf as () => void)();
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.resetModules();
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  context = "same-owner";
  enabled = true;
  h.saved.mockReset();
  h.read.mockReset().mockResolvedValue(readValue);
  h.confirm.mockReset().mockResolvedValue(approved);
  h.failApprovedSave = false;
  h.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "settings_get") return null;
    if (command !== "settings_set") throw new Error(`Unexpected ${command}`);
    if (
      h.failApprovedSave &&
      args.value.composers?.new?.attachments?.[0]?.documentText
    )
      throw new Error("controlled save failure");
  });
  d = await import("../runtime/drafts");
  component = (await import("./DocumentComposerAttachments"))
    .DocumentComposerAttachments;
  await d.draftPersistence.load();
  d.composerDrafts.update("new", () => ({
    text: "KEEP_ORDINARY_TEXT",
    attachments: [original],
  }));
  await d.draftPersistence.flush();
  render();
});
afterEach(async () => {
  for (const slot of h.slots) slot.cleanup?.();
  h.failApprovedSave = false;
  await d?.draftPersistence.flush();
});
it("does not read new PDF bytes or add authority until the user actively chooses the possibly invisible text range", async () => {
  action(S.read);
  expect(review()?.props.pdfScopeRequired).toBe(true);
  expect(review()?.props.pdfScopeSelected).toBe(false);
  expect(review()?.props.result).toBeNull();
  expect(h.read).not.toHaveBeenCalled();
  (review()!.props.onReadPdf as () => void)();
  expect(h.read).not.toHaveBeenCalled();
  expect(
    d.composerDrafts.read("new").attachments[0].documentText,
  ).toBeUndefined();
  chooseAndRead();
  await vi.waitFor(() => expect(review()?.props.result).toBe(readValue));
  expect(h.read).toHaveBeenCalledExactlyOnceWith(
    { uri: original.uri, name: original.name },
    expect.any(AbortSignal),
    { pdf: { mode: "decoded-page-text", includePossiblyInvisibleText: true } },
  );
  expect(review()?.props.partialSelected).toBe(false);
  expect(d.composerDrafts.read("new").text).toBe("KEEP_ORDINARY_TEXT");
  expect(h.confirm).not.toHaveBeenCalled();
  expect(
    h.invoke.mock.calls.every(
      ([name]) => name === "settings_get" || name === "settings_set",
    ),
  ).toBe(true);
});
it("cancelled scope choice restores the exact original attachment and does not retain either scope or omission consent", () => {
  action(S.read);
  (review()!.props.onPdfScopeSelected as (value: boolean) => void)(true);
  (review()!.props.onClose as () => void)();
  expect(d.composerDrafts.read("new").attachments[0]).toBe(original);
  expect(h.read).not.toHaveBeenCalled();
  action(S.read);
  expect(review()?.props.pdfScopeSelected).toBe(false);
  expect(review()?.props.partialSelected).toBe(false);
});
it("starts one bounded read even if the same chosen-range callback is clicked twice before rerender", async () => {
  const task = deferred<typeof readValue>();
  h.read.mockReturnValueOnce(task.promise);
  action(S.read);
  (review()!.props.onPdfScopeSelected as (value: boolean) => void)(true);
  const readScope = review()!.props.onReadPdf as () => void;
  readScope();
  readScope();
  expect(h.read).toHaveBeenCalledTimes(1);
  task.resolve(readValue);
  await vi.waitFor(() => expect(review()?.props.result).toBe(readValue));
});
it("a retired range-choice callback cannot preselect the successor's consent", () => {
  action(S.read);
  const chooseOld = review()!.props.onPdfScopeSelected as (
    value: boolean,
  ) => void;
  (review()!.props.onClose as () => void)();
  action(S.read);
  chooseOld(true);
  expect(review()?.props.pdfScopeSelected).toBe(false);
  expect(h.read).not.toHaveBeenCalled();
});
it("confirms and durably saves only the full reviewed PDF after fresh omission consent, preserving ordinary input", async () => {
  action(S.read);
  chooseAndRead();
  await vi.waitFor(() => expect(review()?.props.result).toBe(readValue));
  expect(review()?.props.partialSelected).toBe(false);
  (review()!.props.onPartialSelected as (value: boolean) => void)(true);
  (review()!.props.onConfirm as () => void)();
  await vi.waitFor(() => expect(h.saved).toHaveBeenCalledTimes(1));
  expect(h.confirm).toHaveBeenCalledExactlyOnceWith(
    readValue,
    { partialSelected: true },
    expect.any(AbortSignal),
  );
  const applied = d.composerDrafts.read("new").attachments[0];
  expect(applied.documentText).toBe(approved);
  expect(d.composerDrafts.read("new").text).toBe("KEEP_ORDINARY_TEXT");
  expect(h.saved).toHaveBeenCalledExactlyOnceWith({
    draftKey: "new",
    attachment: original,
    applied,
    approved,
  });
  expect(h.invoke.mock.calls.every(([name]) => name !== "session_prompt")).toBe(
    true,
  );
});
it("preserves the complete approved PDF after a failed write and acknowledges only its actual durable retry", async () => {
  action(S.read);
  chooseAndRead();
  await vi.waitFor(() => expect(review()?.props.result).toBe(readValue));
  (review()!.props.onPartialSelected as (value: boolean) => void)(true);
  h.failApprovedSave = true;
  (review()!.props.onConfirm as () => void)();
  await vi.waitFor(() =>
    expect(
      render().some(
        (node) =>
          node.props.role === "alert" &&
          text(node.props.children as ReactNode) === S.saveFailed,
      ),
    ).toBe(true),
  );
  const applied = d.composerDrafts.read("new").attachments[0];
  expect(applied.documentText).toBe(approved);
  expect(h.saved).not.toHaveBeenCalled();
  expect(d.composerDrafts.read("new").text).toBe("KEEP_ORDINARY_TEXT");
  h.failApprovedSave = false;
  await d.draftPersistence.flush();
  expect(render().some((node) => node.props.role === "alert")).toBe(false);
  expect(h.saved).toHaveBeenCalledExactlyOnceWith({
    draftKey: "new",
    attachment: original,
    applied,
    approved,
  });
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(h.confirm).toHaveBeenCalledTimes(1);
});
it("a cancelled PDF confirmation's late error cannot close or contaminate a successor's new scope choice", async () => {
  const pending = deferred<typeof approved>();
  h.confirm.mockReturnValueOnce(pending.promise);
  action(S.read);
  chooseAndRead();
  await vi.waitFor(() => expect(review()?.props.result).toBe(readValue));
  (review()!.props.onPartialSelected as (value: boolean) => void)(true);
  (review()!.props.onConfirm as () => void)();
  await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
  (review()!.props.onClose as () => void)();
  action(S.read);
  pending.reject(new Error("obsolete confirmation failed"));
  await pending.promise.catch(() => {});
  await Promise.resolve();
  expect(review()?.props.pdfScopeRequired).toBe(true);
  expect(review()?.props.pdfScopeSelected).toBe(false);
  expect(review()?.props.result).toBeNull();
  expect(review()?.props.error).toBeNull();
  expect(
    d.composerDrafts.read("new").attachments[0].documentText,
  ).toBeUndefined();
  expect(h.saved).not.toHaveBeenCalled();
});
it("known PDF reread carries only its previously confirmed scope and requires fresh result consent", async () => {
  const known = { ...original, documentText: approved };
  d.composerDrafts.update("new", (draft) => ({
    ...draft,
    attachments: [known],
  }));
  action(S.reread);
  await vi.waitFor(() => expect(review()?.props.result).toBe(readValue));
  expect(review()?.props.pdfScopeRequired).toBe(false);
  expect(h.read).toHaveBeenCalledExactlyOnceWith(
    { uri: original.uri, name: original.name },
    expect.any(AbortSignal),
    { pdf: { mode: "decoded-page-text", includePossiblyInvisibleText: true } },
  );
  expect(review()?.props.partialSelected).toBe(false);
  expect(d.composerDrafts.read("new").attachments[0].documentText).toBe(
    approved,
  );
});
it("retains historical unknown text but requires a new active range choice before reading its PDF", async () => {
  const unknown = {
    ...original,
    documentText: { text: "UNKNOWN_TEXT_RETAINED", local: null },
  };
  d.composerDrafts.update("new", (draft) => ({
    ...draft,
    attachments: [unknown],
  }));
  action(S.reread);
  expect(review()?.props.previousText).toBe("UNKNOWN_TEXT_RETAINED");
  expect(review()?.props.pdfScopeRequired).toBe(true);
  expect(h.read).not.toHaveBeenCalled();
  (review()!.props.onClose as () => void)();
  expect(d.composerDrafts.read("new").attachments[0]).toBe(unknown);
});
it("readonly viewing of confirmed PDF text does not grant new consent, replace its owner, or read any bytes", () => {
  const known = { ...original, documentText: approved };
  d.composerDrafts.update("new", (draft) => ({
    ...draft,
    attachments: [known],
  }));
  action(S.view);
  expect(review()).toBeUndefined();
  expect(
    render().some(
      (n) =>
        typeof n.type === "function" && n.type.name === "DocumentTextDetails",
    ),
  ).toBe(true);
  expect(h.read).not.toHaveBeenCalled();
  expect(h.confirm).not.toHaveBeenCalled();
  expect(d.composerDrafts.read("new").attachments[0]).toBe(known);
});
it.each([
  "remove-readd",
  "same-id-replacement",
  "navigate",
  "disable",
] as const)(
  "pending scope choice cannot read for a retired %s owner",
  (change) => {
    action(S.read);
    (review()!.props.onPdfScopeSelected as (value: boolean) => void)(true);
    const oldRead = review()!.props.onReadPdf as () => void;
    if (change === "remove-readd") {
      d.composerDrafts.update("new", (draft) => ({
        ...draft,
        attachments: [],
      }));
      d.composerDrafts.update("new", (draft) => ({
        ...draft,
        attachments: [original],
      }));
    } else if (change === "same-id-replacement")
      d.composerDrafts.update("new", (draft) => ({
        ...draft,
        attachments: [{ ...original }],
      }));
    else if (change === "navigate") context = "successor-owner";
    else enabled = false;
    render();
    oldRead();
    expect(h.read).not.toHaveBeenCalled();
    expect(d.composerDrafts.read("new").text).toBe("KEEP_ORDINARY_TEXT");
  },
);
it.each(["result", "error"] as const)(
  "a cancelled PDF read's late %s cannot affect a successor's unselected range choice",
  async (late) => {
    const task = deferred<typeof readValue>();
    h.read.mockReturnValueOnce(task.promise);
    action(S.read);
    chooseAndRead();
    const signal = h.read.mock.calls[0][1] as AbortSignal;
    (review()!.props.onClose as () => void)();
    expect(signal.aborted).toBe(true);
    action(S.read);
    expect(review()?.props.pdfScopeRequired).toBe(true);
    if (late === "result") task.resolve(readValue);
    else task.reject(new Error("late obsolete error"));
    await task.promise.catch(() => {});
    await Promise.resolve();
    expect(review()?.props.result).toBeNull();
    expect(review()?.props.error).toBeNull();
    expect(review()?.props.pdfScopeSelected).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(1);
  },
);

it("retired PDF omission callback cannot select a successor result using the same result object", async () => {
  action(S.read);
  chooseAndRead();
  await vi.waitFor(() => expect(review()?.props.result).toBe(readValue));
  const oldConsent = review()!.props.onPartialSelected as (
    selected: boolean,
  ) => void;
  (review()!.props.onClose as () => void)();
  action(S.read);
  chooseAndRead();
  await vi.waitFor(() => expect(review()?.props.result).toBe(readValue));
  expect(review()?.props.partialSelected).toBe(false);
  oldConsent(true);
  expect(review()?.props.partialSelected).toBe(false);
  (review()!.props.onPartialSelected as (selected: boolean) => void)(true);
  expect(review()?.props.partialSelected).toBe(true);
});
it("current PDF omission callback cannot mutate consent after confirmation starts before rerender", async () => {
  action(S.read);
  chooseAndRead();
  await vi.waitFor(() => expect(review()?.props.result).toBe(readValue));
  (review()!.props.onPartialSelected as (selected: boolean) => void)(true);
  const node = review()!;
  const consent = node.props.onPartialSelected as (selected: boolean) => void;
  const deferredConfirm = deferred<typeof approved>();
  h.confirm.mockReturnValueOnce(deferredConfirm.promise);
  const confirmation = (node.props.onConfirm as () => Promise<void>)();
  consent(false);
  expect(review()?.props.partialSelected).toBe(true);
  deferredConfirm.resolve(approved);
  await confirmation;
});

it.each([
  "application/pdf",
  " APPLICATION/PDF ; charset=utf-8",
  "application/PDF;version=1.7",
  "Application/Pdf \t; x-test=value",
])(
  "new opaque-name PDF MIME %s requires an active range before read",
  (mimeType) => {
    const opaque = {
      ...original,
      name: "opaque-document",
      uri: "file:///owned/opaque-document",
      mimeType,
    };
    d.composerDrafts.update("new", (value) => ({
      ...value,
      attachments: [opaque],
    }));
    render();
    action(S.read);
    expect(h.read).not.toHaveBeenCalled();
    expect(review()?.props.pdfScopeRequired).toBe(true);
    expect(review()?.props.pdfScopeSelected).toBe(false);
    expect(review()?.props.partialSelected).toBe(false);
    expect(
      h.invoke.mock.calls.every(
        ([command]) => command === "settings_get" || command === "settings_set",
      ),
    ).toBe(true);
    (review()!.props.onClose as () => void)();
    expect(d.composerDrafts.read("new").attachments[0]).toBe(opaque);
  },
);
it.each([
  "application/pdf",
  " APPLICATION/PDF ; charset=utf-8",
  "application/PDF;version=1.7",
  "Application/Pdf \t; x-test=value",
])(
  "unknown opaque-name PDF MIME %s retains old text without acquiring consent or source",
  (mimeType) => {
    const opaque = {
      ...original,
      name: "opaque-document",
      uri: "file:///owned/opaque-document",
      mimeType,
      documentText: { text: "OPAQUE_UNKNOWN_TEXT", local: null },
    };
    d.composerDrafts.update("new", (value) => ({
      ...value,
      attachments: [opaque],
    }));
    render();
    action(S.reread);
    expect(h.read).not.toHaveBeenCalled();
    expect(review()?.props.pdfScopeRequired).toBe(true);
    expect(review()?.props.pdfScopeSelected).toBe(false);
    expect(review()?.props.previousText).toBe("OPAQUE_UNKNOWN_TEXT");
    expect(review()?.props.partialSelected).toBe(false);
    (review()!.props.onClose as () => void)();
    expect(d.composerDrafts.read("new").attachments[0]).toBe(opaque);
    expect(opaque.documentText.local).toBeNull();
  },
);

it("known PDF local metadata cannot read a different opaque URI before a fresh scope choice", () => {
  const changed = {
    ...original,
    name: "different-opaque",
    uri: "file:///owned/different-opaque",
    mimeType: "application/pdf",
    documentText: approved,
  };
  d.composerDrafts.update("new", (value) => ({
    ...value,
    attachments: [changed],
  }));
  render();
  action(S.reread);
  expect(h.read).not.toHaveBeenCalled();
  expect(review()?.props.pdfScopeRequired).toBe(true);
  expect(review()?.props.pdfScopeSelected).toBe(false);
  expect(review()?.props.previousText).toBe(approved.text);
  expect(
    h.invoke.mock.calls.every(
      ([command]) => command === "settings_get" || command === "settings_set",
    ),
  ).toBe(true);
  (review()!.props.onClose as () => void)();
  expect(d.composerDrafts.read("new").attachments[0]).toBe(changed);
  expect(changed.documentText).toBe(approved);
});
it("percent-encoded same PDF path reuses only its previously confirmed scope and fresh result consent", async () => {
  const same = {
    ...original,
    uri: "file:///owned/%72eport.pdf",
    documentText: approved,
  };
  d.composerDrafts.update("new", (value) => ({
    ...value,
    attachments: [same],
  }));
  render();
  action(S.reread);
  expect(h.read).toHaveBeenCalledOnce();
  expect(h.read.mock.calls[0][2]).toEqual({
    pdf: { mode: "decoded-page-text", includePossiblyInvisibleText: true },
  });
  await vi.waitFor(() => expect(review()?.props.result).toBe(readValue));
  expect(review()?.props.pdfScopeRequired).toBe(false);
  expect(review()?.props.partialSelected).toBe(false);
});
