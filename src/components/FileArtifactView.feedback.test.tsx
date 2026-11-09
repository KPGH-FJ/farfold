import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
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
            ? (next as (v: unknown) => unknown)(slot.value)
            : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useMemo: (read: () => unknown, deps: unknown[]) => {
    const i = h.cursor++;
    const cached = h.slots[i];
    if (cached && deps.every((value, j) => Object.is(value, cached.deps?.[j])))
      return cached.value;
    const value = read();
    h.slots[i] = { value, deps };
    return value;
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const i = h.cursor++;
    const slot = h.slots[i];
    if (
      !slot ||
      deps.some((value, index) => !Object.is(value, slot.deps?.[index]))
    )
      h.effects.push(() => {
        slot?.cleanup?.();
        h.slots[i].cleanup = effect() || undefined;
      });
    h.slots[i] = { deps, cleanup: slot?.cleanup };
  },
}));
import { FileArtifactView, FileDifference } from "./FileArtifactView";
import {
  FileFeedbackDrafts,
  UnavailableOwnerFileFeedback,
} from "./FileFeedbackDrafts";
import {
  composerDrafts,
  fileFeedbackDrafts,
  type FileFeedbackDestination,
} from "../runtime/drafts";
import { FEEDBACK_STRINGS } from "../runtime/feedback_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { artifactFiles, type FileArtifact } from "../runtime/artifact_view";
import { paneCards } from "../runtime/artifacts";
import { applyUpdate, freshThreadState } from "../runtime/session_projection";

const key = "feedback-test";
const card = (version: string): FileArtifact => ({
  kind: "diff",
  path: "/p/shared.ts",
  oldText: null,
  newText: `first line\n${version}`,
  scope: "file",
  source: "diff",
  status: "completed",
  time: 0,
});
type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode) {
  const result: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      result.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return result;
}
let destination: FileFeedbackDestination | undefined;
const digest = crypto.subtle.digest.bind(crypto.subtle);
const pendingDigests: Promise<ArrayBuffer>[] = [];
function render(value: FileArtifact, active = true) {
  h.cursor = 0;
  FileArtifactView({
    card: value,
    threadKey: key,
    feedbackDestination: destination,
    active,
  });
  for (const effect of h.effects.splice(0)) effect();
  h.cursor = 0;
  return elements(
    FileArtifactView({
      card: value,
      threadKey: key,
      feedbackDestination: destination,
      active,
    }),
  );
}
async function openVersion(value: FileArtifact, active = true) {
  render(value, active);
  await Promise.allSettled(pendingDigests.splice(0));
  return render(value, active);
}
async function write(
  value: FileArtifact,
  text: string,
  side: "before" | "after" = "after",
) {
  const difference = (await openVersion(value)).find(
    (node) => node.type === FileDifference,
  )!;
  (difference.props.onLine as (selection: unknown) => void)({
    line: value.scope === "file" ? 2 : 1,
    side,
  });
  const field = render(value).find((node) => node.type === "textarea")!;
  (field.props.onChange as (event: unknown) => void)({
    target: { value: text },
  });
}
async function submit(value: FileArtifact) {
  const form = (await openVersion(value)).find((node) => node.type === "form")!;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
}
beforeEach(() => {
  destination = undefined;
  h.slots.length = 0;
  h.effects.length = 0;
  h.cursor = 0;
  h.invoke.mockReset();
  pendingDigests.length = 0;
  vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, bytes) => {
    const pending = digest(algorithm, bytes);
    pendingDigests.push(pending);
    return pending;
  });
  for (const entry of Object.values(fileFeedbackDrafts.entries(key)))
    fileFeedbackDrafts.clear(key, entry.path);
  composerDrafts.clear(`session:${key}`);
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the opinions and line selections for distinct reported contents with colliding old IDs separate", async () => {
  const a = {
    ...card(""),
    newText: "1wke6xf\n0bg7ped",
    scope: "fragment" as const,
  };
  const b = { ...a, newText: "1so3nhg\n0pi62mv" };
  const legacy = {
    contentId: "physical-lines-v1:missing:15:2703727690",
    text: "PRESERVED OLD OPINION",
    selection: { side: "after" as const, line: 2 },
    scope: "fragment" as const,
  };
  fileFeedbackDrafts.update(key, a.path, legacy);
  const first = await openVersion(a);
  expect(
    first.find((node) => node.type === FileDifference)?.props.selection,
  ).toBeNull();
  expect(
    first.find((node) => node.type === FileFeedbackDrafts)?.props
      .excludeContentId,
  ).not.toBe(legacy.contentId);
  await write(a, "A OPINION");
  const original = structuredClone(fileFeedbackDrafts.entries(key));
  const different = await openVersion(b);
  expect(
    different.find((node) => node.type === FileDifference)?.props.selection,
  ).toBeNull();
  expect(different.some((node) => node.type === "textarea")).toBe(false);
  await write(b, "B OPINION");
  expect(fileFeedbackDrafts.entries(key)).toMatchObject(original);
  expect(
    Object.values(fileFeedbackDrafts.entries(key)).map((entry) => entry.text),
  ).toEqual(["PRESERVED OLD OPINION", "A OPINION", "B OPINION"]);
});

it("does not collapse the source, coordinate scope or exact JS string of a report", async () => {
  const report = card("\ud800");
  await write(report, "DIFF");
  await write({ ...report, source: "write-input" }, "PROPOSAL");
  await write({ ...report, scope: "fragment" }, "FRAGMENT");
  await write(
    { ...report, newText: "first line\n\ufffd" },
    "REPLACEMENT CHARACTER",
  );
  expect(
    Object.values(fileFeedbackDrafts.entries(key)).map((entry) => entry.text),
  ).toEqual(["DIFF", "PROPOSAL", "FRAGMENT", "REPLACEMENT CHARACTER"]);
});

it("disables feedback when identity verification fails and leaves saved content intact", async () => {
  const a = card("VERIFIED");
  await write(a, "SAVED OPINION");
  const original = structuredClone(fileFeedbackDrafts.entries(key));
  vi.mocked(crypto.subtle.digest).mockImplementationOnce(() => {
    const pending = Promise.reject(new Error("digest unavailable"));
    pendingDigests.push(pending);
    return pending;
  });
  const failed = await openVersion(card("UNVERIFIED"));
  expect(
    failed.find((node) => node.props["aria-label"] === W.feedbackOpen)?.props
      .disabled,
  ).toBe(true);
  expect(
    failed.find((node) => node.type === FileDifference)?.props.onLine,
  ).toBeUndefined();
  expect(failed.some((node) => node.type === "textarea")).toBe(false);
  expect(
    failed.some(
      (node) => node.props.children === FEEDBACK_STRINGS.reportUnavailable,
    ),
  ).toBe(true);
  expect(fileFeedbackDrafts.entries(key)).toEqual(original);
  expect(composerDrafts.read(`session:${key}`).text).toBe("");
});

it("retires old digest results and feedback callbacks across content and visibility changes", async () => {
  const a = card("A");
  await write(a, "A OPINION");
  const original = structuredClone(fileFeedbackDrafts.entries(key));
  const first = render(a);
  const oldTextChange = first.find((node) => node.type === "textarea")!.props
    .onChange as (event: unknown) => void;
  let resolve!: (hash: ArrayBuffer) => void;
  const late = new Promise<ArrayBuffer>((done) => {
    resolve = done;
  });
  let finish!: () => Promise<void>;
  vi.mocked(crypto.subtle.digest).mockImplementationOnce((algorithm, bytes) => {
    finish = async () => {
      resolve(await digest(algorithm, bytes));
    };
    return late;
  });
  const checking = render(card("B"));
  expect(
    checking.find((node) => node.props["aria-label"] === W.feedbackOpen)?.props
      .disabled,
  ).toBe(true);
  expect(
    checking.find((node) => node.type === FileDifference)?.props.onLine,
  ).toBeUndefined();
  const returned = await openVersion(a);
  const oldSubmit = returned.find((node) => node.type === "form")!.props
    .onSubmit as (event: unknown) => void;
  oldTextChange({ target: { value: "STALE TEXT" } });
  await finish();
  await late;
  expect(render(a).find((node) => node.type === "textarea")?.props.value).toBe(
    "A OPINION",
  );
  render(a, false);
  oldSubmit({ preventDefault() {} });
  await openVersion(a);
  oldSubmit({ preventDefault() {} });
  expect(fileFeedbackDrafts.entries(key)).toEqual(original);
  expect(composerDrafts.read(`session:${key}`).text).toBe("");
});

it("does not reuse missing-original opinions for a known empty original", async () => {
  const missing = { ...card("same"), scope: "fragment" as const };
  await write(missing, "MISSING SOURCE OPINION");
  const first = structuredClone(
    Object.values(fileFeedbackDrafts.entries(key))[0],
  );
  const known = { ...missing, oldText: "" };
  await write(known, "KNOWN EMPTY OPINION");
  const entries = Object.values(fileFeedbackDrafts.entries(key));
  expect(entries).toHaveLength(2);
  expect(entries.find((e) => e.contentId === first.contentId)).toEqual(first);
  expect(new Set(entries.map((e) => e.contentId)).size).toBe(2);
  expect(
    entries.every((e) => e.contentId?.startsWith("reported-sha256-v1:")),
  ).toBe(true);
});

it("retains legacy trailing-row opinions without treating them as current coordinates", async () => {
  const value = {
    ...card(""),
    oldText: "before\n",
    newText: "after\n",
    scope: "fragment" as const,
  };
  const originalId = "legacy-row-coordinate";
  fileFeedbackDrafts.update(key, value.path, {
    contentId: originalId,
    scope: "fragment",
    text: "KEEP LEGACY",
    selection: { side: "after", line: 2 },
  });
  const saved = structuredClone(fileFeedbackDrafts.entries(key));
  const tree = await openVersion(value);
  expect(
    tree.find((n) => n.type === FileDifference)?.props.selection,
  ).toBeNull();
  expect(
    tree.find((n) => n.type === FileFeedbackDrafts)?.props.excludeContentId,
  ).not.toBe(originalId);
  expect(fileFeedbackDrafts.entries(key)).toEqual(saved);
  await write(value, "CURRENT");
  await changeField(value, W.feedbackLine, "2");
  expect(
    render(value).find((n) => n.props["aria-label"] === W.feedbackLine)?.props[
      "aria-invalid"
    ],
  ).toBe(true);
  await changeField(value, W.feedbackLine, "1");
  expect(
    render(value).find((n) => n.props["aria-label"] === W.feedbackLine)?.props[
      "aria-invalid"
    ],
  ).toBe(false);
  expect(
    Object.values(fileFeedbackDrafts.entries(key)).some(
      (e) => e.contentId === originalId && e.text === "KEEP LEGACY",
    ),
  ).toBe(true);
});

it("copies both raw sides with their exact terminators while diff copy explains ending changes", async () => {
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal("navigator", { clipboard });
  const value = {
    ...card(""),
    oldText: "a\r\n",
    newText: "a",
    scope: "fragment" as const,
  };
  const click = async (label: string) => {
    const button = render(value).find((n) => n.props["aria-label"] === label)!;
    await (button.props.onClick as () => Promise<void>)();
  };
  await click(W.copyDiff);
  const diff = clipboard.writeText.mock.calls.at(-1)![0] as string;
  expect(diff).toContain("正文相同");
  expect(diff).toContain("CRLF");
  expect(diff).toContain("没有行末换行");
  await changeField(value, W.viewMode, "before");
  await click(W.copyFragment);
  expect(clipboard.writeText).toHaveBeenLastCalledWith("a\r\n");
  await changeField(value, W.viewMode, "after");
  await click(W.copyFragment);
  expect(clipboard.writeText).toHaveBeenLastCalledWith("a");
  expect(h.invoke).not.toHaveBeenCalled();
});

async function changeField(value: FileArtifact, label: string, text: string) {
  const field = (await openVersion(value)).find(
    (node) => node.props["aria-label"] === label,
  )!;
  (field.props.onChange as (event: unknown) => void)({
    target: { value: text },
  });
}

it("retains manually entered fragment ranges by content version and adds only that exact opinion", async () => {
  const value = { ...card("line two\nline three"), scope: "fragment" as const };
  await write(value, "RANGE OPINION");
  await changeField(value, W.feedbackLine, "1–3");
  expect(Object.values(fileFeedbackDrafts.entries(key))[0]).toMatchObject({
    text: "RANGE OPINION",
    scope: "fragment",
    selection: { side: "after", line: 1, endLine: 3 },
  });
  const other = card("ANOTHER VERSION");
  await write(other, "KEEP OTHER OPINION");
  expect(
    (await openVersion(value)).find(
      (node) => node.props["aria-label"] === W.feedbackLine,
    )?.props.value,
  ).toBe("1–3");
  await submit(value);
  expect(composerDrafts.read(`session:${key}`).text).toBe(
    "关于 /p/shared.ts（当时查看的内容，修改后片段第 1–3 行）：\nRANGE OPINION",
  );
  expect(Object.values(fileFeedbackDrafts.entries(key))).toEqual([
    expect.objectContaining({
      text: "KEEP OTHER OPINION",
      selection: { side: "after", line: 2 },
    }),
  ]);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("keeps invalid raw locations, blocks out-of-fragment ranges and still permits selecting a real line", async () => {
  const value = { ...card("second"), scope: "fragment" as const };
  await write(value, "KEEP TEXT");
  await changeField(value, W.feedbackLine, "8–12");
  let tree = render(value);
  expect(
    tree.find((node) => node.props["aria-label"] === W.feedbackLine)?.props[
      "aria-invalid"
    ],
  ).toBe(true);
  expect(
    tree.find((node) => node.props.type === "submit")?.props.disabled,
  ).toBe(true);
  await submit(value);
  expect(composerDrafts.read(`session:${key}`).text).toBe("");
  expect(Object.values(fileFeedbackDrafts.entries(key))[0]).toMatchObject({
    text: "KEEP TEXT",
    lineInput: { side: "after", text: "8–12" },
    selection: null,
  });
  render(card("OTHER"));
  expect(
    (await openVersion(value)).find(
      (node) => node.props["aria-label"] === W.feedbackLine,
    )?.props.value,
  ).toBe("8–12");
  const difference = render(value).find(
    (node) => node.type === FileDifference,
  )!;
  (difference.props.onLine as (selection: unknown) => void)({
    side: "after",
    line: 2,
  });
  tree = render(value);
  expect(
    tree.find((node) => node.props["aria-label"] === W.feedbackLine)?.props
      .value,
  ).toBe("2");
  expect(
    tree.find((node) => node.props.type === "submit")?.props.disabled,
  ).toBe(false);
  expect(tree.find((node) => node.type === "textarea")?.props.value).toBe(
    "KEEP TEXT",
  );
});

it("offers manual original-side ranges in document reading mode without inventing full-file coordinates", async () => {
  const value = {
    ...card("new\nlast"),
    path: "/p/note.md",
    oldText: "old\nsecond\nlast",
    scope: "fragment" as const,
  };
  await changeField(value, W.viewMode, "read-before");
  const open = render(value).find(
    (node) => node.props["aria-label"] === W.feedbackOpen,
  )!;
  (open.props.onClick as () => void)();
  await changeField(value, W.feedbackLine, "2-3");
  await changeField(value, W.feedbackLabel, "ORIGINAL RANGE");
  await submit(value);
  expect(composerDrafts.read(`session:${key}`).text).toContain(
    "修改前片段第 2–3 行",
  );
});

it("copies only the shown diff, full reported path, or selected side without changing feedback", async () => {
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal("navigator", { clipboard });
  const value = {
    ...card("same\nnew"),
    oldText: "same\nold",
    newText: "same\nnew",
    scope: "fragment" as const,
  };
  await write(value, "UNCHANGED OPINION");
  const saved = structuredClone(fileFeedbackDrafts.entries(key));
  const click = async (label: string) => {
    const button = render(value).find(
      (node) => node.props["aria-label"] === label,
    )!;
    await (button.props.onClick as () => Promise<void>)();
  };
  await click(W.copyDiff);
  expect(clipboard.writeText).toHaveBeenLastCalledWith(
    "所示片段 · 新增 1 行、删除 1 行\n same\n-old\n+new",
  );
  await click(W.copyPath);
  expect(clipboard.writeText).toHaveBeenLastCalledWith("/p/shared.ts");
  await changeField(value, W.viewMode, "before");
  await click(W.copyFragment);
  expect(clipboard.writeText).toHaveBeenLastCalledWith("same\nold");
  expect(fileFeedbackDrafts.entries(key)).toEqual(saved);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("reports clipboard failure and ignores copy results after changing the reported content", async () => {
  let finish!: () => void;
  const clipboard = {
    writeText: vi.fn().mockRejectedValueOnce(new Error("denied")),
  };
  vi.stubGlobal("navigator", { clipboard });
  const value = card("FIRST");
  const button = () =>
    render(value).find((node) => node.props["aria-label"] === W.copyPath)!;
  await (button().props.onClick as () => Promise<void>)();
  expect(
    render(value).some((node) => node.props.children === W.copyFailed),
  ).toBe(true);
  clipboard.writeText.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = (button().props.onClick as () => Promise<void>)();
  const later = card("NEXT");
  render(later);
  finish();
  await pending;
  expect(render(later).some((node) => node.props.children === W.copied)).toBe(
    false,
  );
  expect(
    render(later).find((node) => node.props["aria-label"] === W.copyPath),
  ).toBeDefined();
});

it("keeps distinct opinions and locations through editing older content and returning", async () => {
  const newer = card("CURRENT-V5");
  const older = card("OLDER-V1");
  await write(newer, "NEW OPINION");
  const original = structuredClone(fileFeedbackDrafts.entries(key));
  expect(
    (await openVersion(older)).some((node) => node.type === "textarea"),
  ).toBe(false);
  expect(fileFeedbackDrafts.entries(key)).toEqual(original);
  await write(older, "OLD OPINION");
  expect(
    Object.values(fileFeedbackDrafts.entries(key)).map((entry) => entry.text),
  ).toEqual(["NEW OPINION", "OLD OPINION"]);
  const returning = await openVersion(newer);
  expect(returning.find((node) => node.type === "textarea")?.props.value).toBe(
    "NEW OPINION",
  );
  expect(
    returning.some(
      (node) =>
        node.type === "span" && node.props.children === "修改后 · 第 2 行",
    ),
  ).toBe(true);
  expect(composerDrafts.read(`session:${key}`).text).toBe("");
});

it("moves only the explicitly reviewed version, preserving other feedback and existing input", async () => {
  const newer = card("CURRENT-V5");
  const older = card("OLDER-V1");
  composerDrafts.update(`session:${key}`, () => ({
    text: "EXISTING INPUT",
    attachments: [],
  }));
  await write(newer, "NEW OPINION");
  await write(older, "OLD OPINION");
  await submit(older);
  expect(composerDrafts.read(`session:${key}`).text).toBe(
    "EXISTING INPUT\n\n关于 /p/shared.ts（当时查看的内容，修改后第 2 行）：\nOLD OPINION",
  );
  expect(Object.values(fileFeedbackDrafts.entries(key))).toEqual([
    expect.objectContaining({
      text: "NEW OPINION",
      selection: { side: "after", line: 2 },
    }),
  ]);
  expect(
    (await openVersion(newer)).find((node) => node.type === "textarea")?.props
      .value,
  ).toBe("NEW OPINION");
  expect(h.invoke).not.toHaveBeenCalled();
});

it("recovers feedback without an artifact and labels legacy line coordinates as unverified", () => {
  fileFeedbackDrafts.update(key, "/missing.md", {
    text: "RETAINED",
    selection: { side: "after", line: 7 },
  });
  h.cursor = 0;
  const tree = elements(FileFeedbackDrafts({ threadKey: key }));
  expect(
    tree.some(
      (node) =>
        node.type === "pre" &&
        String(node.props.children).includes("位置未重新核对"),
    ),
  ).toBe(true);
  const add = tree.find(
    (node) =>
      node.type === "button" && node.props.children === FEEDBACK_STRINGS.add,
  )!;
  (add.props.onClick as () => void)();
  expect(composerDrafts.read(`session:${key}`).text).toContain("RETAINED");
  expect(fileFeedbackDrafts.entries(key)).toEqual({});
  expect(h.invoke).not.toHaveBeenCalled();
});

it("copies only the presented unavailable-owner opinion and preserves its original draft", async () => {
  const path = "/p/retired.md";
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  fileFeedbackDrafts.update(key, path, { text: "ORIGINAL", selection: null });
  const original = fileFeedbackDrafts.entries(key);
  const currentDraft = composerDrafts.read("new");
  const entries = fileFeedbackDrafts.withoutAvailableOwner(new Set());
  const buttons = elements(UnavailableOwnerFileFeedback({ entries })).filter(
    (node) => node.type === "button",
  );
  expect(buttons).toHaveLength(1);
  expect(buttons[0].props.children).toBe(FEEDBACK_STRINGS.copy);
  const click = buttons[0].props.onClick as () => Promise<void>;
  await click();
  expect(copy).toHaveBeenCalledWith(expect.stringContaining("ORIGINAL"));
  expect(fileFeedbackDrafts.entries(key)).toBe(original);
  expect(composerDrafts.read("new")).toBe(currentDraft);
  expect(composerDrafts.read(`session:${key}`).text).toBe("");
  fileFeedbackDrafts.update(key, path, { text: "CHANGED", selection: null });
  await click();
  expect(copy).toHaveBeenCalledTimes(1);
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each(["before", "after"] as const)(
  "retains official fragment scope for %s-line feedback",
  async (side) => {
    const thread = freshThreadState("fixture:/p:diff", "fixture", "/p", "diff");
    applyUpdate(thread, {
      sessionUpdate: "tool_call",
      toolCallId: "replace",
      kind: "edit",
      status: "completed",
      rawInput: { filePath: "/p/note.md", oldString: "V6A", newString: "V6B" },
      content: [
        { type: "diff", path: "/p/note.md", oldText: "V6A", newText: "V6B" },
      ],
    });
    const value = artifactFiles(paneCards(thread))[0];
    await write(value, "FRAGMENT OPINION", side);
    await submit(value);
    expect(composerDrafts.read(`session:${key}`).text).toBe(
      `关于 /p/note.md（当时查看的内容，${side === "before" ? "修改前" : "修改后"}片段第 1 行）：\nFRAGMENT OPINION`,
    );
  },
);

it("artifact and historical file opinions join only the explicitly visible input and rejected routes retain opinions", async () => {
  composerDrafts.clear("new");
  let current = true;
  destination = { threadKey: key, draftKey: "new", isCurrent: () => current };
  const value = card("visible-route");
  await write(value, "EXACT ROUTED OPINION");
  const nested = render(value).find(
    (node) => node.type === FileFeedbackDrafts,
  )!;
  expect(nested.props.feedbackDestination).toBe(destination);
  current = false;
  await submit(value);
  expect(Object.values(fileFeedbackDrafts.entries(key))).toHaveLength(1);
  expect(composerDrafts.read("new").text).toBe("");
  current = true;
  await submit(value);
  expect(composerDrafts.read("new").text).toContain("EXACT ROUTED OPINION");
  expect(composerDrafts.read(`session:${key}`).text).toBe("");
  expect(fileFeedbackDrafts.entries(key)).toEqual({});
});
it("the shared retained-opinion button uses its explicit destination and rejection never consumes the original", () => {
  composerDrafts.clear("new");
  fileFeedbackDrafts.update(key, "/old.md", {
    text: "RETAINED ROUTE",
    selection: null,
  });
  let current = false;
  const feedbackDestination = {
    threadKey: key,
    draftKey: "new",
    isCurrent: () => current,
  };
  h.cursor = 0;
  const tree = elements(
    FileFeedbackDrafts({ threadKey: key, feedbackDestination }),
  );
  const button = tree.find(
    (node) =>
      node.type === "button" && node.props.children === FEEDBACK_STRINGS.add,
  )!;
  (button.props.onClick as () => void)();
  expect(Object.values(fileFeedbackDrafts.entries(key))).toHaveLength(1);
  expect(composerDrafts.read("new").text).toBe("");
  current = true;
  (button.props.onClick as () => void)();
  expect(composerDrafts.read("new").text).toContain("RETAINED ROUTE");
  expect(composerDrafts.read(`session:${key}`).text).toBe("");
  expect(fileFeedbackDrafts.entries(key)).toEqual({});
});
