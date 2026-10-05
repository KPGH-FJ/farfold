// These existing hook fixtures have no native browser; the barrier has dedicated lifecycle tests.
vi.mock("../runtime/browser_surface", async (original) => ({
  ...(await original<typeof import("../runtime/browser_surface")>()),
  useBrowserSurfaceBarrier: (requested: boolean) => requested,
}));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
}));
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

import { invoke } from "@tauri-apps/api/core";
import { Composer } from "./Composer";
import { composerDrafts } from "../runtime/drafts";
import { threads } from "../runtime/sessions";
import { freshThreadState } from "../runtime/session_projection";

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
