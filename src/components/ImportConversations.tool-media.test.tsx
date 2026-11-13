import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[] }[],
  cursor: 0,
  effects: [] as (() => void)[],
  index: [] as import("../runtime/sessions").IndexRow[],
  choose: vi.fn(),
  discover: vi.fn(),
  preview: vi.fn(),
  closePreview: vi.fn(),
  commit: vi.fn(),
  refresh: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    const slot = (h.slots[i] ??= {
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
  useRef: (initial: unknown) => {
    const i = h.cursor++;
    return (h.slots[i] ??= { value: { current: initial } }).value;
  },
  useEffect: (effect: () => void, deps: unknown[]) => {
    const i = h.cursor++;
    const slot = h.slots[i];
    if (
      !slot ||
      deps.some((value, index) => !Object.is(value, slot.deps?.[index]))
    )
      h.effects.push(effect);
    h.slots[i] = { deps };
  },
}));
vi.mock("../runtime/dialogs", () => ({ chooseDirectory: h.choose }));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  subscribeCredentialChanges: () => () => {},
}));
vi.mock("../runtime/authentication", async (original) => ({
  ...(await original<typeof import("../runtime/authentication")>()),
  subscribeAuthenticationChanges: () => () => {},
}));
vi.mock("../runtime/history_import", () => ({
  discoverHistory: h.discover,
  previewHistory: (agentId: string, row: unknown) => h.preview(agentId, row),
  readHistoryPreview: async (agentId: string, row: unknown) => ({
    ...(await h.preview(agentId, row)),
    purpose: "searchReadOnly",
  }),
  closeHistoryPreview: h.closePreview,
  commitHistoryPreview: h.commit,
  hasPreviewContent: () => true,
  historyContinuation: () => ({
    title: "Read only",
    detail: "Verify before sending",
  }),
}));
vi.mock("../runtime/sessions", () => ({
  threads: {
    getSnapshot: () => ({ index: h.index }),
    refreshIndex: h.refresh,
    prompt: h.prompt,
  },
}));

import { ToolStep } from "./thread-items";
import { freshThreadState } from "../runtime/session_projection";
import { PNG_IMAGE_TEST_DATA } from "../runtime/image_fixtures.test-support";
import { ImportConversations } from "./ImportConversations";
import { IMPORT_STRINGS as S } from "../runtime/import_strings";
import type { AgentCardModel } from "../runtime/agents";
import type { DiscoveredConversation } from "../runtime/history_import";
import type { IndexRow } from "../runtime/sessions";

const agent: AgentCardModel = {
  id: "a",
  name: "Agent A",
  description: "",
  status: "connected",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: null,
  installable: false,
  registerable: false,
  custom: false,
  handshake: null,
};
type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof ImportConversations>;

function saved(id: string, title: string, cwd: string): IndexRow {
  return {
    id,
    agentId: agent.id,
    cwd,
    nativeSessionId: `native-${id}`,
    title,
    archived: false,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    configOptions: null,
  };
}
function official(
  nativeSessionId: string,
  title: string,
  cwd: string,
  alreadyAddedId: string | null = null,
): DiscoveredConversation {
  return {
    nativeSessionId,
    cwd,
    title,
    updatedAt: null,
    canLoad: true,
    locationAvailable: true,
    alreadyAddedId,
    isOpen: false,
  };
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  let result = "";
  Children.forEach(node, (child) => {
    if (isValidElement<{ children?: ReactNode }>(child))
      result += text(child.props.children);
    else if (typeof child === "string" || typeof child === "number")
      result += String(child);
  });
  return result;
}
function render() {
  h.cursor = 0;
  ImportConversations(props);
  for (const effect of h.effects.splice(0)) effect();
  h.cursor = 0;
  const tree = ImportConversations(props);
  const elements: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return elements;
}
function button(label: string) {
  return render().find(
    (node) =>
      node.type === "button" &&
      text(node.props.children as ReactNode) === label,
  );
}
function click(node: Element | undefined) {
  expect(node).toBeDefined();
  expect(node!.props.disabled).not.toBe(true);
  (node!.props.onClick as () => void)();
}
async function idle() {
  await vi.waitFor(() =>
    expect(button(S.chooseLocation)?.props.disabled).toBe(false),
  );
}
async function lookup(rows: DiscoveredConversation[]) {
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: rows,
    nextCursor: null,
  });
  click(button(S.search));
  await idle();
  expect(h.discover).toHaveBeenCalledExactlyOnceWith("a", undefined, null);
}
beforeEach(() => {
  h.slots.length = 0;
  h.effects.length = 0;
  h.index.length = 0;
  for (const mock of [
    h.choose,
    h.discover,
    h.preview,
    h.closePreview,
    h.commit,
    h.refresh,
    h.prompt,
  ])
    mock.mockReset();
  h.closePreview.mockResolvedValue(undefined);
  props = {
    agents: [agent],
    open: true,
    initialAgentId: "a",
    requestRevision: 1,
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onPrepare: vi.fn(),
  };
});
async function show(status = "completed", complete = true) {
  const row = official("owned", "Owned history", "/owned");
  const state = freshThreadState("preview", "a", row.cwd, row.nativeSessionId);
  state.items = [
    {
      kind: "agent",
      id: "answer",
      text: "Retained answer",
      attachments: [],
      streaming: false,
      time: 0,
    },
    {
      kind: "tool",
      id: "tool-row",
      call: {
        toolCallId: "page",
        title: "Read page",
        kind: "fetch",
        status,
        locations: [{ path: "/owned/result.txt" }],
        startedAt: 0,
        content: [
          {
            type: "attachment",
            attachment: {
              name: "Page image",
              kind: "image",
              mimeType: "image/png",
              data: PNG_IMAGE_TEST_DATA,
            },
          },
        ],
        rawOutput: { original: "unchanged" },
      },
    },
  ];
  h.preview.mockResolvedValue({
    agentId: "a",
    cwd: row.cwd,
    nativeSessionId: row.nativeSessionId,
    purpose: "searchReadOnly",
    previewToken: "owned-token",
    replayComplete: complete,
    state,
  });
  await lookup([row]);
  click(
    render().find(
      (node) =>
        node.type === "button" &&
        text(node.props.children as ReactNode).startsWith(row.title!),
    ),
  );
  await idle();
  return state;
}
it.each(["completed", "failed", "pending", "in_progress", "unrecognized"])(
  "shows a read-only %s tool without implying live work or granting actions",
  async (status) => {
    const state = await show(status);
    const tool = render().find((node) => node.type === ToolStep);
    expect(tool).toBeDefined();
    expect(tool!.props.call).toBe(
      state.items[1].kind === "tool" ? state.items[1].call : null,
    );
    expect(tool!.props.activity).toBe(
      ["completed", "failed"].includes(status) ? "finished" : "unknown",
    );
    expect(tool!.props.onOpenFile).toBeUndefined();
    expect(tool!.props.onOpenArtifacts).toBeUndefined();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.prompt).not.toHaveBeenCalled();
    expect(props.onOpen).not.toHaveBeenCalled();
  },
);
it("does not expose incomplete preview tools", async () => {
  await show("completed", false);
  expect(render().some((node) => node.type === ToolStep)).toBe(false);
});
it("hides preview media and closes its exact readonly owner without committing", async () => {
  await show();
  click(button(S.cancel));
  await vi.waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  props = { ...props, open: false };
  expect(render().some((node) => node.type === ToolStep)).toBe(false);
  await vi.waitFor(() =>
    expect(h.closePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        previewToken: "owned-token",
        nativeSessionId: "owned",
        purpose: "searchReadOnly",
      }),
    ),
  );
  expect(h.commit).not.toHaveBeenCalled();
  expect(h.prompt).not.toHaveBeenCalled();
});
it("keeps already-added rows on their existing open path without a new preview", async () => {
  const local = saved("joined", "Owned history", "/owned");
  h.index.push(local);
  const row = official(
    local.nativeSessionId!,
    "Official title",
    local.cwd,
    local.id,
  );
  await lookup([row]);
  click(
    render().find(
      (node) =>
        node.type === "button" &&
        text(node.props.children as ReactNode).startsWith(row.title!),
    ),
  );
  await idle();
  expect(h.preview).not.toHaveBeenCalled();
  expect(render().some((node) => node.type === ToolStep)).toBe(false);
  click(button(S.open));
  await vi.waitFor(() => expect(props.onOpen).toHaveBeenCalledWith(local));
});
