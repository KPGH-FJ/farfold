import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
  inspectLink: vi.fn(),
  readText: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  copy: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: h.save }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: {
    inspectLink: h.inspectLink,
    readText: h.readText,
    open: h.open,
    reveal: h.reveal,
    copy: h.copy,
  },
}));
vi.mock("react", async (original) => {
  const effect = (callback: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++;
    const slot = h.slots[index];
    if (!slot || deps.some((value, i) => !Object.is(value, slot.deps?.[i])))
      h.effects.push(() => {
        slot?.cleanup?.();
        h.slots[index].cleanup = callback() || undefined;
      });
    h.slots[index] = { deps, cleanup: slot?.cleanup };
  };
  return {
    ...(await original<typeof import("react")>()),
    useState: (initial: unknown) => {
      const slot = (h.slots[h.cursor++] ??= {
        value:
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial,
      });
      return [
        slot.value,
        (next: unknown) => {
          slot.value =
            typeof next === "function"
              ? (next as (v: unknown) => unknown)(slot.value)
              : next;
        },
      ];
    },
    useRef: (initial: unknown) =>
      (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
    useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
    useEffect: effect,
    useLayoutEffect: effect,
  };
});

import { OpenedFileView, type OpenedFileViewProps } from "./OpenedFileView";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";
import { FILE_DELIVERY_STRINGS as D } from "../runtime/file_delivery_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { composerDrafts, fileFeedbackDrafts } from "../runtime/drafts";
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";

const receipt = {
  root: "/work",
  path: "/work/result.md",
  resolvedPath: "/work/result.md",
  name: "result.md",
  size: 10,
  sha256: "sha-a",
  version: "v1",
};
let props: OpenedFileViewProps;
type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      found.push(child, ...elements(child.props.children as ReactNode));
  });
  return found;
}
function render(next = props) {
  props = next;
  h.cursor = 0;
  const tree = OpenedFileView(next);
  for (const effect of h.effects.splice(0)) effect();
  return { nodes: elements(tree), html: renderToStaticMarkup(tree) };
}
function button(label: string) {
  return render().nodes.find(
    (node) => node.type === "button" && node.props.children === label,
  );
}
function click(label: string) {
  const found = button(label);
  expect(found, label).toBeDefined();
  (found!.props.onClick as () => void)();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function ready() {
  render();
  await vi.waitFor(() => expect(button(S.open)).toBeDefined());
}
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  for (const key of ["opened-file-test", "other-file-test"]) {
    for (const entry of Object.values(fileFeedbackDrafts.entries(key)))
      fileFeedbackDrafts.clear(key, entry.path);
    composerDrafts.clear(`session:${key}`);
  }
  h.slots.length = 0;
  h.effects.length = 0;
  h.cursor = 0;
  for (const mock of [
    h.inspectLink,
    h.readText,
    h.open,
    h.reveal,
    h.copy,
    h.save,
  ])
    mock.mockReset();
  h.inspectLink.mockResolvedValue(receipt);
  h.readText.mockResolvedValue({ file: receipt, text: "# Real disk content" });
  props = {
    threadKey: "opened-file-test",
    path: "result.md",
    workingDirectory: "/work",
    active: true,
    selectionKey: "task-a:1",
    onOpenHtml: vi.fn(),
  };
});

it("opens the exact clicked path through the common inspector and renders verified Markdown", async () => {
  await ready();
  expect(h.inspectLink).toHaveBeenCalledWith("/work", "result.md");
  expect(h.readText).toHaveBeenCalledWith(receipt);
  expect(render().html).toContain("<h1>Real disk content</h1>");
  expect(h.open).not.toHaveBeenCalled();
  expect(props.onOpenHtml).not.toHaveBeenCalled();
});

it.each([
  ["inspect", D.checkWaitExpired],
  ["inspect", D.checkBusy],
  ["read", D.checkWaitExpired],
  ["read", D.checkBusy],
])(
  "keeps the fixed recovery guidance when %s reports %s",
  async (stage, notice) => {
    const rejected = stage === "inspect" ? h.inspectLink : h.readText;
    rejected.mockRejectedValueOnce(notice);
    render();
    await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
    expect(render().html).toContain(notice);
    expect(render().html).not.toContain("Real disk content");
    expect(h.open).not.toHaveBeenCalled();
    expect(h.inspectLink).toHaveBeenCalledOnce();
  },
);

it("does not display arbitrary inspection errors as recovery guidance", async () => {
  h.inspectLink.mockRejectedValueOnce(new Error("private-path-and-secret"));
  render();
  await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
  expect(render().html).toContain(S.failed);
  expect(render().html).not.toContain("private-path-and-secret");
});

it("renders code and CSV as literal text instead of executing their contents", async () => {
  const file = { ...receipt, name: "result.csv" };
  h.inspectLink.mockResolvedValue(file);
  h.readText.mockResolvedValue({
    file,
    text: '<script>alert("x")</script>,value',
  });
  await ready();
  expect(render().html).toContain("&lt;script&gt;");
  expect(render().html).not.toContain("<script>");
});

it("does not load links, images or raw HTML from a Markdown file", async () => {
  h.readText.mockResolvedValue({
    file: receipt,
    text: "[remote](https://example.com) ![picture](https://example.com/p.png)\n<script>bad()</script>",
  });
  await ready();
  const html = render().html;
  expect(html).not.toContain('href="https:');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
});

it("hands verified HTML to the browser once and does not repeat after hide and return", async () => {
  const file = { ...receipt, name: "game.HTML" };
  h.inspectLink.mockResolvedValue(file);
  render();
  await vi.waitFor(() => expect(props.onOpenHtml).toHaveBeenCalledWith(file));
  const active = props;
  render({ ...active, active: false });
  render(active);
  await drain();
  expect(active.onOpenHtml).toHaveBeenCalledOnce();
  expect(h.readText).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  click(S.openHtml);
  await vi.waitFor(() => expect(active.onOpenHtml).toHaveBeenCalledTimes(2));
  expect(h.inspectLink).toHaveBeenCalledTimes(2);
});

it("does not automatically launch another application for binary or executable files", async () => {
  const file = { ...receipt, name: "program.bin" };
  h.inspectLink.mockResolvedValue(file);
  await ready();
  expect(render().html).toContain(S.other);
  expect(h.readText).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
  click(S.open);
  await vi.waitFor(() => expect(h.open).toHaveBeenCalledWith(file));
  await vi.waitFor(() => expect(render().html).toContain(S.opened));
});

it("offers manual delivery for a text file above the reader limit", async () => {
  h.inspectLink.mockResolvedValue({ ...receipt, size: 1024 * 1024 + 1 });
  await ready();
  expect(render().html).toContain(S.large);
  expect(h.readText).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
});

it("keeps the original path and retries after inspection failure", async () => {
  h.inspectLink.mockRejectedValueOnce(new Error("sensitive backend details"));
  render();
  await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
  expect(render().html).toContain("result.md");
  expect(render().html).not.toContain("sensitive backend details");
  expect(button(S.open)).toBeUndefined();
  click(S.retry);
  await vi.waitFor(() => expect(button(S.open)).toBeDefined());
  expect(h.inspectLink).toHaveBeenCalledTimes(2);
});

it.each(["read failure", "changed version"])(
  "invalidates the receipt on %s",
  async (mode) => {
    if (mode === "read failure")
      h.readText.mockRejectedValueOnce(new Error("changed"));
    else
      h.readText.mockResolvedValueOnce({
        file: { ...receipt, version: "v2" },
        text: "must not display",
      });
    render();
    await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
    expect(button(S.open)).toBeUndefined();
    expect(render().html).not.toContain("must not display");
    expect(h.open).not.toHaveBeenCalled();
  },
);

it("discards HTML inspection completed after hiding, with explicit retry on return", async () => {
  const pending = deferred<typeof receipt>();
  h.inspectLink.mockReturnValueOnce(pending.promise);
  render();
  const active = props;
  render({ ...active, active: false });
  render(active);
  pending.resolve({ ...receipt, name: "game.html" });
  await drain();
  expect(active.onOpenHtml).not.toHaveBeenCalled();
  expect(h.inspectLink).toHaveBeenCalledOnce();
  expect(button(S.retry)).toBeDefined();
});

it("never revives the old inspection after A to B to A selection changes", async () => {
  const old = deferred<typeof receipt>();
  const newer = deferred<typeof receipt>();
  h.inspectLink
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(newer.promise);
  render();
  const a = props;
  render({ ...a, selectionKey: "task-b:1", active: false });
  render({ ...a, selectionKey: "task-a:2" });
  old.resolve({ ...receipt, name: "old.html" });
  await drain();
  expect(a.onOpenHtml).not.toHaveBeenCalled();
  expect(render().html).toContain(S.loading);
  newer.resolve({ ...receipt, name: "new.html" });
  await vi.waitFor(() =>
    expect(a.onOpenHtml).toHaveBeenCalledWith(
      expect.objectContaining({ name: "new.html" }),
    ),
  );
  expect(a.onOpenHtml).toHaveBeenCalledOnce();
});

it("does not inspect or open an initially inactive selection", async () => {
  render({ ...props, active: false });
  const active = { ...props, active: true };
  render(active);
  await drain();
  expect(h.inspectLink).not.toHaveBeenCalled();
  expect(button(S.retry)).toBeDefined();
});

it("discards a delayed text result on unmount", async () => {
  const text = deferred<{ file: typeof receipt; text: string }>();
  h.readText.mockReturnValueOnce(text.promise);
  render();
  await vi.waitFor(() => expect(h.readText).toHaveBeenCalledOnce());
  for (const slot of h.slots) slot.cleanup?.();
  text.resolve({ file: receipt, text: "late private text" });
  await drain();
  expect(props.onOpenHtml).not.toHaveBeenCalled();
  expect(render().html).not.toContain("late private text");
});

it("copies only after explicit destination selection and passes the exact receipt", async () => {
  await ready();
  h.save.mockResolvedValue("/out/copy.md");
  click(S.save);
  await vi.waitFor(() =>
    expect(h.copy).toHaveBeenCalledWith(receipt, "/out/copy.md"),
  );
  expect(h.save).toHaveBeenCalledWith({
    title: S.saveTitle,
    defaultPath: "result.md",
  });
  expect(render().html).toContain(S.saved);
});

it("never copies after the destination picker returns to a hidden view", async () => {
  await ready();
  const destination = deferred<string | null>();
  h.save.mockReturnValueOnce(destination.promise);
  click(S.save);
  const active = props;
  render({ ...active, active: false });
  render(active);
  destination.resolve("/out/copy.md");
  await drain();
  expect(h.copy).not.toHaveBeenCalled();
  expect(button(S.retry)).toBeDefined();
});

it("invalidates displayed text and file actions after a delivery failure", async () => {
  await ready();
  h.reveal.mockRejectedValueOnce(new Error("file changed"));
  click(S.reveal);
  await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
  expect(render().html).not.toContain("Real disk content");
  expect(button(S.open)).toBeUndefined();
});

it("retains a completed text view across hiding without automatically reading it again", async () => {
  await ready();
  const active = props;
  render({ ...active, active: false });
  render(active);
  await drain();
  expect(render().html).toContain("Real disk content");
  expect(h.readText).toHaveBeenCalledOnce();
});

function editFeedback(text: string) {
  if (!render().nodes.some((node) => node.type === "textarea"))
    click(S.feedback);
  const field = render().nodes.find((node) => node.type === "textarea")!;
  expect(field).toBeDefined();
  (field.props.onChange as (event: unknown) => void)({
    target: { value: text },
  });
}
function feedbackForm() {
  return render().nodes.find((node) => node.type === "form")!;
}
function submitFeedback(form = feedbackForm()) {
  expect(form).toBeDefined();
  (form.props.onSubmit as (event: unknown) => void)({
    preventDefault: () => {},
  });
}

it("explicitly rereads the disk file and replaces the displayed version without launching anything", async () => {
  await ready();
  const next = { ...receipt, version: "v2", sha256: "sha-b" };
  h.inspectLink.mockResolvedValueOnce(next);
  h.readText.mockResolvedValueOnce({ file: next, text: "# New disk content" });
  click(S.refresh);
  expect(render().html).not.toContain("Real disk content");
  await vi.waitFor(() => expect(render().html).toContain("New disk content"));
  expect(h.inspectLink).toHaveBeenCalledTimes(2);
  expect(h.readText).toHaveBeenLastCalledWith(next);
  expect(h.open).not.toHaveBeenCalled();
  expect(props.onOpenHtml).not.toHaveBeenCalled();
});

it("appends whole-file feedback once to the original composer and preserves its send protections", async () => {
  await ready();
  const original = {
    text: "Original input",
    attachments: [
      { id: "attachment", name: "notes.txt", kind: "file" as const },
    ],
    sendPending: true,
    queueEdit: {
      index: 2,
      original: [{ type: "text" as const, text: "Queued" }],
    },
  };
  composerDrafts.update("session:opened-file-test", () => original);
  editFeedback("Please clarify the conclusion.");
  const entries = Object.values(fileFeedbackDrafts.entries(props.threadKey));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    path: receipt.resolvedPath,
    selection: null,
    scope: "file",
    contentId: `disk:${JSON.stringify([receipt.resolvedPath, receipt.version, receipt.sha256])}`,
  });
  const form = feedbackForm();
  submitFeedback(form);
  const composed = composerDrafts.read("session:opened-file-test");
  expect(composed).toEqual({
    ...original,
    text: `Original input\n\n关于 ${receipt.resolvedPath}（当时查看的内容）：\nPlease clarify the conclusion.`,
  });
  expect(composerDrafts.read("session:other-file-test").text).toBe("");
  expect(
    Object.values(fileFeedbackDrafts.entries(props.threadKey)),
  ).toHaveLength(0);
  submitFeedback(form);
  expect(composerDrafts.read("session:opened-file-test")).toBe(composed);
  // A completion for an earlier send cannot erase the newly appended feedback.
  composerDrafts.clearIfUnchanged("session:opened-file-test", original);
  expect(composerDrafts.read("session:opened-file-test")).toBe(composed);
  expect(render().html).toContain(W.feedbackAdded);
  expect(h.inspectLink).toHaveBeenCalledOnce();
  expect(h.readText).toHaveBeenCalledOnce();
  expect(h.open).not.toHaveBeenCalled();
});

it("keeps the earlier version's opinion separate after a refresh and exposes the existing saved-draft control", async () => {
  await ready();
  editFeedback("Opinion for version one");
  const first = Object.values(fileFeedbackDrafts.entries(props.threadKey))[0];
  const next = { ...receipt, version: "v2", sha256: "sha-b" };
  h.inspectLink.mockResolvedValueOnce(next);
  h.readText.mockResolvedValueOnce({ file: next, text: "# Version two" });
  click(S.refresh);
  await vi.waitFor(() => expect(render().html).toContain("Version two"));
  expect(render().nodes.some((node) => node.type === "textarea")).toBe(false);
  const saved = render().nodes.find(
    (node) => node.type === FileFeedbackDrafts,
  )!;
  expect(saved.props).toMatchObject({
    threadKey: props.threadKey,
    path: receipt.resolvedPath,
  });
  expect(saved.props.excludeContentId).not.toBe(first.contentId);
  expect(render().html).toContain("Opinion for version one");
  editFeedback("Opinion for version two");
  const both = Object.values(fileFeedbackDrafts.entries(props.threadKey));
  expect(both).toHaveLength(2);
  expect(both.map((entry) => entry.contentId)).toEqual([
    first.contentId,
    `disk:${JSON.stringify([next.resolvedPath, next.version, next.sha256])}`,
  ]);
  submitFeedback();
  expect(composerDrafts.read(`session:${props.threadKey}`).text).toContain(
    "Opinion for version two",
  );
  expect(composerDrafts.read(`session:${props.threadKey}`).text).not.toContain(
    "Opinion for version one",
  );
  expect(Object.values(fileFeedbackDrafts.entries(props.threadKey))).toEqual([
    first,
  ]);
});

it("restores the same unsent opinion after rereading the unchanged version", async () => {
  await ready();
  editFeedback("Still editing");
  click(S.refresh);
  await vi.waitFor(() => expect(h.readText).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(
      render().nodes.find((node) => node.type === "textarea")?.props.value,
    ).toBe("Still editing"),
  );
  expect(
    Object.values(fileFeedbackDrafts.entries(props.threadKey)),
  ).toHaveLength(1);
  expect(composerDrafts.read(`session:${props.threadKey}`).text).toBe("");
});

it.each([
  "hidden",
  "task changed",
  "unmounted",
  "refreshing",
  "refresh failed",
  "new version",
])(
  "rejects a stale feedback form or editor when %s without losing the original opinion",
  async (mode) => {
    await ready();
    editFeedback("Retained opinion");
    const originalKey = props.threadKey;
    const form = feedbackForm();
    const field = render().nodes.find((node) => node.type === "textarea")!;
    if (mode === "hidden") render({ ...props, active: false });
    if (mode === "task changed")
      render({ ...props, threadKey: "other-file-test" });
    if (mode === "unmounted") for (const slot of h.slots) slot.cleanup?.();
    if (mode === "refreshing") {
      h.inspectLink.mockReturnValueOnce(deferred<typeof receipt>().promise);
      click(S.refresh);
    }
    if (mode === "refresh failed") {
      h.inspectLink.mockRejectedValueOnce(new Error("Changed file"));
      click(S.refresh);
      await vi.waitFor(() => expect(button(S.retry)).toBeDefined());
      expect(render().html).not.toContain("Real disk content");
    }
    if (mode === "new version") {
      const next = { ...receipt, version: "v2", sha256: "sha-b" };
      h.inspectLink.mockResolvedValueOnce(next);
      h.readText.mockResolvedValueOnce({ file: next, text: "New version" });
      click(S.refresh);
      await vi.waitFor(() => expect(render().html).toContain("New version"));
    }
    (field.props.onChange as (event: unknown) => void)({
      target: { value: "Late replacement" },
    });
    submitFeedback(form);
    expect(composerDrafts.read(`session:${originalKey}`).text).toBe("");
    expect(composerDrafts.read("session:other-file-test").text).toBe("");
    expect(
      Object.values(fileFeedbackDrafts.entries(originalKey)).map(
        (entry) => entry.text,
      ),
    ).toEqual(["Retained opinion"]);
  },
);

it.each(["project.html", "archive.zip"])(
  "keeps text-feedback and reread controls out of %s delivery",
  async (name) => {
    h.inspectLink.mockResolvedValue({ ...receipt, name });
    await ready();
    expect(button(S.refresh)).toBeUndefined();
    expect(button(S.feedback)).toBeUndefined();
    expect(Boolean(button(S.openHtml))).toBe(name.endsWith(".html"));
  },
);

it("does not move a blank opinion into the composer even if the form is submitted directly", async () => {
  await ready();
  editFeedback("   ");
  submitFeedback();
  expect(composerDrafts.read(`session:${props.threadKey}`).text).toBe("");
  expect(
    Object.values(fileFeedbackDrafts.entries(props.threadKey))[0].text,
  ).toBe("   ");
});
