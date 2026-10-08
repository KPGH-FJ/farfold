import { expect, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ServiceIdentity } from "./runtime/credentials";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  draft: { text: "OWN-ORIGINAL-DRAFT", attachments: [] as unknown[] },
  choice: {
    agentId: "A" as string | null,
    cwd: "/draft-A" as string | null,
    service: null,
    config: { model: "model-A", reasoning: "ultra" } as Record<string, unknown>,
  },
  threads: new Map<
    string,
    {
      key: string;
      agentId: string;
      cwd: string;
      nativeSessionId: string;
      configOptions: unknown[];
      service?: ServiceIdentity;
      serviceContext?: string;
      recordedModel?: string;
      modelDrift?: boolean;
      sourceError?: boolean;
    }
  >(),
  open: vi.fn(),
  clearDraft: vi.fn(),
  reconnect: vi.fn(),
  index: [] as {
    agentId: string;
    id?: string;
    cwd?: string;
    nativeSessionId?: string | null;
  }[],
  notification: null as ((key: string) => void | Promise<void>) | null,
  prepared: new Set(["A", "B"]),
  selections: new Map<
    string,
    {
      service: null | { id: string; model: string; revision: string };
      config: Record<string, unknown>;
    }
  >(),
  cards: ["A", "B"].map((id) => ({ id, name: id, status: "connected" })),
  menuHandlers: new Map<
    string,
    (event: { payload: { action: string } }) => void
  >(),
}));
export { h };
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots))
      h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[index],
      (value: unknown) => {
        h.slots[index] =
          typeof value === "function" ? value(h.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = { current: initial };
    return h.slots[index];
  },
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const index = h.cursor++,
      previous = h.effects[index];
    if (
      !previous ||
      !deps ||
      deps.some((value, i) => !Object.is(value, previous.deps?.[i]))
    ) {
      const next = { deps } as typeof previous;
      h.effects[index] = next;
      h.pending.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect() || undefined;
      });
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "/ordinary"),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      event: string,
      handler: (event: { payload: { action: string } }) => void,
    ) => {
      h.menuHandlers.set(event, handler);
      return () => {
        h.menuHandlers.delete(event);
      };
    },
  ),
}));
vi.mock("./runtime/work_policy", () => ({ startWorkEvents: () => () => {} }));
vi.mock("./runtime/auto_archive", () => ({ startAutoArchive: () => () => {} }));
vi.mock("./runtime/notification_navigation", () => ({
  notificationNavigation: async (
    select: (key: string) => void | Promise<void>,
  ) => {
    h.notification = select;
    return () => {
      h.notification = null;
    };
  },
}));
vi.mock("./runtime/agents", () => ({
  useAgents: () => ({ cards: h.cards, loading: false, refresh: vi.fn() }),
}));
vi.mock("./runtime/theme", () => ({
  useThemePreference: () => ["system", vi.fn(), "light"],
}));
vi.mock("./runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: (id: string) => h.prepared.has(id),
    confirmedSelection: (id: string) =>
      h.prepared.has(id)
        ? (h.selections.get(id) ?? { service: null, config: {} })
        : undefined,
  },
}));
vi.mock("./runtime/performance-trace", () => ({ traceAfterPaint: vi.fn() }));
vi.mock("./runtime/drafts", () => ({
  composerDrafts: {
    read: () => h.draft,
    clear: h.clearDraft,
    update: (
      _key: string,
      update: (draft: typeof h.draft) => typeof h.draft,
    ) => {
      h.draft = update(h.draft);
    },
  },
  newConversationChoice: h.choice,
}));
vi.mock("./runtime/collections", async (original) => ({
  ...(await original<typeof import("./runtime/collections")>()),
  CollectionActionScope: class {},
}));
vi.mock("./runtime/sessions", () => ({
  threads: {
    subscribe: () => () => {},
    getSnapshot: () => ({ index: h.index }),
    thread: (key: string) => h.threads.get(key),
    refreshIndex: vi.fn(async () => {}),
    open: h.open,
    reconnect: h.reconnect,
    markOpenFailed: vi.fn(),
    archiveBlockReason: () => null,
    needsAttention: () => false,
    openArtifactPane: vi.fn(),
    closeArtifactPane: vi.fn(),
  },
  paneCards: () => [],
  basename: (path: string) => path.split("/").at(-1) ?? path,
  hasActiveTools: () => false,
  useThread: (key: string) => h.threads.get(key),
  useThreadsSnapshot: () => ({ index: h.index }),
}));
vi.mock("./components/CommandPalette", () => ({
  CommandPalette: function CommandPalette() {
    return null;
  },
}));
vi.mock("./components/EmptyState", () => ({
  EmptyState: function EmptyState() {
    return null;
  },
}));
vi.mock("./components/SettingsPage", () => ({
  SettingsPage: function SettingsPage() {
    return null;
  },
}));
vi.mock("./components/Sidebar", () => ({
  Sidebar: function Sidebar() {
    return null;
  },
}));
vi.mock("./components/ThreadView", () => ({
  ThreadView: function ThreadView() {
    return null;
  },
}));
vi.mock("./components/AgentHub", () => ({
  AgentHub: function AgentHub() {
    return null;
  },
}));
vi.mock("./components/ConversationLibrary", () => ({
  ConversationLibrary: function ConversationLibrary() {
    return null;
  },
}));
vi.mock("./components/WorkspaceDialog", () => ({
  WorkspaceDialog: function WorkspaceDialog() {
    return null;
  },
}));
vi.mock("./components/ImportConversations", () => ({
  ImportConversations: function ImportConversations() {
    return null;
  },
}));
import App from "./App";
import { observeAuthentication } from "./runtime/authentication";
import { allowAutomaticConnection } from "./runtime/connection_intent";

type Element = ReactElement<Record<string, unknown>>;
export function render() {
  h.cursor = 0;
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(App());
  for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
export function component(name: string) {
  const node = render().find(
    (item) => typeof item.type === "function" && item.type.name === name,
  );
  expect(node, `missing ${name}`).toBeDefined();
  return node!.props;
}
export function call(name: string, event: string, ...args: unknown[]) {
  (component(name)[event] as (...args: unknown[]) => void)(...args);
}
export async function resetHarness() {
  allowAutomaticConnection("A");
  allowAutomaticConnection("B");
  h.prepared = new Set(["A", "B"]);
  h.selections.clear();
  h.cards = ["A", "B"].map((id) => ({ id, name: id, status: "connected" }));
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.open.mockReset();
  h.clearDraft.mockReset();
  h.reconnect.mockReset();
  h.index = [];
  h.notification = null;
  h.threads.clear();
  h.draft = { text: "OWN-ORIGINAL-DRAFT", attachments: [] };
  Object.assign(h.choice, {
    agentId: "A",
    cwd: "/draft-A",
    service: null,
    config: { model: "model-A", reasoning: "ultra" },
  });
  for (const key of ["old-A", "test-B"])
    h.threads.set(key, {
      key,
      agentId: key === "old-A" ? "A" : "B",
      cwd: `/${key}`,
      nativeSessionId: key,
      configOptions: [
        {
          id: "model",
          currentValue: key === "old-A" ? "locked-model-A" : "test-model-B",
        },
      ],
    });
  vi.stubGlobal("window", {
    location: { hash: "" },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal(
    "setInterval",
    vi.fn(() => 1),
  );
  vi.stubGlobal("clearInterval", vi.fn());
  render();
  await Promise.resolve();
  render();
}
export function cleanupHarness() {
  observeAuthentication("A", "/old-A", undefined, "original-api-context");
  for (const effect of h.effects) effect?.cleanup?.();
  vi.unstubAllGlobals();
}
