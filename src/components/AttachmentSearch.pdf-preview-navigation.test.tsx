import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadState } from "../runtime/session_types";
import type { VerifiedFile } from "../runtime/file_delivery";

const h = vi.hoisted(() => ({
  owner: "",
  cursor: 0,
  slots: new Map<
    string,
    { value?: unknown; deps?: unknown[]; cleanup?: () => void }[]
  >(),
  effects: [] as (() => void)[],
  states: new Map<string, ThreadState>(),
  index: [] as {
    id: string;
    agentId: string;
    cwd: string;
    nativeSessionId: string;
  }[],
  invoke: vi.fn().mockResolvedValue(null),
  inspect: vi.fn(),
  readVisual: vi.fn(),
  renderPdf: vi.fn(),
}));
vi.mock("react", async (original) => {
  const api = await original<typeof import("react")>();
  const slot = () => {
    let slots = h.slots.get(h.owner);
    if (!slots) h.slots.set(h.owner, (slots = []));
    const index = h.cursor++;
    return { slots, index, old: slots[index] };
  };
  const effect = (run: () => void | (() => void), deps?: unknown[]) => {
    const { slots, index, old } = slot();
    if (!old || !deps || deps.some((v, i) => !Object.is(v, old.deps?.[i]))) {
      const next = (slots[index] = { deps, cleanup: old?.cleanup });
      h.effects.push(() => {
        old?.cleanup?.();
        next.cleanup = run() || undefined;
      });
    }
  };
  return {
    ...api,
    useState: (initial: unknown) => {
      const { slots, index, old } = slot();
      const value =
        old ??
        (slots[index] = {
          value: typeof initial === "function" ? initial() : initial,
        });
      return [
        value.value,
        (next: unknown) => {
          value.value = typeof next === "function" ? next(value.value) : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const { slots, index, old } = slot();
      return (old ?? (slots[index] = { value: { current: initial } })).value;
    },
    useMemo: (read: () => unknown) => read(),
    useContext: () => false,
    useSyncExternalStore: (_: unknown, read: () => unknown) => read(),
    useEffect: effect,
    useLayoutEffect: effect,
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../runtime/sessions", async (original) => {
  const api = await original<typeof import("../runtime/sessions")>();
  const snapshot = () => ({ threads: h.states, index: h.index });
  return {
    ...api,
    threads: {
      getSnapshot: snapshot,
      openArtifactPane: (key: string) => {
        h.states.get(key)!.artifactPaneOpen = true;
      },
      closeArtifactPane: vi.fn(),
    },
    useThreadsSnapshot: snapshot,
  };
});
vi.mock("../runtime/browser_sharing", async (original) => ({
  ...(await original<typeof import("../runtime/browser_sharing")>()),
  useBrowserSharing: () => ({
    info: null,
    pendingRequest: null,
    operation: null,
    error: "",
    notice: "",
    ready: false,
    queryState: "no_session",
  }),
}));
vi.mock("../runtime/file_delivery", async (original) => ({
  ...(await original<typeof import("../runtime/file_delivery")>()),
  fileDelivery: {
    inspectLink: h.inspect,
    readVisual: h.readVisual,
    checkRevision: vi.fn(),
  },
}));
vi.mock("../runtime/pdf_preview", () => ({ renderPdfPage: h.renderPdf }));

import { SelectedAttachmentSearch } from "./SelectedAttachmentSearch";
import { ThreadView } from "./ThreadView";
import { MessageAttachments } from "./MessageContent";
import { ArtifactPane } from "./ArtifactPane";
import { OpenedFileView } from "./OpenedFileView";
import { VisualFilePreview } from "./VisualFilePreview";
import type { PreviewReadingPositionRef } from "../runtime/preview_reading_position";
import { ATTACHMENT_SEARCH_STRINGS as S } from "../runtime/attachment_search_strings";
import {
  pdfSetup,
  searchPdf,
} from "../runtime/attachment_search.pdf.test-support";
import type { AttachmentSearchCandidate } from "../runtime/attachment_search_source";

type Element = ReactElement<Record<string, unknown>>;
type Request = {
  source: AttachmentSearchCandidate;
  token: object;
  pdfPreview?: { file: VerifiedFile; pageNumber: number };
};
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
// Real components/controller and their actual callback/prop boundaries. Only
// mounting, navigation handoff and native file/decoder boundaries are controlled.
function mount<P>(owner: string, component: (props: P) => ReactNode, props: P) {
  let tree: Element[] = [];
  for (let i = 0; i < 8; i++) {
    h.owner = owner;
    h.cursor = 0;
    tree = nodes(component(props));
    const canvas = tree.find((n) => n.type === "canvas");
    if (canvas)
      (canvas.props.ref as { current: unknown }).current = {
        width: 100,
        height: 100,
      };
    if (!h.effects.length) return tree;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw Error("Unexpected component effect loop");
}
const child = (tree: Element[], type: unknown) => {
  const result = tree.find((n) => n.type === type);
  expect(result, "real child component must be present").toBeDefined();
  return result!;
};
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));
let f: ReturnType<typeof pdfSetup>;
let request: Request | undefined;
let currentFile: VerifiedFile;
let searchProps: Parameters<typeof SelectedAttachmentSearch>[0];
let threadProps: Parameters<typeof ThreadView>[0] & {
  attachmentSearchRequest?: Request;
};
function threadTree() {
  return mount("thread", ThreadView, threadProps);
}
function opener(
  itemId = request!.source.itemId,
  index = request!.source.attachmentIndex,
) {
  const message = { dataset: { loadedMessage: itemId } };
  const attachment = { dataset: { loadedAttachment: String(index) } };
  return {
    closest: (selector: string) =>
      selector === "[data-loaded-message]"
        ? message
        : selector === "[data-loaded-attachment]"
          ? attachment
          : null,
  } as unknown as HTMLElement;
}
function clickAttachment(target = opener()) {
  const attachments = child(threadTree(), MessageAttachments);
  (attachments.props.onOpenFile as (path: string, opener: HTMLElement) => void)(
    f.file.path,
    target,
  );
}
async function explicitPreview(previousPage?: number) {
  const pane = child(threadTree(), ArtifactPane);
  const paneProps = pane.props as unknown as Parameters<typeof ArtifactPane>[0];
  const opened = child(mount("pane", ArtifactPane, paneProps), OpenedFileView);
  const openedProps = opened.props as unknown as Parameters<
    typeof OpenedFileView
  >[0];
  const position = openedProps.readingPosition as PreviewReadingPositionRef;
  if (previousPage)
    position.current = {
      kind: "pdf",
      root: f.file.root,
      resolvedPath: f.file.resolvedPath,
      page: previousPage,
    };
  mount("opened", OpenedFileView, openedProps);
  await drain();
  const visual = child(
    mount("opened", OpenedFileView, openedProps),
    VisualFilePreview,
  );
  mount(
    "visual",
    VisualFilePreview,
    visual.props as unknown as Parameters<typeof VisualFilePreview>[0],
  );
  await drain();
  return { paneProps, openedProps, visual, position };
}
async function navigate() {
  let tree = mount("search", SelectedAttachmentSearch, searchProps);
  const checkbox = tree.find(
    (n) => n.type === "input" && n.props.type === "checkbox",
  )!;
  (checkbox.props.onChange as (e: unknown) => void)({
    target: { checked: true },
  });
  tree = mount("search", SelectedAttachmentSearch, searchProps);
  const start = tree.find(
    (n) => n.type === "button" && n.props.children === S.start,
  )!;
  (start.props.onClick as () => void)();
  await vi.waitFor(() => expect(f.search.snapshot().phase).toBe("complete"));
  tree = mount("search", SelectedAttachmentSearch, searchProps);
  const button = tree.find(
    (n) => n.type === "button" && n.props.children === S.navigate,
  )!;
  expect(button).toBeDefined();
  await (button.props.onClick as () => Promise<void>)();
  expect(request?.source).toBe(f.search.snapshot().hits[0].source);
  threadProps.attachmentSearchRequest = request;
}
beforeEach(async () => {
  h.slots.clear();
  h.effects = [];
  h.states.clear();
  h.index = [];
  h.invoke.mockReset().mockResolvedValue(null);
  h.inspect.mockReset();
  h.readVisual.mockReset();
  h.renderPdf.mockReset();
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  f = pdfSetup();
  f.results.set(
    f.file.path,
    searchPdf([["first page"], ["author needle tail"], ["third page"]]),
  );
  h.states.set(f.s.key, f.s);
  h.index = [
    {
      id: f.s.key,
      agentId: f.s.agentId,
      cwd: f.s.cwd,
      nativeSessionId: f.s.nativeSessionId,
    },
  ];
  currentFile = f.file;
  h.inspect.mockImplementation(async () => currentFile);
  h.readVisual.mockImplementation(async () => ({
    file: currentFile,
    mimeType: "application/pdf",
    data: f.capture.data,
  }));
  h.renderPdf.mockImplementation(
    async (_bytes, _canvas, page, _width, _signal, ready) => ready(3, page),
  );
  request = undefined;
  searchProps = {
    active: true,
    rows: [{ key: f.s.key, title: "controlled" }] as Parameters<
      typeof SelectedAttachmentSearch
    >[0]["rows"],
    query: "needle",
    scopeKey: "one",
    controller: f.search,
    onSelect: ((
      source: AttachmentSearchCandidate,
      _current: () => boolean,
      pdfPreview?: Request["pdfPreview"],
    ) => {
      request = { source, token: {}, pdfPreview };
    }) as Parameters<typeof SelectedAttachmentSearch>[0]["onSelect"],
  };
  threadProps = {
    thread: f.s,
    active: true,
    agents: [],
    onGoSettings: vi.fn(),
    onOpened: vi.fn(),
  };
});
afterEach(() => {
  for (const slots of h.slots.values())
    for (const slot of slots) slot.cleanup?.();
  h.slots.clear();
  h.effects = [];
  vi.unstubAllGlobals();
});
it("carries a verified page2 search hit through the original attachment's explicit preview", async () => {
  await navigate();
  expect(h.inspect).not.toHaveBeenCalled();
  expect(h.readVisual).not.toHaveBeenCalled();
  expect(h.renderPdf).not.toHaveBeenCalled();
  clickAttachment();
  const { position } = await explicitPreview(3);
  expect(h.renderPdf).toHaveBeenCalledOnce();
  expect(h.renderPdf.mock.calls[0][2]).toBe(2);
  expect(h.renderPdf.mock.calls[0][6]).toBe(false);
  expect(position.current).toMatchObject({ kind: "pdf", page: 2 });
  expect(
    h.invoke.mock.calls.some(([name]) => String(name).startsWith("session_")),
  ).toBe(false);
});
it.each(["message", "attachment"])(
  "does not apply the hit page to another %s with the same path",
  async (part) => {
    await navigate();
    clickAttachment(
      opener(
        part === "message" ? "another-message" : request!.source.itemId,
        request!.source.attachmentIndex + (part === "attachment" ? 1 : 0),
      ),
    );
    await explicitPreview();
    expect(h.renderPdf.mock.calls[0][2]).toBe(1);
  },
);
it("discards the old hit page after the file revision changes before explicit opening", async () => {
  await navigate();
  currentFile = { ...f.file, version: "new-revision" };
  clickAttachment();
  const { openedProps, position } = await explicitPreview(3);
  expect(h.renderPdf.mock.calls[0][2]).toBe(1);
  expect(position.current).toMatchObject({ kind: "pdf", page: 1 });
  expect(
    mount("opened", OpenedFileView, openedProps).some(
      (n) => n.props.children === S.errors.changed,
    ),
  ).toBe(true);
});
it("keeps ordinary reading restoration when navigation has no PDF hit location", async () => {
  await navigate();
  request!.pdfPreview = undefined;
  clickAttachment();
  await explicitPreview(3);
  expect(h.renderPdf.mock.calls[0][2]).toBe(3);
  expect(h.renderPdf.mock.calls[0][6]).toBe(true);
});
it.each(["owner", "close"])(
  "does not decode a pending searched file after %s changes",
  async (change) => {
    await navigate();
    clickAttachment();
    const pane = child(threadTree(), ArtifactPane);
    const opened = child(
      mount(
        "pane",
        ArtifactPane,
        pane.props as unknown as Parameters<typeof ArtifactPane>[0],
      ),
      OpenedFileView,
    );
    const props = opened.props as unknown as Parameters<
      typeof OpenedFileView
    >[0];
    let resolve!: (file: VerifiedFile) => void;
    h.inspect.mockReturnValue(
      new Promise<VerifiedFile>((yes) => {
        resolve = yes;
      }),
    );
    mount("opened", OpenedFileView, props);
    if (change === "owner") h.states.set(f.s.key, { ...f.s });
    else mount("opened", OpenedFileView, { ...props, active: false });
    resolve(f.file);
    await drain();
    expect(h.readVisual).not.toHaveBeenCalled();
    expect(h.renderPdf).not.toHaveBeenCalled();
  },
);
it.each(["close", "replace"])(
  "retires an unfinished page intent when navigation search changes by %s",
  async (change) => {
    await navigate();
    clickAttachment();
    let finish!: () => void;
    h.renderPdf.mockReturnValue(
      new Promise<void>((yes) => {
        finish = yes;
      }),
    );
    const { visual, position } = await explicitPreview(3);
    threadProps.attachmentSearchRequest =
      change === "close" ? undefined : { ...request!, token: {} };
    threadTree();
    mount(
      "visual",
      VisualFilePreview,
      visual.props as unknown as Parameters<typeof VisualFilePreview>[0],
    );
    finish();
    await drain();
    expect(position.current).toMatchObject({ page: 3 });
  },
);
it("consumes a successfully drawn intent before the navigation notice is closed", async () => {
  await navigate();
  clickAttachment();
  const { visual, position } = await explicitPreview(3);
  threadProps.attachmentSearchRequest = undefined;
  threadTree();
  const tree = mount(
    "visual",
    VisualFilePreview,
    visual.props as unknown as Parameters<typeof VisualFilePreview>[0],
  );
  expect(position.current).toMatchObject({ page: 2 });
  expect(h.renderPdf).toHaveBeenCalledOnce();
  expect(tree.find((n) => n.type === "canvas")!.props.hidden).toBe(false);
});
it("does not publish a late file capture after the searched owner is replaced", async () => {
  await navigate();
  clickAttachment();
  const pane = child(threadTree(), ArtifactPane);
  const opened = child(
    mount(
      "pane",
      ArtifactPane,
      pane.props as unknown as Parameters<typeof ArtifactPane>[0],
    ),
    OpenedFileView,
  );
  const props = opened.props as unknown as Parameters<typeof OpenedFileView>[0];
  let finish!: (value: unknown) => void;
  h.readVisual.mockReturnValue(
    new Promise((yes) => {
      finish = yes;
    }),
  );
  mount("opened", OpenedFileView, props);
  await drain();
  expect(h.readVisual).toHaveBeenCalledOnce();
  h.states.set(f.s.key, { ...f.s });
  finish({ file: f.file, mimeType: "application/pdf", data: f.capture.data });
  await drain();
  expect(
    mount("opened", OpenedFileView, props).some(
      (n) => n.type === VisualFilePreview,
    ),
  ).toBe(false);
});
