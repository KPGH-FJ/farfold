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
  useMemo: (read: () => unknown) => read(),
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
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";
import { composerDrafts, fileFeedbackDrafts } from "../runtime/drafts";
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
function render(value: FileArtifact) {
  h.cursor = 0;
  FileArtifactView({ card: value, threadKey: key });
  for (const effect of h.effects.splice(0)) effect();
  h.cursor = 0;
  return elements(FileArtifactView({ card: value, threadKey: key }));
}
function write(
  value: FileArtifact,
  text: string,
  side: "before" | "after" = "after",
) {
  const difference = render(value).find(
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
function submit(value: FileArtifact) {
  const form = render(value).find((node) => node.type === "form")!;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
}
beforeEach(() => {
  h.slots.length = 0;
  h.effects.length = 0;
  h.cursor = 0;
  h.invoke.mockReset();
  for (const entry of Object.values(fileFeedbackDrafts.entries(key)))
    fileFeedbackDrafts.clear(key, entry.path);
  composerDrafts.clear(`session:${key}`);
});
afterEach(() => vi.unstubAllGlobals());

function changeField(value: FileArtifact, label: string, text: string) {
  const field = render(value).find(
    (node) => node.props["aria-label"] === label,
  )!;
  (field.props.onChange as (event: unknown) => void)({
    target: { value: text },
  });
}

it("retains manually entered fragment ranges by content version and adds only that exact opinion", () => {
  const value = { ...card("line two\nline three"), scope: "fragment" as const };
  write(value, "RANGE OPINION");
  changeField(value, W.feedbackLine, "1–3");
  expect(Object.values(fileFeedbackDrafts.entries(key))[0]).toMatchObject({
    text: "RANGE OPINION",
    scope: "fragment",
    selection: { side: "after", line: 1, endLine: 3 },
  });
  const other = card("ANOTHER VERSION");
  write(other, "KEEP OTHER OPINION");
  expect(
    render(value).find((node) => node.props["aria-label"] === W.feedbackLine)
      ?.props.value,
  ).toBe("1–3");
  submit(value);
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

it("keeps invalid raw locations, blocks out-of-fragment ranges and still permits selecting a real line", () => {
  const value = { ...card("second"), scope: "fragment" as const };
  write(value, "KEEP TEXT");
  changeField(value, W.feedbackLine, "8–12");
  let tree = render(value);
  expect(
    tree.find((node) => node.props["aria-label"] === W.feedbackLine)?.props[
      "aria-invalid"
    ],
  ).toBe(true);
  expect(
    tree.find((node) => node.props.type === "submit")?.props.disabled,
  ).toBe(true);
  submit(value);
  expect(composerDrafts.read(`session:${key}`).text).toBe("");
  expect(Object.values(fileFeedbackDrafts.entries(key))[0]).toMatchObject({
    text: "KEEP TEXT",
    lineInput: { side: "after", text: "8–12" },
    selection: null,
  });
  render(card("OTHER"));
  expect(
    render(value).find((node) => node.props["aria-label"] === W.feedbackLine)
      ?.props.value,
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

it("offers manual original-side ranges in document reading mode without inventing full-file coordinates", () => {
  const value = {
    ...card("new\nlast"),
    path: "/p/note.md",
    oldText: "old\nsecond\nlast",
    scope: "fragment" as const,
  };
  changeField(value, W.viewMode, "read-before");
  const open = render(value).find(
    (node) => node.props["aria-label"] === W.feedbackOpen,
  )!;
  (open.props.onClick as () => void)();
  changeField(value, W.feedbackLine, "2-3");
  changeField(value, W.feedbackLabel, "ORIGINAL RANGE");
  submit(value);
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
  write(value, "UNCHANGED OPINION");
  const saved = structuredClone(fileFeedbackDrafts.entries(key));
  const click = async (label: string) => {
    const button = render(value).find(
      (node) => node.props["aria-label"] === label,
    )!;
    await (button.props.onClick as () => Promise<void>)();
  };
  await click(W.copyDiff);
  expect(clipboard.writeText).toHaveBeenLastCalledWith(" same\n-old\n+new");
  await click(W.copyPath);
  expect(clipboard.writeText).toHaveBeenLastCalledWith("/p/shared.ts");
  changeField(value, W.viewMode, "before");
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

it("keeps distinct opinions and locations through editing older content and returning", () => {
  const newer = card("CURRENT-V5");
  const older = card("OLDER-V1");
  write(newer, "NEW OPINION");
  const original = structuredClone(fileFeedbackDrafts.entries(key));
  expect(render(older).some((node) => node.type === "textarea")).toBe(false);
  expect(fileFeedbackDrafts.entries(key)).toEqual(original);
  write(older, "OLD OPINION");
  expect(
    Object.values(fileFeedbackDrafts.entries(key)).map((entry) => entry.text),
  ).toEqual(["NEW OPINION", "OLD OPINION"]);
  const returning = render(newer);
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

it("moves only the explicitly reviewed version, preserving other feedback and existing input", () => {
  const newer = card("CURRENT-V5");
  const older = card("OLDER-V1");
  composerDrafts.update(`session:${key}`, () => ({
    text: "EXISTING INPUT",
    attachments: [],
  }));
  write(newer, "NEW OPINION");
  write(older, "OLD OPINION");
  submit(older);
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
    render(newer).find((node) => node.type === "textarea")?.props.value,
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

it.each(["before", "after"] as const)(
  "retains official fragment scope for %s-line feedback",
  (side) => {
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
    write(value, "FRAGMENT OPINION", side);
    submit(value);
    expect(composerDrafts.read(`session:${key}`).text).toBe(
      `关于 /p/note.md（当时查看的内容，${side === "before" ? "修改前" : "修改后"}片段第 1 行）：\nFRAGMENT OPINION`,
    );
  },
);
