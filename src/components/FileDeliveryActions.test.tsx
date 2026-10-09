import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effects: [] as (() => void)[],
  active: true,
  onOpenFile: undefined as ((path: string) => void) | undefined,
  onOpenHtml: undefined as ((file: typeof verified) => void) | undefined,
  open: vi.fn(),
  save: vi.fn(),
  inspect: vi.fn(),
  inspectSelected: vi.fn(),
  readText: vi.fn(),
  copy: vi.fn(),
  exportText: vi.fn(),
  openFile: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock("../runtime/file_copy_jobs", () => ({
  fileCopyJobs: { begin: h.copy },
}));
vi.mock("./FileCopyJobsStatus", () => ({
  FileCopyJobsStatus: () => <div data-copy-jobs />,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.open, save: h.save }));
vi.mock("../runtime/file_delivery", () => ({
  fileDelivery: {
    inspect: h.inspect,
    inspectSelected: h.inspectSelected,
    readText: h.readText,
    copy: h.copy,
    exportText: h.exportText,
    open: h.openFile,
    reveal: h.reveal,
  },
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
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = h.cursor++;
    const slot = h.slots[index];
    if (!slot || deps.some((value, i) => !Object.is(value, slot.deps?.[i])))
      h.effects.push(() => {
        slot?.cleanup?.();
        h.slots[index].cleanup = effect() || undefined;
      });
    h.slots[index] = { deps, cleanup: slot?.cleanup };
  },
}));

import {
  FileDeliveryActions,
  FileDeliveryControls,
  reportedArtifactPath,
} from "./FileDeliveryActions";
import { TEXT_BLOCK_STRINGS as T } from "../runtime/text_block_strings";
import { FILE_DELIVERY_STRINGS as S } from "../runtime/file_delivery_strings";
import type { FileArtifact } from "../runtime/artifact_view";

const card: FileArtifact = {
  kind: "diff",
  path: "result.md",
  source: "diff",
  status: "completed",
  oldText: null,
  newText: "AGENT FRAGMENT",
  scope: "fragment",
  time: 1,
};
const verified = {
  root: "/work",
  path: "result.md",
  resolvedPath: "/work/result.md",
  name: "result.md",
  size: 16,
  sha256: "sha-v1",
  version: "version-1",
};
type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    result.push(child, ...elements(child.props.children as ReactNode));
  });
  return result;
}
function render(value = card) {
  h.cursor = 0;
  const tree = FileDeliveryControls({
    card: value,
    workingDirectory: "/work",
    identity: "thread:revision-1",
    active: h.active,
    onOpenHtml: h.onOpenHtml,
    onOpenFile: h.onOpenFile,
  });
  for (const effect of h.effects.splice(0)) effect();
  return elements(tree);
}
function button(label: string, value = card) {
  return render(value).find(
    (node) => node.type === "button" && node.props.children === label,
  );
}
function click(label: string, value = card) {
  const node = button(label, value);
  expect(node, label).toBeDefined();
  (node!.props.onClick as () => void)();
}
function text(value = card) {
  return render(value)
    .map((node) =>
      typeof node.props.children === "string" ? node.props.children : "",
    )
    .join(" ");
}
function unmount() {
  for (const slot of h.slots) slot.cleanup?.();
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
async function checkFile(value = card) {
  click(S.inspect, value);
  await vi.waitFor(() => expect(button(S.inspectAgain, value)).toBeDefined());
}

beforeEach(() => {
  h.slots.length = 0;
  h.effects.length = 0;
  h.cursor = 0;
  h.active = true;
  h.onOpenHtml = undefined;
  h.onOpenFile = undefined;
  for (const mock of [
    h.open,
    h.save,
    h.inspect,
    h.inspectSelected,
    h.readText,
    h.copy,
    h.exportText,
    h.openFile,
    h.reveal,
  ])
    mock.mockReset();
  h.inspect.mockResolvedValue(verified);
  h.inspectSelected.mockResolvedValue({
    ...verified,
    root: "",
    path: "/outside/chosen.md",
    resolvedPath: "/outside/chosen.md",
    name: "chosen.md",
  });
});

it("only completed protocol diffs become automatic candidates; mounting does not read files", () => {
  expect(reportedArtifactPath(card)).toBe("result.md");
  expect(reportedArtifactPath({ ...card, source: "write-input" })).toBeNull();
  expect(reportedArtifactPath({ ...card, source: "edit-input" })).toBeNull();
  expect(reportedArtifactPath({ ...card, status: "failed" })).toBeNull();
  expect(reportedArtifactPath({ ...card, status: "in_progress" })).toBeNull();
  render();
  expect(h.inspect).not.toHaveBeenCalled();
  expect(h.inspectSelected).not.toHaveBeenCalled();
  expect(button(S.open)).toBeUndefined();
});

it("waits for a verified receipt and uses its exact version for open, reveal and copying", async () => {
  await checkFile();
  expect(h.inspect).toHaveBeenCalledWith("/work", "result.md");
  h.openFile.mockResolvedValue(undefined);
  click(S.open);
  await vi.waitFor(() => expect(text()).toContain(S.opened));
  expect(h.openFile).toHaveBeenCalledWith(verified);
  h.reveal.mockResolvedValue(undefined);
  click(S.reveal);
  await vi.waitFor(() => expect(text()).toContain(S.revealed));
  expect(h.reveal).toHaveBeenCalledWith(verified);
  h.save.mockResolvedValue("/delivery/copy.md");
  h.copy.mockResolvedValue({ destination: "/delivery/copy.md" });
  click(T.save);
  await vi.waitFor(() =>
    expect(h.copy).toHaveBeenCalledWith(verified, "/delivery/copy.md"),
  );
  expect(h.copy).toHaveBeenCalledWith(verified, "/delivery/copy.md");
});

it("opens a verified reported file in the existing file view using its resolved path", async () => {
  h.onOpenFile = vi.fn();
  await checkFile();
  click(S.open);
  expect(h.onOpenFile).toHaveBeenCalledExactlyOnceWith(verified.resolvedPath);
  expect(h.openFile).not.toHaveBeenCalled();
  expect(card.newText).toBe("AGENT FRAGMENT");
});

it("opens a verified chosen file in the existing file view without using the reported path", async () => {
  h.onOpenFile = vi.fn();
  h.open.mockResolvedValue("/outside/chosen.md");
  click(S.choose);
  await vi.waitFor(() => expect(button(S.inspectAgain)).toBeDefined());
  click(S.open);
  expect(h.onOpenFile).toHaveBeenCalledExactlyOnceWith("/outside/chosen.md");
  expect(h.openFile).not.toHaveBeenCalled();
  expect(h.inspect).not.toHaveBeenCalled();
});

it("blocks a saved in-app open callback while rechecking, inactive or unmounted", async () => {
  h.onOpenFile = vi.fn();
  await checkFile();
  const action = button(S.open)!;
  const invoke = action.props.onClick as () => void;
  const inspection = deferred<typeof verified>();
  h.inspect.mockReturnValue(inspection.promise);
  click(S.inspectAgain);
  invoke();
  expect(h.onOpenFile).not.toHaveBeenCalled();
  inspection.resolve(verified);
  await vi.waitFor(() => expect(button(S.inspectAgain)).toBeDefined());
  h.active = false;
  render();
  invoke();
  expect(h.onOpenFile).not.toHaveBeenCalled();
  h.active = true;
  render();
  unmount();
  invoke();
  expect(h.onOpenFile).not.toHaveBeenCalled();
  expect(h.openFile).not.toHaveBeenCalled();
});

it("never derives a folder grant from a chosen external file", async () => {
  const input = { ...card, source: "write-input" as const };
  expect(button(S.inspect, input)).toBeUndefined();
  h.open.mockResolvedValue("/outside/chosen.md");
  click(S.choose, input);
  await vi.waitFor(() => expect(button(S.open, input)).toBeDefined());
  expect(h.open).toHaveBeenCalledWith(
    expect.objectContaining({ multiple: false, directory: false }),
  );
  expect(h.inspectSelected).toHaveBeenCalledWith("/outside/chosen.md");
  expect(h.inspect).not.toHaveBeenCalled();
  expect(text(input)).toContain(S.selectedOrigin);
});

it("cancelled selection and save dialogs cause no file operations", async () => {
  h.open.mockResolvedValue(null);
  click(S.choose);
  await vi.waitFor(() => expect(button(S.choose)?.props.disabled).toBe(false));
  expect(h.inspectSelected).not.toHaveBeenCalled();
  await checkFile();
  h.save.mockResolvedValue(null);
  click(T.save);
  await vi.waitFor(() => expect(button(T.save)?.props.disabled).toBe(false));
  expect(h.copy).not.toHaveBeenCalled();
  expect(button(S.open)).toBeDefined();
});

it("a file-change error clears old authority and preview while retaining the original text", async () => {
  await checkFile();
  h.readText.mockResolvedValue({ file: verified, text: "CURRENT FILE" });
  click(S.current);
  await vi.waitFor(() => expect(text()).toContain("CURRENT FILE"));
  h.openFile.mockRejectedValue(new Error("文件已变化"));
  click(S.open);
  await vi.waitFor(() => expect(text()).toContain("文件已变化"));
  expect(button(S.open)).toBeUndefined();
  expect(text()).not.toContain("CURRENT FILE");
  expect(card.newText).toBe("AGENT FRAGMENT");
  expect(button(S.snapshot)).toBeDefined();
});

it("shows disk text independently and refuses a mismatched read receipt", async () => {
  await checkFile();
  h.readText.mockResolvedValue({ file: verified, text: "CURRENT FILE" });
  click(S.current);
  await vi.waitFor(() => expect(text()).toContain("CURRENT FILE"));
  expect(text()).toContain(S.currentNote);
  expect(card.newText).toBe("AGENT FRAGMENT");
  h.readText.mockResolvedValue({
    file: { ...verified, version: "version-2" },
    text: "WRONG VERSION",
  });
  click(S.current);
  await vi.waitFor(() => expect(button(S.open)).toBeUndefined());
  expect(text()).not.toContain("WRONG VERSION");
});

it("exports the explicit Agent text snapshot without inspecting or claiming the original file", async () => {
  const input = { ...card, source: "edit-input" as const };
  h.save.mockResolvedValue("/delivery/text.txt");
  h.exportText.mockResolvedValue({ destination: "/delivery/text.txt" });
  click(S.snapshot, input);
  await vi.waitFor(() =>
    expect(text(input)).toContain(S.exported("/delivery/text.txt")),
  );
  expect(h.exportText).toHaveBeenCalledWith(
    "AGENT FRAGMENT",
    "/delivery/text.txt",
  );
  expect(h.inspect).not.toHaveBeenCalled();
  expect(button(S.open, input)).toBeUndefined();
});

it("ignores a dialog result after the original revision leaves the view", async () => {
  const dialog = deferred<string>();
  h.open.mockReturnValue(dialog.promise);
  click(S.choose);
  unmount();
  dialog.resolve("/outside/late.md");
  await Promise.resolve();
  await Promise.resolve();
  expect(h.inspectSelected).not.toHaveBeenCalled();
});

it("does not copy after a save dialog returns to an unmounted revision", async () => {
  await checkFile();
  const dialog = deferred<string>();
  h.save.mockReturnValue(dialog.promise);
  click(T.save);
  unmount();
  dialog.resolve("/delivery/late.md");
  await Promise.resolve();
  await Promise.resolve();
  expect(h.copy).not.toHaveBeenCalled();
});

it("does not inspect a selected file after its page becomes inactive without unmounting", async () => {
  const dialog = deferred<string>();
  h.open.mockReturnValue(dialog.promise);
  click(S.choose);
  h.active = false;
  render();
  dialog.resolve("/outside/hidden.md");
  await Promise.resolve();
  await Promise.resolve();
  expect(h.inspectSelected).not.toHaveBeenCalled();
});

it("does not copy after its page becomes inactive while a save dialog is pending", async () => {
  await checkFile();
  const dialog = deferred<string>();
  h.save.mockReturnValue(dialog.promise);
  click(T.save);
  h.active = false;
  render();
  dialog.resolve("/delivery/hidden.md");
  await Promise.resolve();
  await Promise.resolve();
  expect(h.copy).not.toHaveBeenCalled();
});

it("does not export a text snapshot after its page becomes inactive while choosing a destination", async () => {
  const dialog = deferred<string>();
  h.save.mockReturnValue(dialog.promise);
  click(S.snapshot);
  h.active = false;
  render();
  dialog.resolve("/delivery/hidden-snapshot.txt");
  await Promise.resolve();
  await Promise.resolve();
  expect(h.exportText).not.toHaveBeenCalled();
});

it("does not revive a pending dialog token after leaving and returning to the same page", async () => {
  const dialog = deferred<string>();
  h.open.mockReturnValue(dialog.promise);
  click(S.choose);
  h.active = false;
  render();
  h.active = true;
  render();
  dialog.resolve("/outside/old-selection.md");
  await Promise.resolve();
  await Promise.resolve();
  expect(h.inspectSelected).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(button(S.choose)?.props.disabled).toBe(false));
  h.open.mockResolvedValue("/outside/new-selection.md");
  click(S.choose);
  await vi.waitFor(() =>
    expect(h.inspectSelected).toHaveBeenCalledWith("/outside/new-selection.md"),
  );
  expect(h.inspectSelected).toHaveBeenCalledTimes(1);
});

it("blocks saved click callbacks and disables every action while the retained page is inactive", () => {
  const original = button(S.choose)!;
  h.active = false;
  const nodes = render();
  expect(
    nodes
      .filter((node) => node.type === "button")
      .every((node) => node.props.disabled),
  ).toBe(true);
  (original.props.onClick as () => void)();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.inspect).not.toHaveBeenCalled();
});

it("keeps an already submitted copy busy until it settles without claiming cancellation or duplicating it", async () => {
  await checkFile();
  const copying = deferred<{ destination: string }>();
  h.save.mockResolvedValue("/delivery/submitted.md");
  h.copy.mockReturnValue(copying.promise);
  click(T.save);
  await vi.waitFor(() => expect(h.copy).toHaveBeenCalledTimes(1));
  h.active = false;
  render();
  h.active = true;
  render();
  expect(button(T.save)?.props.disabled).toBe(true);
  click(T.save);
  expect(h.copy).toHaveBeenCalledTimes(1);
  expect(h.save).toHaveBeenCalledTimes(1);
  copying.resolve({ destination: "/delivery/submitted.md" });
  await vi.waitFor(() => expect(button(T.save)?.props.disabled).toBe(false));
  expect(text()).not.toContain(S.copied("/delivery/submitted.md"));
  expect(text()).not.toContain("取消");
});

it("clears old verification and preview when a submitted copy fails while its page is inactive", async () => {
  await checkFile();
  h.readText.mockResolvedValue({ file: verified, text: "OLD DISK PREVIEW" });
  click(S.current);
  await vi.waitFor(() => expect(text()).toContain("OLD DISK PREVIEW"));
  const copying = deferred<{ destination: string }>();
  h.save.mockResolvedValue("/delivery/failed.md");
  h.copy.mockReturnValue(copying.promise);
  click(T.save);
  await vi.waitFor(() => expect(h.copy).toHaveBeenCalledTimes(1));
  h.active = false;
  render();
  copying.reject(new Error("hidden delivery failure"));
  await Promise.resolve();
  await Promise.resolve();
  h.active = true;
  render();
  expect(button(S.open)).toBeUndefined();
  expect(text()).not.toContain("OLD DISK PREVIEW");
  expect(text()).not.toContain("hidden delivery failure");
  expect(card.newText).toBe("AGENT FRAGMENT");
  expect(button(S.inspect)?.props.disabled).toBe(false);
});

it("blocks duplicate clicks before rendering and discards a late inspect reply", async () => {
  const inspection = deferred<typeof verified>();
  h.inspect.mockReturnValue(inspection.promise);
  const original = button(S.inspect)!;
  (original.props.onClick as () => void)();
  (original.props.onClick as () => void)();
  expect(h.inspect).toHaveBeenCalledTimes(1);
  unmount();
  inspection.resolve(verified);
  await Promise.resolve();
  await Promise.resolve();
  expect(button(S.open)).toBeUndefined();
});

it("gives each original revision an isolated control lifetime", () => {
  const props = { card, workingDirectory: "/work", identity: "thread:first" };
  expect(FileDeliveryActions(props).key).toBe("thread:first");
  expect(FileDeliveryActions({ ...props, identity: "thread:second" }).key).toBe(
    "thread:second",
  );
});

it("keeps all new static and formatted copy free of internal vocabulary", () => {
  const forbidden =
    /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i;
  for (const value of Object.values(S)) {
    const samples =
      typeof value === "function"
        ? [(value as (text: string, size?: number) => string)("文稿.md", 16)]
        : [value];
    for (const sample of samples) {
      expect(sample.trim()).not.toBe("");
      expect(sample).not.toMatch(forbidden);
    }
  }
});

it("hands only a verified HTML file to the in-app owner and never opens it with the system", async () => {
  const file = {
    ...verified,
    name: "game.html",
    path: "game.html",
    resolvedPath: "/work/game.html",
  };
  const html = { ...card, path: "game.html", newText: "REPORTED FRAGMENT" };
  h.onOpenHtml = vi.fn();
  h.onOpenFile = vi.fn();
  h.inspect.mockResolvedValue(file);
  expect(button(S.openHtml, html)).toBeUndefined();
  click(S.inspect, html);
  await vi.waitFor(() => expect(button(S.openHtml, html)).toBeDefined());
  const action = button(S.openHtml, html)!;
  (action.props.onClick as () => void)();
  expect(h.onOpenHtml).toHaveBeenCalledWith(file);
  expect(h.onOpenFile).not.toHaveBeenCalled();
  expect(h.openFile).not.toHaveBeenCalled();
  h.active = false;
  render(html);
  (action.props.onClick as () => void)();
  expect(h.onOpenHtml).toHaveBeenCalledOnce();
});

it("opens a reported file directly but never falls back to it after a chosen file fails", async () => {
  const open = vi.fn();
  h.onOpenFile = open;
  click(S.open);
  expect(open).toHaveBeenCalledWith(card.path);
  expect(h.inspect).not.toHaveBeenCalled();
  h.open.mockResolvedValue("/chosen/other.md");
  h.inspectSelected.mockRejectedValue(new Error("file missing"));
  click(S.choose);
  await vi.waitFor(() => expect(text()).toContain("file missing"));
  expect(button(S.open)).toBeUndefined();
  expect(open).toHaveBeenCalledTimes(1);
});
