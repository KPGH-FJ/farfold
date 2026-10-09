// These existing hook fixtures have no native browser; the barrier has dedicated lifecycle tests.
vi.mock("../runtime/browser_surface", async (original) => ({
  ...(await original<typeof import("../runtime/browser_surface")>()),
  useBrowserSurfaceBarrier: (requested: boolean) => requested,
}));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { crc32 } from "node:zlib";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  openDialog: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: hooks.openDialog }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (hooks.slots[hooks.cursor++] ??= {
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
    (hooks.slots[hooks.cursor++] ??= { value: { current } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (hooks.slots[hooks.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, index) => !Object.is(value, slot.deps?.[index]))
    ) {
      hooks.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => true }),
}));
// Template loading has its own store/shortcut tests. Keep this fixture's IPC
// boundary specific to file discovery and attachment reads.
vi.mock("../runtime/prompt_templates", () => {
  const empty = {
    items: [],
    ready: true,
    saving: false,
    uncertain: false,
    error: null,
    notice: null,
  };
  const snapshot = () => empty;
  return { usePromptTemplates: snapshot, promptTemplates: { snapshot } };
});

import { invoke } from "@tauri-apps/api/core";
import { Composer } from "./Composer";
import { ComposerAttachments } from "./ComposerAttachments";
import { draftImagePreview } from "../runtime/draft_images";
import { composerDrafts } from "../runtime/drafts";
import { threads } from "../runtime/sessions";
import { freshThreadState } from "../runtime/session_projection";
import { STRINGS } from "../runtime/strings";
import {
  PNG_IMAGE_TEST_DATA,
  TestImageDecoder,
} from "../runtime/image_fixtures.test-support";

type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof Composer>;
function nodes(tree: ReactNode): Element[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...nodes(child.props.children as ReactNode)]
      : [],
  );
}
function render() {
  for (let pass = 0; pass < 8; pass++) {
    hooks.cursor = 0;
    const tree = nodes(Composer(props));
    for (const node of tree) {
      const ref = node.props.ref as { current: unknown } | undefined;
      if (ref) ref.current = { focus: vi.fn(), style: {}, scrollHeight: 48 };
    }
    if (!hooks.effects.length) return tree;
    for (const effect of hooks.effects.splice(0)) effect();
  }
  throw new Error("Unexpected render loop");
}
function typeMention(value = "Keep @") {
  const area = render().find((node) => node.type === "textarea")!;
  (area.props.onChange as (event: unknown) => void)({
    target: { value },
  });
  render();
}
async function settle() {
  for (let pass = 0; pass < 4; pass++) await Promise.resolve();
  return render();
}
function options() {
  return render().filter((node) => node.props.role === "option");
}
function pick(option: Element) {
  (option.props.onMouseDown as (event: unknown) => void)({
    preventDefault() {},
  });
  render();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function openFilePicker() {
  const plus = render().find(
    (node) => node.props["aria-label"] === STRINGS.composer.addTitle,
  )!;
  (plus.props.onClick as () => void)();
  const choose = render().find(
    (node) =>
      node.type === "button" &&
      nodes(node.props.children as ReactNode).some(
        (child) =>
          child.type === "strong" &&
          child.props.children === STRINGS.composer.addFile,
      ),
  )!;
  (choose.props.onClick as () => void)();
}
function noAgentRequests() {
  expect(threads.open).not.toHaveBeenCalled();
  expect(threads.send).not.toHaveBeenCalled();
  expect(props.onSend).not.toHaveBeenCalled();
  expect(props.onGoSettings).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.every(
        ([command]) =>
          command === "project_files" || command === "project_file_read",
      ),
  ).toBe(true);
}

beforeEach(() => {
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.effects = [];
  hooks.openDialog.mockReset().mockResolvedValue(null);
  vi.mocked(invoke)
    .mockReset()
    .mockResolvedValue({ files: ["note.txt"] });
  vi.spyOn(threads, "open");
  vi.spyOn(threads, "send");
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  props = {
    thread: null,
    workContext: { agentId: "selected", cwd: "/selected" },
    draftKey: "project-new-a",
    imageEnabled: false,
    disabled: true,
    editableWhenDisabled: true,
    onGoSettings: vi.fn(),
    onSend: vi.fn(),
  };
  composerDrafts.update("project-new-a", () => ({
    text: "Keep",
    attachments: [
      { id: "kept", kind: "file", name: "keep.txt", uri: "file:///keep.txt" },
    ],
  }));
  composerDrafts.update("project-new-b", () => ({
    text: "Other",
    attachments: [],
  }));
});

it("uses the existing add-file menu to import an image without changing text or contacting an Agent", async () => {
  props.imageEnabled = true;
  vi.stubGlobal("Image", TestImageDecoder);
  hooks.openDialog.mockResolvedValue(["/chosen/图片 space%.txt"]);
  vi.mocked(invoke).mockResolvedValue({
    mimeType: "image/png",
    data: PNG_IMAGE_TEST_DATA,
  });
  openFilePicker();
  await vi.waitFor(() =>
    expect(
      composerDrafts.read("project-new-a").attachments.at(-1),
    ).toMatchObject({
      kind: "image",
      uri: "file:///chosen/%E5%9B%BE%E7%89%87%20space%25.txt",
      data: PNG_IMAGE_TEST_DATA,
      loading: false,
    }),
  );
  expect(hooks.openDialog).toHaveBeenCalledExactlyOnceWith({ multiple: true });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("draft_attachment_image", {
    uri: "file:///chosen/%E5%9B%BE%E7%89%87%20space%25.txt",
    read: true,
  });
  expect(composerDrafts.read("project-new-a").text).toBe("Keep");
  expect(composerDrafts.read("project-new-a").attachments[0]!.id).toBe("kept");
  expect(threads.open).not.toHaveBeenCalled();
  expect(threads.send).not.toHaveBeenCalled();
  expect(props.onSend).not.toHaveBeenCalled();
  const attachmentProps = render().find(
    (node) => node.type === ComposerAttachments,
  )!.props;
  expect(
    (
      attachmentProps.items as import("../runtime/drafts").DraftAttachment[]
    ).map(draftImagePreview),
  ).toContain(`data:image/png;base64,${PNG_IMAGE_TEST_DATA}`);
});

function tooWidePng() {
  const bytes = Uint8Array.from(atob(PNG_IMAGE_TEST_DATA), (char) =>
    char.charCodeAt(0),
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 9000);
  view.setUint32(29, crc32(bytes.subarray(12, 29)));
  return btoa(String.fromCharCode(...bytes));
}
it.each([
  "AAAA",
  tooWidePng(),
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAQAAAAAAAAAAAGQD6AAAECjlZAAAAAxJREFUeJxj/M8AAgAGCAEBWs8GSAAAABpmY1RMAAAAAQAAAAIAAAABAAAAAAAAAAAAZAPoAACLWw+wAAAAE2ZkQVQAAAACeJxjZGj4z8DAAAAGigGBHdUz0wAAAABJRU5ErkJggg==",
])(
  "retains a refused image without sending it into the thumbnail decoder %#",
  async (data) => {
    props.imageEnabled = true;
    const decoder = vi.fn();
    vi.stubGlobal("Image", decoder);
    hooks.openDialog.mockResolvedValue(["/chosen.png"]);
    vi.mocked(invoke).mockResolvedValue({ mimeType: "image/png", data });
    openFilePicker();
    await vi.waitFor(() =>
      expect(
        composerDrafts.read("project-new-a").attachments.at(-1),
      ).toMatchObject({
        kind: "image",
        data,
        loading: false,
      }),
    );
    expect(render().some((node) => node.type === "img")).toBe(false);
    expect(decoder).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  },
);

it("keeps cancellation and a late chooser response from replacing later draft input", async () => {
  const original = composerDrafts.read("project-new-a");
  openFilePicker();
  await settle();
  expect(composerDrafts.read("project-new-a")).toBe(original);
  const choice = deferred<string[] | null>();
  hooks.openDialog.mockReturnValue(choice.promise);
  openFilePicker();
  composerDrafts.clear("project-new-a");
  composerDrafts.update("project-new-a", () => ({
    text: "Later",
    attachments: [],
  }));
  const later = composerDrafts.read("project-new-a");
  choice.resolve(["/chosen.png"]);
  await settle();
  expect(composerDrafts.read("project-new-a")).toBe(later);
  expect(invoke).not.toHaveBeenCalled();
  expect(threads.open).not.toHaveBeenCalled();
  expect(threads.send).not.toHaveBeenCalled();
  expect(props.onSend).not.toHaveBeenCalled();
});
afterEach(() => {
  hooks.slots.forEach((slot) => slot.cleanup?.());
  composerDrafts.clear("project-new-a");
  composerDrafts.clear("project-new-b");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("looks up and adds a file in an editable unconnected draft's selected folder without connecting or sending", async () => {
  const workContext = props.workContext;
  typeMention();
  await settle();
  expect(invoke).toHaveBeenCalledWith("project_files", { cwd: "/selected" });
  expect(options()).toHaveLength(1);
  pick(options()[0]!);
  expect(composerDrafts.read("project-new-a").text).toBe("Keep ");
  expect(composerDrafts.read("project-new-a").attachments).toEqual([
    { id: "kept", kind: "file", name: "keep.txt", uri: "file:///keep.txt" },
    expect.objectContaining({
      name: "note.txt",
      uri: "file:///selected/note.txt",
    }),
  ]);
  expect(props.workContext).toBe(workContext);
  noAgentRequests();
});

it("dismisses file suggestions with Escape without deleting typed text or accepting a stale selection", async () => {
  typeMention("Keep @no");
  await settle();
  const before = composerDrafts.read("project-new-a");
  const stale = options()[0]!;
  expect(stale).toBeDefined();
  const area = render().find((node) => node.type === "textarea")!;
  const event = {
    key: "Escape",
    nativeEvent: { isComposing: false, keyCode: 27 },
    preventDefault: vi.fn(),
  };
  (area.props.onKeyDown as (event: unknown) => void)(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(render().some((node) => node.props.role === "listbox")).toBe(false);
  pick(stale);
  expect(composerDrafts.read("project-new-a")).toBe(before);
  typeMention("Keep @not");
  await settle();
  expect(options()).toHaveLength(1);
  expect(composerDrafts.read("project-new-a").attachments).toBe(
    before.attachments,
  );
  noAgentRequests();
});

it("prefers the established conversation folder to a different selected work context", async () => {
  const thread = freshThreadState(
    "file-established",
    "kept-agent",
    "/original",
    "native",
  );
  thread.identity = "established";
  thread.configOptions = [
    {
      id: "kept-model",
      name: "Model",
      type: "select",
      category: "model",
      currentValue: "original-model",
      options: [{ value: "original-model", name: "Original" }],
    },
  ];
  thread.serviceContext = "original-source";
  props.thread = thread;
  const config = thread.configOptions;
  typeMention();
  await settle();
  pick(options()[0]!);
  expect(invoke).toHaveBeenCalledWith("project_files", { cwd: "/original" });
  expect(composerDrafts.read("project-new-a").attachments.at(-1)?.uri).toBe(
    "file:///original/note.txt",
  );
  expect(thread.configOptions).toBe(config);
  expect(thread.serviceContext).toBe("original-source");
  noAgentRequests();
});

it("does not query or attach a project file when no folder is available", async () => {
  props.workContext = undefined;
  typeMention();
  await settle();
  expect(options()).toHaveLength(0);
  expect(invoke).not.toHaveBeenCalled();
  expect(composerDrafts.read("project-new-a").text).toBe("Keep @");
  expect(composerDrafts.read("project-new-a").attachments).toHaveLength(1);
  noAgentRequests();
});

it("hides an old folder's list immediately and rejects its captured selection while the replacement query is pending", async () => {
  const thread = freshThreadState("same-draft", "selected", "/first", "one");
  props.thread = thread;
  typeMention();
  await settle();
  const stale = options()[0]!;
  const next = deferred<{ files: string[] }>();
  vi.mocked(invoke).mockReturnValue(next.promise);
  props.thread = { ...thread, cwd: "/second" };
  render();
  expect(options()).toHaveLength(0);
  pick(stale);
  expect(composerDrafts.read("project-new-a").attachments).toHaveLength(1);
  expect(composerDrafts.read("project-new-a").text).toBe("Keep @");
  next.resolve({ files: ["second.txt"] });
  await settle();
  pick(options()[0]!);
  expect(composerDrafts.read("project-new-a").attachments.at(-1)?.uri).toBe(
    "file:///second/second.txt",
  );
  noAgentRequests();
});

it("ignores a late old-folder response after the new folder's files are ready", async () => {
  const first = deferred<{ files: string[] }>();
  const second = deferred<{ files: string[] }>();
  vi.mocked(invoke)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  typeMention();
  props.workContext = { agentId: "selected", cwd: "/second" };
  render();
  second.resolve({ files: ["second.txt"] });
  await settle();
  first.resolve({ files: ["first.txt"] });
  await settle();
  expect(options()).toHaveLength(1);
  pick(options()[0]!);
  expect(composerDrafts.read("project-new-a").attachments.at(-1)?.uri).toBe(
    "file:///second/second.txt",
  );
  noAgentRequests();
});

it.each(["other draft", "inactive", "unmounted"])(
  "rejects a captured file selection after moving to %s",
  async (change) => {
    props.thread = freshThreadState(
      "same-draft",
      "selected",
      "/selected",
      "one",
    );
    typeMention();
    await settle();
    const stale = options()[0]!;
    if (change === "other draft") {
      props.draftKey = "project-new-b";
      render();
    } else if (change === "inactive") {
      props.active = false;
      render();
    } else {
      hooks.slots.forEach((slot) => slot.cleanup?.());
    }
    (stale.props.onMouseDown as (event: unknown) => void)({
      preventDefault() {},
    });
    expect(composerDrafts.read("project-new-a").text).toBe("Keep @");
    expect(composerDrafts.read("project-new-a").attachments).toHaveLength(1);
    expect(composerDrafts.read("project-new-b").text).toBe("Other");
    expect(composerDrafts.read("project-new-b").attachments).toHaveLength(0);
    noAgentRequests();
  },
);

it("rejects an old selection when the draft becomes read-only or its file query changes", async () => {
  typeMention();
  await settle();
  const stale = options()[0]!;
  props.editableWhenDisabled = false;
  render();
  pick(stale);
  expect(composerDrafts.read("project-new-a").attachments).toHaveLength(1);
  props.editableWhenDisabled = true;
  typeMention("Keep @different");
  pick(stale);
  expect(composerDrafts.read("project-new-a").text).toBe("Keep @different");
  expect(composerDrafts.read("project-new-a").attachments).toHaveLength(1);
  noAgentRequests();
});

it("completes an explicitly picked file read only in its original draft after another draft is shown", async () => {
  const read = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) =>
    command === "project_file_read"
      ? read.promise
      : Promise.resolve({ files: ["note.txt"] }),
  );
  props.embedContext = true;
  typeMention();
  await settle();
  pick(options()[0]!);
  expect(invoke).toHaveBeenCalledWith("project_file_read", {
    cwd: "/selected",
    path: "note.txt",
  });
  props.draftKey = "project-new-b";
  props.workContext = { agentId: "other", cwd: "/other" };
  render();
  read.resolve("Fixed selected file text");
  await settle();
  expect(composerDrafts.read("project-new-a").attachments.at(-1)).toEqual(
    expect.objectContaining({
      uri: "file:///selected/note.txt",
      content: "Fixed selected file text",
      loading: false,
    }),
  );
  expect(composerDrafts.read("project-new-b").attachments).toHaveLength(0);
  expect(composerDrafts.read("project-new-b").text).toBe("Other");
  noAgentRequests();
});

it("does not place a late file body into an attachment whose path has been replaced", async () => {
  const read = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) =>
    command === "project_file_read"
      ? read.promise
      : Promise.resolve({ files: ["note.txt"] }),
  );
  props.embedContext = true;
  typeMention();
  await settle();
  pick(options()[0]!);
  const picked = composerDrafts.read("project-new-a").attachments.at(-1)!;
  composerDrafts.update("project-new-a", (draft) => ({
    ...draft,
    attachments: draft.attachments.map((item) =>
      item === picked
        ? { ...item, uri: "file:///replacement.txt", loading: false }
        : item,
    ),
  }));
  read.resolve("Only the originally selected file");
  await settle();
  expect(composerDrafts.read("project-new-a").attachments.at(-1)).toEqual({
    ...picked,
    uri: "file:///replacement.txt",
    loading: false,
  });
  noAgentRequests();
});

it.each([
  ["/selected", "file:///selected/report%23%25.md"],
  ["C:\\work folder", "file:///C:/work%20folder/report%23%25.md"],
])(
  "encodes a picked project attachment in %s and retains existing unsent work",
  async (cwd, uri) => {
    props.workContext = { agentId: "selected", cwd };
    vi.mocked(invoke).mockResolvedValue({ files: ["report#%.md"] });
    typeMention();
    await settle();
    pick(options()[0]!);
    const saved = composerDrafts.read("project-new-a");
    expect(saved.attachments.at(-1)).toEqual(
      expect.objectContaining({ uri, name: "report#%.md" }),
    );
    expect(saved.attachments[0]!.uri).toBe("file:///keep.txt");
    expect(saved.text).toContain("Keep");
    noAgentRequests();
  },
);

it("asks for a working folder before an @ search and resumes when one arrives", async () => {
  const requireFolder = vi.fn();
  props.workContext = undefined;
  props.onRequireFolder = requireFolder;
  typeMention();
  await settle();
  expect(requireFolder).toHaveBeenCalledTimes(1);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "project_files"),
  ).toHaveLength(0);
  props.workContext = { agentId: "selected", cwd: "/picked" };
  await settle();
  expect(invoke).toHaveBeenCalledWith("project_files", { cwd: "/picked" });
  expect(requireFolder).toHaveBeenCalledTimes(1);
  noAgentRequests();
});

it("runs a requested send once and clears the draft only after it is sent", async () => {
  const { draftPersistence } = await import("../runtime/draft_storage");
  const flush = vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  try {
    props.disabled = false;
    composerDrafts.update("project-new-a", () => ({
      text: "Requested send",
      attachments: [],
    }));
    render();
    props.sendRequest = 1;
    render();
    expect(composerDrafts.read("project-new-a").text).toBe("Requested send");
    await vi.waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    expect(composerDrafts.read("project-new-a").text).toBe("");
    render();
    await settle();
    expect(props.onSend).toHaveBeenCalledTimes(1);
  } finally {
    flush.mockRestore();
  }
});

it("drops a send request that arrives while sending is unavailable", async () => {
  composerDrafts.update("project-new-a", () => ({
    text: "Requested send",
    attachments: [],
  }));
  render();
  props.sendRequest = 1;
  render();
  await settle();
  expect(props.onSend).not.toHaveBeenCalled();
  props.disabled = false;
  render();
  await settle();
  expect(props.onSend).not.toHaveBeenCalled();
});
