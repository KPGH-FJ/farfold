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
  choose: vi.fn(),
  discover: vi.fn(),
  preview: vi.fn(),
  closePreview: vi.fn(),
  commit: vi.fn(),
  refresh: vi.fn(),
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
            ? (next as (v: unknown) => unknown)(slot.value)
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
vi.mock("../runtime/history_import", () => ({
  discoverHistory: h.discover,
  previewHistory: h.preview,
  closeHistoryPreview: h.closePreview,
  commitHistoryPreview: h.commit,
  hasPreviewContent: () => true,
  historyContinuation: () => ({
    title: "Read only",
    detail: "Verify before sending",
  }),
}));
vi.mock("../runtime/sessions", () => ({
  threads: { getSnapshot: () => ({ index: [] }), refreshIndex: h.refresh },
}));
import { ImportConversations } from "./ImportConversations";
import { IMPORT_STRINGS as S } from "../runtime/import_strings";
import type { AgentCardModel } from "../runtime/agents";
import type { DiscoveredConversation } from "../runtime/history_import";

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
const row: DiscoveredConversation = {
  nativeSessionId: "original",
  cwd: "/original",
  title: "Original result",
  updatedAt: null,
  canLoad: true,
  locationAvailable: true,
  alreadyAddedId: null,
  isOpen: false,
};
let props: ComponentProps<typeof ImportConversations>;
type Element = ReactElement<Record<string, unknown>>;
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
    (node) => node.type === "button" && node.props.children === label,
  );
}
function click(label: string) {
  const node = button(label);
  expect(node).toBeDefined();
  expect(node!.props.disabled).not.toBe(true);
  (node!.props.onClick as () => void)();
}
async function idle() {
  await vi.waitFor(() =>
    expect(button(S.chooseLocation)?.props.disabled).toBe(false),
  );
}
function outcomes() {
  return render().filter((node) =>
    String(node.props.className ?? "")
      .split(" ")
      .includes("history-outcome"),
  );
}
function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string"
        ? child
        : isValidElement<{ children: ReactNode }>(child)
          ? text(child.props.children)
          : "",
    )
    .join("");
}
beforeEach(() => {
  h.slots.length = 0;
  h.effects.length = 0;
  h.choose.mockReset();
  h.discover.mockReset().mockResolvedValue({
    status: "supported",
    sessions: [row],
    nextCursor: null,
  });
  h.preview.mockReset().mockImplementation(async (agentId, record) => ({
    agentId,
    cwd: record.cwd,
    nativeSessionId: record.nativeSessionId,
    previewToken: `preview-${record.nativeSessionId}`,
    replayComplete: true,
    state: { items: [], configOptions: [] },
  }));
  h.closePreview.mockReset().mockResolvedValue(undefined);
  h.commit.mockReset().mockImplementation(async (preview, title) => ({
    id: `saved-${preview.nativeSessionId}`,
    agentId: preview.agentId,
    cwd: preview.cwd,
    nativeSessionId: preview.nativeSessionId,
    title,
    archived: false,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    configOptions: null,
  }));
  h.refresh.mockReset().mockResolvedValue(undefined);
  props = {
    agents: [agent],
    open: true,
    initialAgentId: "a",
    requestRevision: 1,
    onClose: vi.fn(),
    onOpen: vi.fn(),
  };
});

it("shows the joined result as the only outcome after a clean add", async () => {
  click(S.search);
  await idle();
  (
    render().find(
      (node) => node.type === "input" && node.props.type === "checkbox",
    )!.props.onChange as () => void
  )();
  click(S.add);
  await idle();
  const blocks = outcomes();
  expect(blocks).toHaveLength(1);
  expect(blocks[0].props.role).toBe("status");
  expect(text(blocks[0].props.children as ReactNode)).toContain(
    S.addedCount(1),
  );
  expect(text(blocks[0].props.children as ReactNode)).toContain(S.joinedHint);
  // No technical-details disclosure is part of a clean success.
  expect(
    render().some((node) => node.props.children === S.outcomeDetails),
  ).toBe(false);
  expect(render().some((node) => node.props.children === S.empty)).toBe(false);
});

it("shows one incomplete outcome with technical detail collapsed behind a disclosure", async () => {
  h.commit.mockRejectedValueOnce(new Error("private commit details"));
  click(S.search);
  await idle();
  (
    render().find(
      (node) => node.type === "input" && node.props.type === "checkbox",
    )!.props.onChange as () => void
  )();
  click(S.add);
  await idle();
  const blocks = outcomes();
  expect(blocks).toHaveLength(1);
  expect(blocks[0].props.role).toBe("alert");
  const alertText = text(blocks[0].props.children as ReactNode);
  expect(alertText).toContain(S.operationIncomplete);
  expect(alertText).toContain(S.partialHint);
  // The technical reason stays inside the collapsed details, not the headline.
  const details = render().find(
    (node) =>
      node.type === "details" &&
      node.props.className === "history-outcome-details",
  )!;
  expect(details).toBeDefined();
  expect(details.props.open).not.toBe(true);
  expect(text(details.props.children as ReactNode)).toContain(S.addFailed);
  expect(text(details.props.children as ReactNode)).toContain(row.title);
  // The headline itself carries no backend message.
  const headline = blocks[0].props.children as ReactNode;
  expect(text(headline).startsWith(S.addFailed)).toBe(false);
});

it("shows the empty/unsupported state as the third outcome without an alert or success block", async () => {
  h.discover.mockResolvedValueOnce({
    status: "unsupported",
    sessions: [],
    nextCursor: null,
  });
  click(S.search);
  await idle();
  expect(outcomes()).toHaveLength(0);
  const nodes = render();
  expect(nodes.some((node) => node.props.children === S.unsupportedTitle)).toBe(
    true,
  );
  expect(nodes.some((node) => node.props.children === S.unsupported)).toBe(
    true,
  );
  expect(nodes.some((node) => node.props.children === S.empty)).toBe(false);

  // A plain empty list stays distinct from an unsupported Agent.
  h.discover.mockResolvedValueOnce({
    status: "supported",
    sessions: [],
    nextCursor: null,
  });
  click(S.again);
  await idle();
  const cleared = render();
  expect(cleared.some((node) => node.props.children === S.empty)).toBe(true);
  expect(
    cleared.some((node) => node.props.children === S.unsupportedTitle),
  ).toBe(false);
  expect(outcomes()).toHaveLength(0);
});
