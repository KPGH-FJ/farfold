import { beforeEach, afterEach, expect, it, vi } from "vitest";
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
  reconnect: vi.fn(),
  cards: ["A", "B"].map((id) => ({ id, name: id, status: "connected" })),
}));
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
vi.mock("./runtime/work_policy", () => ({ startWorkEvents: () => () => {} }));
vi.mock("./runtime/auto_archive", () => ({ startAutoArchive: () => () => {} }));
vi.mock("./runtime/agents", () => ({
  useAgents: () => ({ cards: h.cards, loading: false, refresh: vi.fn() }),
}));
vi.mock("./runtime/theme", () => ({
  useThemePreference: () => ["system", vi.fn(), "light"],
}));
vi.mock("./runtime/performance-trace", () => ({ traceAfterPaint: vi.fn() }));
vi.mock("./runtime/drafts", () => ({
  composerDrafts: { read: () => h.draft },
  newConversationChoice: h.choice,
}));
vi.mock("./runtime/collections", async (original) => ({
  ...(await original<typeof import("./runtime/collections")>()),
  CollectionActionScope: class {},
}));
vi.mock("./runtime/sessions", () => ({
  threads: {
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
  useThreadsSnapshot: () => ({ index: [] }),
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
import { freshThreadState } from "./runtime/session_projection";
import { threads } from "./runtime/sessions";
import { WORKSPACE_STRINGS as W } from "./runtime/workspace_strings";
import { preparationFor } from "./runtime/agent_preparation";
import { requireReadableHistory } from "./runtime/session_recovery";

type Element = ReactElement<Record<string, unknown>>;
function render() {
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
function component(name: string) {
  const node = render().find(
    (item) => typeof item.type === "function" && item.type.name === name,
  );
  expect(node, `missing ${name}`).toBeDefined();
  return node!.props;
}

it("keeps the other filter dimensions when the sidebar changes Agent or group", () => {
  call("ConversationLibrary", "onFilter", {
    kind: "selection",
    agent: "A",
    group: "group-1",
    favorites: false,
    state: "archived",
    query: "find this",
  });
  call("Sidebar", "onLibrary", { kind: "agent", id: "B" });
  expect(component("ConversationLibrary").filter).toEqual({
    kind: "selection",
    agent: "B",
    group: "group-1",
    favorites: false,
    state: "archived",
    query: "find this",
  });
  call("Sidebar", "onLibrary", { kind: "group", id: "group-2" });
  expect(component("ConversationLibrary").filter).toMatchObject({
    agent: "B",
    group: "group-2",
    state: "archived",
    query: "find this",
  });
  call("Sidebar", "onLibrary", { kind: "all" });
  expect(component("ConversationLibrary").filter).toEqual({ kind: "all" });
});
function call(name: string, event: string, ...args: unknown[]) {
  (component(name)[event] as (...args: unknown[]) => void)(...args);
}
beforeEach(async () => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.open.mockReset();
  h.reconnect.mockReset();
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
});
afterEach(() => {
  observeAuthentication("A", "/old-A", undefined, "original-api-context");
  for (const effect of h.effects) effect?.cleanup?.();
  vi.unstubAllGlobals();
});

function pendingHistory(outcome: "success" | "empty") {
  const raw = "A:/alias:history";
  const canonical = "A:/canonical:history";
  const state = freshThreadState(canonical, "A", "/canonical", "history");
  state.identity = "established";
  let resolve!: (value: typeof state) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<typeof state>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  h.open.mockReturnValueOnce(promise);
  const open = () =>
    call("ConversationLibrary", "onOpen", {
      id: raw,
      agentId: "A",
      cwd: "/alias",
      nativeSessionId: "history",
    });
  return {
    raw,
    canonical,
    open,
    promise,
    async complete() {
      h.threads.delete(raw);
      h.threads.set(canonical, state);
      if (outcome === "success") resolve(state);
      else {
        try {
          requireReadableHistory(
            "A",
            {
              cwd: "/canonical",
              nativeSessionId: "history",
              configOptions: [],
              resumed: true,
              warnings: [],
            },
            [],
            true,
            false,
          );
          throw new Error("fixture must produce a local empty-history failure");
        } catch (error) {
          reject(error);
        }
      }
      await promise.catch(() => undefined);
      await Promise.resolve();
    },
  };
}

it.each(["success", "empty"] as const)(
  "follows the exact canonical key from a cold history open with %s outcome",
  async (outcome) => {
    const draft = h.draft;
    const history = pendingHistory(outcome);
    history.open();
    expect(component("ThreadPage").viewKey).toBe(history.raw);
    await history.complete();
    expect(component("ThreadPage").viewKey).toBe(history.canonical);
    expect(component("ThreadPage").active).toBe(true);
    expect(h.open).toHaveBeenCalledExactlyOnceWith({
      agentId: "A",
      cwd: "/alias",
      nativeSessionId: "history",
    });
    expect(h.draft).toBe(draft);
  },
);

it.each(["success", "empty"] as const)(
  "does not take focus from B after an earlier history open settles with %s",
  async (outcome) => {
    const history = pendingHistory(outcome);
    history.open();
    call("ConversationLibrary", "onOpen", {
      id: "test-B",
      agentId: "B",
      cwd: "/test-B",
      nativeSessionId: "test-B",
    });
    await history.complete();
    expect(component("ThreadPage").viewKey).toBe("test-B");
    expect(component("ThreadPage").active).toBe(true);
  },
);

it("keeps Start visible when the pending history returns a canonical failure", async () => {
  const history = pendingHistory("empty");
  history.open();
  call("Sidebar", "onNew");
  await history.complete();
  expect(component("EmptyState").active).toBe(true);
  expect(component("ThreadPage").active).toBe(false);
  expect(component("ThreadPage").viewKey).toBe(history.raw);
});

it("only follows the newest open of the same raw history target", async () => {
  const older = pendingHistory("empty");
  const newer = pendingHistory("success");
  older.open();
  newer.open();
  await older.complete();
  expect(component("ThreadPage").viewKey).toBe(newer.raw);
  await newer.complete();
  expect(component("ThreadPage").viewKey).toBe(newer.canonical);
  expect(h.open).toHaveBeenCalledTimes(2);
});

it("repairs only the saved history origin while settings stays visible", async () => {
  const history = pendingHistory("empty");
  history.open();
  call("Sidebar", "onSettings");
  await history.complete();
  expect(component("SettingsPage").active).toBe(true);
  expect(component("ThreadPage").active).toBe(false);
  call("SettingsPage", "onReturn");
  expect(component("ThreadPage").viewKey).toBe(history.canonical);
  expect(component("ThreadPage").active).toBe(true);
});

it.each(["success", "empty"] as const)(
  "the App owns a retry's canonical %s result after its raw thread disappears",
  async (outcome) => {
    const history = pendingHistory(outcome);
    h.open.mockReset();
    h.threads.set(
      history.raw,
      freshThreadState(history.raw, "A", "/alias", "history"),
    );
    history.open();
    h.reconnect.mockReturnValueOnce(history.promise);
    call("ThreadPage", "onRecover", history.raw);
    h.threads.delete(history.raw);
    render();
    await history.complete();
    expect(h.reconnect).toHaveBeenCalledExactlyOnceWith(history.raw);
    expect(component("ThreadPage").viewKey).toBe(history.canonical);
    expect(component("ThreadPage").active).toBe(true);
  },
);

it.each(["B", "start", "settings"] as const)(
  "a retry's late canonical result preserves the newer %s destination",
  async (destination) => {
    const history = pendingHistory("success");
    h.open.mockReset();
    h.threads.set(
      history.raw,
      freshThreadState(history.raw, "A", "/alias", "history"),
    );
    history.open();
    h.reconnect.mockReturnValueOnce(history.promise);
    call("ThreadPage", "onRecover", history.raw);
    if (destination === "B")
      call("ConversationLibrary", "onOpen", {
        id: "test-B",
        agentId: "B",
        cwd: "/test-B",
        nativeSessionId: "test-B",
      });
    else call("Sidebar", destination === "start" ? "onNew" : "onSettings");
    await history.complete();
    if (destination === "B") {
      expect(component("ThreadPage").viewKey).toBe("test-B");
      expect(component("ThreadPage").active).toBe(true);
    } else {
      expect(component("ThreadPage").active).toBe(false);
      expect(
        component(destination === "start" ? "EmptyState" : "SettingsPage")
          .active,
      ).toBe(true);
      if (destination === "settings") {
        call("SettingsPage", "onReturn");
        expect(component("ThreadPage").viewKey).toBe(history.canonical);
        expect(component("ThreadPage").active).toBe(true);
      }
    }
  },
);

it("does not follow a remote error with a lookalike canonical-key field", async () => {
  const error = Object.assign(new Error("upstream failure"), {
    failedKey: "B:/elsewhere:other",
  });
  const response = Promise.reject(error);
  h.open.mockReturnValueOnce(response);
  call("ConversationLibrary", "onOpen", {
    id: "A:/alias:history",
    agentId: "A",
    cwd: "/alias",
    nativeSessionId: "history",
  });
  await response.catch(() => undefined);
  expect(component("ThreadPage").viewKey).toBe("A:/alias:history");
  expect(component("ThreadPage").active).toBe(true);
});

it("passes the actual pointer content trigger through ThreadPage to ThreadView", () => {
  const thread = freshThreadState("old-A", "A", "/old-A", "old-A");
  h.threads.set(thread.key, thread);
  call("Sidebar", "onLibrary", { kind: "all" });
  call("ConversationLibrary", "onOpen", {
    id: thread.key,
    agentId: thread.agentId,
    cwd: thread.cwd,
    nativeSessionId: thread.nativeSessionId,
  });
  const page = render().find(
    (node) =>
      typeof node.type === "function" && node.type.name === "ThreadPage",
  )!;
  // Render the real page in its own hook scope; its child remains inspectable.
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.cursor = 0;
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
      visit(child.props.header as ReactNode);
    });
  visit(
    (page.type as (props: Record<string, unknown>) => ReactNode)(page.props),
  );
  const view = nodes.find(
    (node) =>
      typeof node.type === "function" && node.type.name === "ThreadView",
  )!;
  const toggle = nodes.find(
    (node) => node.props["aria-label"] === W.showContent,
  )!;
  const opener = {};
  (toggle.props.onClick as (event: unknown) => void)({ currentTarget: opener });
  expect(
    (view.props.artifactReturnFocusRef as { current: unknown }).current,
  ).toBe(opener);
  expect(threads.openArtifactPane).toHaveBeenCalledWith(thread.key);
  thread.artifactPaneOpen = true;
  (toggle.props.onClick as (event: unknown) => void)({ currentTarget: {} });
  expect(
    (view.props.artifactReturnFocusRef as { current: unknown }).current,
  ).toBe(opener);
  expect(threads.closeArtifactPane).toHaveBeenCalledWith(thread.key);
  h.pending = [];
});

it("restores the original established conversation after opening a test conversation from Agent management", () => {
  const original = structuredClone(h.threads.get("old-A"));
  call("Sidebar", "onLibrary", { kind: "all" });
  call("ConversationLibrary", "onOpen", {
    id: "old-A",
    agentId: "A",
    cwd: "/old-A",
    nativeSessionId: "old-A",
  });
  expect(component("ThreadPage").viewKey).toBe("old-A");
  call("ThreadPage", "onGoSettings");
  expect(component("AgentHub").initialIntent).toBe("manage");
  call("AgentHub", "onOpenConversation", "test-B");
  expect(component("ThreadPage").viewKey).toBe("test-B");
  call("ThreadPage", "onBack");
  expect(component("AgentHub").active).toBe(true);
  call("AgentHub", "onReturn");
  expect(component("ThreadPage").active).toBe(true);
  expect(component("ThreadPage").viewKey).toBe("old-A");
  expect(h.threads.get("old-A")).toEqual(original);
  expect(h.open).not.toHaveBeenCalled();
});

it.each(["draft", "unrecoverable"])(
  "returns a gated %s to separate model preparation without changing its original selection or opening a conversation",
  (kind) => {
    const id = `gated-${kind}`;
    const thread = freshThreadState(id, id, `/original-${kind}`, "original");
    thread.identity = kind === "draft" ? "draft" : "established";
    thread.unrecoverable = kind === "unrecoverable";
    thread.configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "original-model",
        options: [],
      },
      {
        id: "mode",
        name: "Thinking",
        type: "select",
        currentValue: "off",
        options: [],
      },
    ];
    h.threads.set(id, thread);
    preparationFor(id).requireExplicitRead(thread);
    const before = structuredClone(thread),
      draft = h.draft,
      choice = structuredClone(h.choice);
    call("Sidebar", "onLibrary", { kind: "all" });
    call("ConversationLibrary", "onOpen", {
      id,
      agentId: id,
      cwd: thread.cwd,
      nativeSessionId: "original",
    });
    call("ThreadPage", "onGoSettings");
    expect(component("AgentHub").initialIntent).toBe("manage");
    expect(component("AgentHub").preparationContext).toMatchObject({
      agentId: id,
      cwd: thread.cwd,
      repair: { panel: "model" },
      preserveOrigin: true,
      selection: {
        service: null,
        config: { model: "original-model", mode: "off" },
      },
    });
    expect(
      (component("AgentHub").preparationContext as Record<string, unknown>)
        .conversation,
    ).toBeUndefined();
    call("AgentHub", "onReturn");
    expect(component("ThreadPage").viewKey).toBe(id);
    expect(component("ThreadPage").active).toBe(true);
    expect(h.threads.get(id)).toEqual(before);
    expect(h.draft).toBe(draft);
    expect(h.choice).toEqual(choice);
    expect(h.open).not.toHaveBeenCalled();
  },
);

it("restores A's preparation and draft origin after API settings temporarily manages B", () => {
  const originalDraft = h.draft;
  call("EmptyState", "onGoSettings", "A");
  const originalContext = component("AgentHub").preparationContext;
  const surface = {
    selected: "A",
    detail: null,
    view: "added",
    query: "A",
    source: "all",
    availability: "all",
    intent: "use",
  };
  call("AgentHub", "onStateChange", surface);
  call("AgentHub", "onOpenApi");
  call("SettingsPage", "onManageAgent", "B");
  expect(component("AgentHub").initialAgentId).toBe("B");
  expect(component("AgentHub").initialIntent).toBe("manage");
  call("AgentHub", "onReturn");
  expect(component("SettingsPage").active).toBe(true);
  expect(component("SettingsPage").tab).toBe("keys");
  call("SettingsPage", "onReturn");
  const restored = component("AgentHub");
  expect(restored.active).toBe(true);
  expect(restored.initialAgentId).toBe("A");
  expect(restored.initialIntent).toBe("use");
  expect(restored.preparationContext).toEqual(originalContext);
  expect(restored.restoredState).toEqual(surface);
  const selected = {
    service: null,
    config: { model: "newly-confirmed-model", reasoning: "ultra" },
  };
  call("AgentHub", "onStart", "A", selected);
  expect(component("EmptyState").active).toBe(true);
  expect(component("EmptyState").initialSelection).toEqual(selected);
  expect(
    render().some(
      (node) =>
        typeof node.type === "function" && node.type.name === "WorkspaceDialog",
    ),
  ).toBe(false);
  expect(h.draft).toBe(originalDraft);
  expect(h.choice.config).toEqual({ model: "model-A", reasoning: "ultra" });
  expect(h.open).not.toHaveBeenCalled();
});

it("opens My Agents from settings and returns to the exact settings tab without changing the draft", () => {
  const originalDraft = h.draft;
  const originalChoice = structuredClone(h.choice);
  call("Sidebar", "onSettings");
  call("SettingsPage", "onTabChange", "keys");
  call("SettingsPage", "onOpenAgents");
  expect(component("AgentHub").active).toBe(true);
  expect(component("AgentHub").initialAgentId).toBe(null);
  expect(component("AgentHub").initialView).toBe("added");
  call("AgentHub", "onReturn");
  expect(component("SettingsPage").active).toBe(true);
  expect(component("SettingsPage").tab).toBe("keys");
  expect(h.draft).toBe(originalDraft);
  expect(h.choice).toEqual(originalChoice);
  expect(h.open).not.toHaveBeenCalled();
});

it("opens custom preparation in the directory without detouring through settings", () => {
  call("Sidebar", "onExplore");
  call("AgentHub", "onCustom");
  expect(component("CustomAgentDialog")).toBeDefined();
  call("CustomAgentDialog", "onAdded", "new-custom");
  expect(component("AgentHub").initialAgentId).toBe("new-custom");
  expect(component("AgentHub").initialView).toBe("added");
  expect(component("AgentHub").initialIntent).toBe("use");
  expect(h.open).not.toHaveBeenCalled();
});

it("keeps the originating draft and location when adding an Agent inside its discovery journey", () => {
  const originalDraft = h.draft;
  call("EmptyState", "onGoSettings", "A");
  const context = component("AgentHub").preparationContext;
  call("AgentHub", "onCustom");
  call("CustomAgentDialog", "onAdded", "new-custom");
  expect(component("AgentHub").preparationContext).toEqual(context);
  const selection = {
    service: null,
    config: { model: "custom-model", reasoning: "ultra" },
  };
  call("AgentHub", "onStart", "new-custom", selection, "new-conversation");
  expect(component("EmptyState").active).toBe(true);
  expect(component("EmptyState").initialSelection).toEqual(selection);
  expect(
    render().some(
      (node) =>
        typeof node.type === "function" && node.type.name === "WorkspaceDialog",
    ),
  ).toBe(false);
  expect(h.draft).toBe(originalDraft);
  expect(h.open).not.toHaveBeenCalled();
});

it("returns from history preparation and nested settings to the same import without consuming the global draft", () => {
  const originalDraft = h.draft;
  const originalChoice = structuredClone(h.choice);
  call("Sidebar", "onLibrary", { kind: "all" });
  call("ConversationLibrary", "onImport");
  const originalImport = component("ImportConversations");
  call("ImportConversations", "onPrepare", "B", "/history-folder");
  expect(component("ImportConversations").open).toBe(false);
  expect(component("AgentHub").initialAgentId).toBe("B");
  expect(component("AgentHub").initialIntent).toBe("manage");
  expect(component("AgentHub").preparationContext).toMatchObject({
    agentId: "B",
    cwd: "/history-folder",
  });
  call("AgentHub", "onOpenApi");
  call("SettingsPage", "onReturn");
  expect(component("AgentHub").active).toBe(true);
  call("AgentHub", "onReturn");
  expect(component("ImportConversations").open).toBe(true);
  expect(component("ImportConversations").requestRevision).toBe(
    originalImport.requestRevision,
  );
  expect(h.draft).toBe(originalDraft);
  expect(h.choice).toEqual(originalChoice);
  expect(h.open).not.toHaveBeenCalled();
});

it("does not apply a prepared selection to the global draft when the caller belongs to history", () => {
  const originalDraft = h.draft;
  const originalChoice = structuredClone(h.choice);
  call("Sidebar", "onLibrary", { kind: "all" });
  call("ConversationLibrary", "onImport");
  call("ImportConversations", "onPrepare", "B", null);
  call("AgentHub", "onStart", "B", {
    service: null,
    config: { model: "B-model" },
  });
  expect(component("ImportConversations").open).toBe(true);
  expect(h.draft).toBe(originalDraft);
  expect(h.choice).toEqual(originalChoice);
  expect(component("EmptyState").initialSelection).toBeUndefined();
  expect(h.open).not.toHaveBeenCalled();
});

it("opens a new conversation from unsupported history while preserving the same Agent draft choice", () => {
  const draft = h.draft;
  const choice = structuredClone(h.choice);
  call("Sidebar", "onLibrary", { kind: "all" });
  call("ConversationLibrary", "onImport");
  call("ImportConversations", "onNew", "A");
  expect(component("ImportConversations").open).toBe(false);
  expect(component("EmptyState").active).toBe(true);
  expect(component("EmptyState").initialAgentId).toBe("A");
  expect(component("EmptyState").initialSelection).toEqual({
    service: choice.service,
    config: choice.config,
  });
  expect(h.draft).toBe(draft);
  expect(h.open).not.toHaveBeenCalled();
});

it("asks before replacing a separate draft from the unsupported-history new-conversation exit", () => {
  const draft = h.draft;
  const choice = structuredClone(h.choice);
  call("Sidebar", "onLibrary", { kind: "all" });
  call("ConversationLibrary", "onImport");
  call("ImportConversations", "onNew", "B");
  expect(component("WorkspaceDialog")).toBeDefined();
  expect(component("EmptyState").active).toBe(false);
  expect(h.draft).toBe(draft);
  expect(h.choice).toEqual(choice);
  expect(h.open).not.toHaveBeenCalled();
});

it("returns a first preparation completion to its established conversation without changing either conversation or global draft", () => {
  const original = structuredClone(h.threads.get("old-A"));
  const originalDraft = h.draft;
  const originalChoice = structuredClone(h.choice);
  call("Sidebar", "onLibrary", { kind: "all" });
  call("ConversationLibrary", "onOpen", {
    id: "old-A",
    agentId: "A",
    cwd: "/old-A",
    nativeSessionId: "old-A",
  });
  call("ThreadPage", "onGoSettings");
  expect(component("AgentHub").initialIntent).toBe("manage");
  call("AgentHub", "onOpenApi");
  call("SettingsPage", "onReturn");
  call("AgentHub", "onStart", "A", {
    service: {
      id: "new-service",
      model: "new-model",
      revision: "new-revision",
    },
    config: { model: "new-model", reasoning: "different-reasoning" },
  });
  expect(component("ThreadPage").active).toBe(true);
  expect(component("ThreadPage").viewKey).toBe("old-A");
  expect(component("EmptyState").active).toBe(false);
  expect(component("EmptyState").initialSelection).toBeUndefined();
  expect(h.threads.get("old-A")).toEqual(original);
  expect(h.draft).toBe(originalDraft);
  expect(h.choice).toEqual(originalChoice);
  expect(h.open).not.toHaveBeenCalled();
});

it.each(["A", "B"])(
  "opens a new draft for Agent %s when its card explicitly starts a conversation from discovery",
  (agentId) => {
    h.draft = { text: "", attachments: [] };
    const original = structuredClone(h.threads.get("old-A"));
    call("Sidebar", "onLibrary", { kind: "all" });
    call("ConversationLibrary", "onOpen", {
      id: "old-A",
      agentId: "A",
      cwd: "/old-A",
      nativeSessionId: "old-A",
    });
    call("Sidebar", "onExplore");
    expect(component("AgentHub").initialIntent).toBe("use");
    expect(component("AgentHub").preparationContext).toBeUndefined();
    const selection = {
      service: null,
      config: { model: `new-model-${agentId}`, reasoning: "ultra" },
    };
    call("AgentHub", "onStart", agentId, selection, "new-conversation");
    expect(component("EmptyState").active).toBe(true);
    expect(component("EmptyState").initialAgentId).toBe(agentId);
    expect(component("EmptyState").initialSelection).toEqual(selection);
    expect(component("ThreadPage").active).toBe(false);
    expect(h.threads.get("old-A")).toEqual(original);
    expect(h.open).not.toHaveBeenCalled();
  },
);

it("keeps a separate unsent draft behind confirmation when discovery explicitly starts another Agent", () => {
  const originalDraft = h.draft;
  const original = structuredClone(h.threads.get("old-A"));
  call("Sidebar", "onLibrary", { kind: "all" });
  call("ConversationLibrary", "onOpen", {
    id: "old-A",
    agentId: "A",
    cwd: "/old-A",
    nativeSessionId: "old-A",
  });
  call("Sidebar", "onExplore");
  call(
    "AgentHub",
    "onStart",
    "B",
    { service: null, config: { model: "new-model-B" } },
    "new-conversation",
  );
  expect(component("AgentHub").active).toBe(true);
  expect(component("WorkspaceDialog")).toBeDefined();
  expect(h.draft).toBe(originalDraft);
  expect(h.choice.agentId).toBe("A");
  expect(h.threads.get("old-A")).toEqual(original);
});

it.each([
  ["authentication", "account"],
  ["source", "account"],
  ["model", "model"],
  ["program", "program"],
] as const)(
  "passes the established conversation's original source and fixed choices to its %s repair",
  (failure, panel) => {
    const thread = h.threads.get("old-A")!;
    thread.service = {
      id: "original-api",
      model: "original-model",
      fingerprint: "original-service-fingerprint",
    };
    thread.serviceContext = "original-api-context";
    thread.recordedModel = "original-model";
    thread.configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "reported-model",
        options: [],
      },
      {
        id: "reasoning",
        name: "Reasoning",
        type: "select",
        currentValue: "ultra",
        options: [],
      },
    ];
    if (failure === "authentication")
      observeAuthentication(
        "A",
        "/old-A",
        "AUTH_REQUIRED",
        "original-api-context",
      );
    if (failure === "source") thread.sourceError = true;
    if (failure === "model") thread.modelDrift = true;
    const original = structuredClone(thread);
    call("Sidebar", "onLibrary", { kind: "all" });
    call("ConversationLibrary", "onOpen", {
      id: "old-A",
      agentId: "A",
      cwd: "/old-A",
      nativeSessionId: "old-A",
    });
    call("ThreadPage", "onGoSettings");
    const context = component("AgentHub").preparationContext as {
      agentId: string;
      cwd: string;
      conversation: {
        key: string;
        service: ServiceIdentity;
        sourceContext: string;
        recordedModel: string;
        configOptions: unknown[];
      };
      repair: {
        panel: string;
        sourceContext: string;
        needsAuthentication: boolean;
      };
    };
    expect(context.agentId).toBe("A");
    expect(context.cwd).toBe("/old-A");
    expect(context.repair).toEqual({
      panel,
      sourceContext: "original-api-context",
      needsAuthentication: failure === "authentication",
    });
    expect(context.conversation).toEqual({
      key: "old-A",
      service: original.service,
      sourceContext: "original-api-context",
      recordedModel: "original-model",
      configOptions: original.configOptions,
    });
    expect(context.conversation.service).not.toBe(thread.service);
    expect(context.conversation.configOptions).not.toBe(thread.configOptions);
    call("AgentHub", "onOpenApi");
    call("SettingsPage", "onReturn");
    expect(component("AgentHub").preparationContext).toEqual(context);
    call("AgentHub", "onReturn");
    expect(component("ThreadPage").active).toBe(true);
    expect(component("ThreadPage").viewKey).toBe("old-A");
    expect(h.threads.get("old-A")).toEqual(original);
    expect(h.open).not.toHaveBeenCalled();
  },
);
