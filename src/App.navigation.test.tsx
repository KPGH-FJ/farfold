import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ServiceIdentity } from "./runtime/credentials";
import {
  call,
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";
import { browserSurfaceGuard } from "./runtime/browser_surface";
import { observeAuthentication } from "./runtime/authentication";
import { freshThreadState } from "./runtime/session_projection";
import { threads } from "./runtime/sessions";
import { WORKSPACE_STRINGS as W } from "./runtime/workspace_strings";
import { REDESIGN as R } from "./runtime/redesign_strings";
import { LIBRARY } from "./runtime/library_strings";
import { preparationFor } from "./runtime/agent_preparation";
import { HistoryReplayProjection } from "./runtime/history_replay_projection";
import { applySessionEvent } from "./runtime/session_event_projection";
import {
  allowAutomaticConnection,
  isAutomaticConnectionAllowed,
  pauseAutomaticConnection,
} from "./runtime/connection_intent";

type Element = ReactElement<Record<string, unknown>>;

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
beforeEach(resetHarness);
afterEach(cleanupHarness);

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
        const replay = new HistoryReplayProjection(
          state,
          "navigation-empty-history",
          (owner, event) => applySessionEvent(owner, event, false),
        );
        replay.mark("navigation-empty-history");
        try {
          replay.requireReadable(
            "A",
            {
              cwd: "/canonical",
              nativeSessionId: "history",
              configOptions: [],
              resumed: true,
              warnings: [],
            },
            false,
          );
          throw new Error("fixture must produce a local empty-history failure");
        } catch (error) {
          reject(error);
        } finally {
          replay.clear();
        }
      }
      await promise.catch(() => undefined);
      await Promise.resolve();
    },
  };
}

it("carries the global search focus request only to its admitted destination", async () => {
  const history = pendingHistory("success");
  call("Sidebar", "onSearch", null);
  call("CommandPalette", "onSelect", {
    id: history.raw,
    agentId: "A",
    cwd: "/alias",
    nativeSessionId: "history",
  });
  expect(component("ThreadPage").navigationFocus).toMatchObject({
    key: history.raw,
  });

  await history.complete();
  expect(component("ThreadPage").navigationFocus).toMatchObject({
    key: history.canonical,
  });

  call("ConversationLibrary", "onOpen", {
    id: "test-B",
    agentId: "B",
    cwd: "/test-B",
    nativeSessionId: "test-B",
  });
  expect(component("ThreadPage").navigationFocus).toBeUndefined();
});

it("returns to the original library row only when leaving that conversation", async () => {
  call("Sidebar", "onLibrary", { kind: "attention" });
  const history = pendingHistory("success");
  const opener = { focus: vi.fn() };
  call(
    "ConversationLibrary",
    "onOpen",
    {
      key: history.raw,
      agentId: "A",
      cwd: "/alias",
      nativeSessionId: "history",
    },
    opener,
  );
  await history.complete();
  expect(component("ConversationLibrary").active).toBe(false);
  expect(component("ThreadPage").navigationFocus).toMatchObject({
    key: history.canonical,
  });
  call("ThreadPage", "onBack");
  expect(component("ConversationLibrary")).toMatchObject({
    active: true,
    filter: { kind: "attention" },
    returnFocus: { opener },
  });

  call("Sidebar", "onLibrary", { kind: "all" });
  expect(component("ConversationLibrary").returnFocus).toBeUndefined();
});

it("keeps saved offline Agents in the sidebar and admits history independently of new-conversation readiness", () => {
  h.cards[0].status = "none";
  h.prepared.delete("A");
  expect(component("Sidebar").agents).toEqual([h.cards[1]]);
  expect(component("ConversationLibrary").agents).toEqual(h.cards);
  h.cards[1].status = "installed";
  expect(component("Sidebar").agents).toEqual([h.cards[1]]);
  h.index = [{ agentId: "A" }];
  expect(component("Sidebar").agents).toEqual(h.cards);
  call("Sidebar", "onExplore");
  expect((component("AgentHub").agents as { cards: unknown[] }).cards).toEqual(
    h.cards,
  );
});

it("does not replace a draft with an Agent whose setup is no longer complete", () => {
  const original = structuredClone(h.choice);
  call("Sidebar", "onExplore");
  const start = component("AgentHub").onStart as (id: string) => void;
  h.prepared.delete("B");
  render();
  start("B");
  expect(h.choice).toEqual(original);
  expect(h.clearDraft).not.toHaveBeenCalled();
  expect(component("EmptyState").initialAgentId).not.toBe("B");
});

it("keeps saved Agent navigation visible during an authentication blocker", () => {
  const service = { id: "source", model: "one", revision: "r1" };
  h.selections.set("A", { service, config: { model: "one" } });
  observeAuthentication("A", "/check", "AUTH_REQUIRED");
  expect(component("Sidebar").agents).toEqual(h.cards);
  observeAuthentication("A", "/check", undefined);
  observeAuthentication(
    "A",
    "/check",
    "AUTH_REQUIRED",
    JSON.stringify(service),
  );
  expect(component("Sidebar").agents).toEqual(h.cards);
  expect(component("ConversationLibrary").agents).toEqual(h.cards);
  observeAuthentication("A", "/check", undefined, JSON.stringify(service));
  expect(component("Sidebar").agents).toEqual(h.cards);
});

it("allows an explicit history open after manual disconnect and requests the original conversation identity", async () => {
  pauseAutomaticConnection("A");
  const history = pendingHistory("success");
  history.open();
  expect(isAutomaticConnectionAllowed("A")).toBe(true);
  expect(h.open).toHaveBeenCalledWith({
    inquiryCurrent: expect.any(Function),
    inquirySignal: expect.any(AbortSignal),
    agentId: "A",
    cwd: "/alias",
    nativeSessionId: "history",
  });
  await history.complete();
  expect(component("ThreadPage").viewKey).toBe(history.canonical);
  expect(h.draft.text).toBe("OWN-ORIGINAL-DRAFT");
});

it("removes a retired directory entry from the sidebar while keeping its historical conversation accessible", async () => {
  const retired = Object.assign(h.cards[0], {
    source: "registry",
    firstBatchVisible: false,
  });
  const custom = Object.assign(
    { id: "custom", name: "Custom", status: "connected" },
    { source: "custom", custom: true, firstBatchVisible: false },
  );
  const discovered = Object.assign(
    { id: "local", name: "Local", status: "connected" },
    { source: "discovered", firstBatchVisible: false },
  );
  h.cards.push(custom, discovered);
  h.prepared.add("custom");
  h.prepared.add("local");
  expect(component("Sidebar").agents).toEqual([h.cards[1], custom, discovered]);
  expect(component("ConversationLibrary").agents).toContain(retired);
  const originalDraft = h.draft;
  const originalChoice = structuredClone(h.choice);
  const history = pendingHistory("success");
  history.open();
  await history.complete();
  expect(component("ThreadPage").viewKey).toBe(history.canonical);
  expect(component("ThreadPage").active).toBe(true);
  expect(h.draft).toBe(originalDraft);
  expect(h.choice).toEqual(originalChoice);
  expect(h.cards).toContain(retired);
});

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
      inquiryCurrent: expect.any(Function),
      inquirySignal: expect.any(AbortSignal),
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
    expect(h.reconnect).toHaveBeenCalledExactlyOnceWith(history.raw, {
      inquiryCurrent: expect.any(Function),
      inquirySignal: expect.any(AbortSignal),
    });
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

it("applies a reviewed profile only to the exact draft, folder and service", () => {
  const draft = h.draft;
  const saved = structuredClone(h.choice);
  const current = {
    service: null,
    config: { model: "B", thought_level: "medium" },
  };
  call("EmptyState", "onGoSettings", "A", {
    panel: "model",
    draftConfiguration: true,
  });
  const { applyToDraft, cwd, selection } = component("AgentHub")
    .preparationContext as {
    applyToDraft: (value: unknown) => boolean;
    cwd: string;
    selection: unknown;
  };
  expect(cwd).toBe("/draft-A");
  expect(selection).toEqual({ service: null, config: saved.config });
  expect(
    applyToDraft({
      ...current,
      service: { id: "other", model: "B", revision: "r" },
    }),
  ).toBe(false);
  expect(h.choice).toEqual(saved);
  expect(applyToDraft(current)).toBe(true);
  const next = component("EmptyState");
  expect(next.active).toBe(true);
  expect(next.initialAgentId).toBe("A");
  expect(next.initialSelection).toEqual(current);
  expect(h.draft).toBe(draft);
  expect(h.open).not.toHaveBeenCalled();
  expect(applyToDraft(current)).toBe(false);
});

it.each(["generation", "folder", "new review"])(
  "ignores a draft review that no longer owns the %s",
  (change) => {
    const begin = () =>
      call("EmptyState", "onGoSettings", "A", {
        panel: "model",
        draftConfiguration: true,
      });
    begin();
    const context = component("AgentHub").preparationContext as {
      applyToDraft: (value: unknown) => boolean;
    };
    if (change === "generation") h.draftGeneration += 1;
    if (change === "folder") h.choice.cwd = "/changed";
    if (change === "new review") {
      call("AgentHub", "onReturn");
      begin();
    }
    expect(
      context.applyToDraft({ service: null, config: { model: "B" } }),
    ).toBe(false);
    expect(component("AgentHub").active).toBe(true);
    expect(h.open).not.toHaveBeenCalled();
  },
);

it("does not open a draft repair for content replaced while the browser hides", async () => {
  let acknowledge!: () => void;
  const closed = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const registration = browserSurfaceGuard.register(() => closed);
  try {
    call("EmptyState", "onGoSettings", "A", {
      panel: "model",
      draftConfiguration: true,
    });
    expect(browserSurfaceGuard.getSnapshot().busy).toBe(true);
    h.draftGeneration += 1;
    acknowledge();
    await vi.waitFor(() =>
      expect(browserSurfaceGuard.getSnapshot().busy).toBe(false),
    );
    expect(component("EmptyState").active).toBe(true);
  } finally {
    acknowledge();
    registration.release();
    await closed;
  }
});

it("routes direct Agent preparation back to its draft and restores its chooser focus once", async () => {
  const originalDraft = h.draft;
  const originalChoice = structuredClone(h.choice);
  const focus = vi.fn();
  call("EmptyState", "onGoSettings", "A", undefined, focus);
  expect(component("AgentHub")).toMatchObject({
    initialAgentId: "A",
    initialIntent: "use",
    returnToDraftOnClose: true,
  });
  call("AgentHub", "onReturn");
  expect(component("EmptyState").active).toBe(true);
  expect(h.draft).toBe(originalDraft);
  expect(h.choice).toEqual(originalChoice);
  expect(h.open).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(focus).toHaveBeenCalledOnce();

  call("Sidebar", "onExplore");
  expect(component("AgentHub")).toMatchObject({
    initialAgentId: null,
    returnToDraftOnClose: false,
  });
  call("AgentHub", "onReturn");
  render();
  await Promise.resolve();
  expect(focus).toHaveBeenCalledOnce();
});

it("drops chooser focus if a different destination wins before it is applied", async () => {
  const focus = vi.fn();
  call("EmptyState", "onGoSettings", "A", undefined, focus);
  call("AgentHub", "onReturn");
  expect(component("EmptyState").active).toBe(true);
  call("Sidebar", "onLibrary", { kind: "all" });
  expect(component("ConversationLibrary").active).toBe(true);
  await Promise.resolve();
  expect(focus).not.toHaveBeenCalled();
});

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
  expect(component("AgentHub").returnToDraftOnClose).toBe(false);
  call("AgentHub", "onReturn");
  expect(component("SettingsPage").active).toBe(true);
  expect(component("SettingsPage").tab).toBe("keys");
  call("SettingsPage", "onReturn");
  const restored = component("AgentHub");
  expect(restored.active).toBe(true);
  expect(restored.initialAgentId).toBe("A");
  expect(restored.initialIntent).toBe("use");
  expect(restored.returnToDraftOnClose).toBe(true);
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

it("carries only the requested service into editing and returns to the same preparation and draft", () => {
  const draft = h.draft;
  const choice = h.choice;
  call("EmptyState", "onGoSettings", "A");
  const target = { agentId: "A", id: "second-service", revision: "r2" };
  call("AgentHub", "onOpenApi", target);
  expect(component("SettingsPage")).toMatchObject({
    active: true,
    tab: "keys",
    editService: target,
  });
  call("SettingsPage", "onReturn");
  expect(component("AgentHub")).toMatchObject({
    active: true,
    initialAgentId: "A",
    returnToDraftOnClose: true,
  });
  call("AgentHub", "onOpenApi");
  expect(component("SettingsPage").editService).toBeUndefined();
  call("SettingsPage", "onReturn");
  call("AgentHub", "onReturn");
  expect(component("EmptyState").active).toBe(true);
  expect(h.choice).toBe(choice);
  expect(h.draft).toBe(draft);
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

it.each(["explore", "added"])(
  "preserves the %s list and local management entry across an API settings round trip",
  (origin) => {
    const originalDraft = h.draft;
    const originalChoice = structuredClone(h.choice);
    call("Sidebar", "onSettings");
    call("SettingsPage", "onTabChange", "keys");
    if (origin === "explore") call("Sidebar", "onExplore");
    else call("SettingsPage", "onOpenAgents");
    expect(component("AgentHub").initialAgentId).toBe(null);
    // A directory's outer origin must not make its local settings close the directory.
    expect(component("AgentHub").returnAfterPreparation).toBeFalsy();
    const surface = {
      selected: "A",
      detail: null,
      view: origin === "explore" ? "discover" : "added",
      query: "A",
      source: "all",
      availability: "all",
      intent: "manage",
    };
    const context = component("AgentHub").preparationContext;
    call("AgentHub", "onStateChange", surface);
    call("AgentHub", "onOpenApi");
    expect(component("SettingsPage").active).toBe(true);
    call("SettingsPage", "onReturn");
    expect(component("AgentHub").active).toBe(true);
    expect(component("AgentHub").initialAgentId).toBe(null);
    expect(component("AgentHub").restoredState).toEqual(surface);
    expect(component("AgentHub").preparationContext).toEqual(context);
    expect(component("AgentHub").returnAfterPreparation).toBeFalsy();
    // Only the directory's own back action consumes its outer settings origin.
    call("AgentHub", "onReturn");
    expect(component("SettingsPage").active).toBe(true);
    expect(component("SettingsPage").tab).toBe("keys");
    expect(h.draft).toBe(originalDraft);
    expect(h.choice).toEqual(originalChoice);
    expect(h.open).not.toHaveBeenCalled();
  },
);

it("keeps a direct Agent settings entry distinct from a directory selection across API settings", () => {
  call("Sidebar", "onSettings");
  call("SettingsPage", "onTabChange", "general");
  call("SettingsPage", "onManageAgent", "A");
  const surface = {
    selected: "A",
    detail: null,
    view: "added",
    query: "",
    source: "all",
    availability: "all",
    intent: "manage",
  };
  call("AgentHub", "onStateChange", surface);
  call("AgentHub", "onOpenApi");
  call("SettingsPage", "onReturn");
  expect(component("AgentHub").initialAgentId).toBe("A");
  expect(component("AgentHub").initialIntent).toBe("manage");
  expect(component("AgentHub").restoredState).toEqual(surface);
  call("AgentHub", "onReturn");
  expect(component("SettingsPage").active).toBe(true);
  expect(component("SettingsPage").tab).toBe("general");
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
  h.cards.push({ id: "new-custom", name: "Custom", status: "connected" });
  h.prepared.add("new-custom");
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

it.each(["before-start", "before-confirm"] as const)(
  "preserves the user's draft if a requested Agent leaves the current directory %s",
  (stage) => {
    const originalDraft = h.draft;
    const originalChoice = structuredClone(h.choice);
    call("Sidebar", "onLibrary", { kind: "all" });
    call("ConversationLibrary", "onOpen", {
      id: "old-A",
      agentId: "A",
      cwd: "/old-A",
      nativeSessionId: "old-A",
    });
    call("Sidebar", "onExplore");
    const start = component("AgentHub").onStart as (...args: unknown[]) => void;
    const args = ["B", { service: null, config: {} }, "new-conversation"];
    let confirm: (() => void) | undefined;
    if (stage === "before-confirm") {
      start(...args);
      confirm = render().find(
        (node) =>
          node.type === "button" && node.props.children === R.preserveDraft,
      )!.props.onClick as () => void;
    }
    Object.assign(h.cards[1], { source: "registry", firstBatchVisible: false });
    render();
    if (confirm) confirm();
    else start(...args);
    expect(h.clearDraft).not.toHaveBeenCalled();
    expect(h.draft).toBe(originalDraft);
    expect(h.choice).toEqual(originalChoice);
    expect(component("EmptyState").initialAgentId).not.toBe("B");
    expect(h.open).not.toHaveBeenCalled();
  },
);

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

it.each(["success", "empty"] as const)(
  "keeps the pending browser-close destination when old history settles with %s",
  async (outcome) => {
    const history = pendingHistory(outcome);
    history.open();
    let acknowledge!: () => void;
    const closed = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const close = vi.fn(() => closed);
    const release = browserSurfaceGuard.register(close);
    try {
      call("ConversationLibrary", "onOpen", {
        id: "test-B",
        agentId: "B",
        cwd: "/test-B",
        nativeSessionId: "test-B",
      });
      expect(close).toHaveBeenCalledOnce();
      expect(component("ThreadPage").viewKey).toBe(history.raw);
      expect(component("ThreadPage").active).toBe(true);
      await history.complete();
      expect(component("ThreadPage").viewKey).toBe(history.raw);
      acknowledge();
      await vi.waitFor(() =>
        expect(browserSurfaceGuard.getSnapshot().busy).toBe(false),
      );
      expect(component("ThreadPage").viewKey).toBe("test-B");
      expect(component("ThreadPage").active).toBe(true);
    } finally {
      acknowledge();
      release.release();
      await closed;
    }
  },
);

it("repairs the return identity while settings waits for native close", async () => {
  const history = pendingHistory("success");
  history.open();
  let acknowledge!: () => void;
  const closed = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const release = browserSurfaceGuard.register(() => closed);
  try {
    call("Sidebar", "onSettings");
    await history.complete();
    expect(component("ThreadPage").viewKey).toBe(history.raw);
    acknowledge();
    await vi.waitFor(() =>
      expect(browserSurfaceGuard.getSnapshot().busy).toBe(false),
    );
    expect(component("SettingsPage").active).toBe(true);
    call("SettingsPage", "onReturn");
    expect(component("ThreadPage").viewKey).toBe(history.canonical);
    expect(component("ThreadPage").active).toBe(true);
  } finally {
    acknowledge();
    release.release();
    await closed;
  }
});

it("follows canonical history after a settings round trip has completed", async () => {
  const history = pendingHistory("success");
  history.open();
  call("Sidebar", "onSettings");
  call("SettingsPage", "onReturn");
  expect(component("ThreadPage").viewKey).toBe(history.raw);
  await history.complete();
  expect(component("ThreadPage").viewKey).toBe(history.canonical);
  expect(component("ThreadPage").active).toBe(true);
});

it("keeps a pending layout action and then follows the repaired history key", async () => {
  const history = pendingHistory("success");
  history.open();
  let acknowledge!: () => void;
  const closed = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const release = browserSurfaceGuard.register(() => closed);
  try {
    call("Sidebar", "onCollapse");
    await history.complete();
    expect(component("ThreadPage").viewKey).toBe(history.raw);
    acknowledge();
    await vi.waitFor(() =>
      expect(component("ThreadPage").viewKey).toBe(history.canonical),
    );
    expect(
      render().some(
        (item) =>
          typeof item.type === "function" && item.type.name === "Sidebar",
      ),
    ).toBe(false);
    expect(component("ThreadPage").active).toBe(true);
  } finally {
    acknowledge();
    release.release();
    await closed;
  }
});

it("retains every page-owning task while each exact task can release only itself", () => {
  const pages = () =>
    render()
      .filter(
        (node) =>
          typeof node.type === "function" && node.type.name === "ThreadPage",
      )
      .map((node) => node.props);
  const open = (key: string) =>
    call("ConversationLibrary", "onOpen", {
      id: key,
      agentId: key === "old-A" ? "A" : "B",
      cwd: `/${key}`,
      nativeSessionId: key,
    });
  h.threads.set("test-C", {
    ...h.threads.get("test-B")!,
    key: "test-C",
    cwd: "/test-C",
    nativeSessionId: "test-C",
  });
  open("old-A");
  const notify = component("ThreadPage").onBrowserOwnersChange as (
    key: string,
    owns: boolean,
  ) => void;
  notify("old-A", true);
  call("Sidebar", "onLibrary", { kind: "all" });
  expect(pages()).toMatchObject([{ viewKey: "old-A", active: false }]);
  open("test-B");
  call("ThreadPage", "onBrowserOwnersChange", "test-B", true);
  open("test-C");
  expect(pages()).toMatchObject([
    { viewKey: "old-A", active: false },
    { viewKey: "test-B", active: false },
    { viewKey: "test-C", active: true },
  ]);
  notify("old-A", false);
  expect(pages().map((page) => page.viewKey)).toEqual(["test-B", "test-C"]);
  // A late callback cannot newly retain an already departed inactive task.
  notify("old-A", true);
  expect(pages().map((page) => page.viewKey)).toEqual(["test-B", "test-C"]);
  notify("test-B", false);
  expect(pages().map((page) => page.viewKey)).toEqual(["test-C"]);
  expect(h.open).not.toHaveBeenCalled();
});

it("keeps retained browser route slots in the same order across both task directions", () => {
  const pages = () =>
    render()
      .filter(
        (node) =>
          typeof node.type === "function" && node.type.name === "ThreadPage",
      )
      .map((node) => node.props);
  const open = (key: string) =>
    call("ConversationLibrary", "onOpen", {
      id: key,
      agentId: key === "old-A" ? "A" : "B",
      cwd: `/${key}`,
      nativeSessionId: key,
    });
  open("old-A");
  const notify = component("ThreadPage").onBrowserOwnersChange as (
    key: string,
    owns: boolean,
  ) => void;
  notify("old-A", true);
  open("test-B");
  notify("test-B", true);
  const ownedOrder = pages().map((page) => page.viewKey);
  for (const key of ["old-A", "test-B", "old-A"]) {
    open(key);
    expect(pages().map((page) => page.viewKey)).toEqual(ownedOrder);
    expect(pages().find((page) => page.active)?.viewKey).toBe(key);
  }
  // Removing one owner's last page must preserve the remaining owner's slot;
  // a subsequently opened page is appended without moving that retained owner.
  notify("old-A", false);
  expect(pages()[0].viewKey).toBe("test-B");
  notify("old-A", true);
  open("test-B");
  expect(pages().map((page) => page.viewKey)).toEqual(["test-B", "old-A"]);
});

it("keeps the prepared new draft reachable without starting or indexing it", () => {
  const original = structuredClone(h.draft);
  call("EmptyState", "onPreparedKey", "prepared-A");
  const first = render().find(
    (node) =>
      typeof node.type === "function" && node.type.name === "ThreadPage",
  )!;
  expect(first.key).toBeNull(); // the stable keyed route owns this page
  expect(first.props).toMatchObject({ viewKey: "prepared-A", active: true });
  expect(first.props.draftComposerRef).toBeTypeOf("function");
  call("Sidebar", "onLibrary", { kind: "all" });
  expect(component("ThreadPage")).toMatchObject({
    viewKey: "prepared-A",
    active: false,
  });
  call("Sidebar", "onNew");
  expect(component("ThreadPage")).toMatchObject({
    viewKey: "prepared-A",
    active: true,
  });
  expect(h.draft).toEqual(original);
  expect(h.open).not.toHaveBeenCalled();
  expect(h.clearDraft).not.toHaveBeenCalled();
  expect(h.index).toEqual([]);
});

it("keeps the same page key through first-message admission and waits only for native hide", async () => {
  call("EmptyState", "onPreparedKey", "prepared-A");
  call("ThreadPage", "onBrowserOwnersChange", "prepared-A", true);
  const pageRoutes = () =>
    render().filter((node) => node.type === "div" && node.key === "prepared-A");
  const close = vi.fn(async () => {});
  let finishHide!: () => void;
  const hide = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishHide = resolve;
      }),
  );
  const registration = browserSurfaceGuard.register(close, hide);
  try {
    call("EmptyState", "onPreparedKey", null);
    call("EmptyState", "onStarted", "prepared-A");
    expect(pageRoutes()).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalledOnce();
    finishHide();
    await vi.waitFor(() =>
      expect(component("ThreadPage")).toMatchObject({
        viewKey: "prepared-A",
        active: true,
      }),
    );
    expect(pageRoutes()).toHaveLength(1);
    expect(component("ThreadPage").draftComposerRef).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  } finally {
    registration.release();
  }
});

it("ignores an old prepared draft's page callback after a new draft became current", () => {
  call("EmptyState", "onPreparedKey", "draft-A");
  const stale = component("ThreadPage").onBrowserOwnersChange as Function;
  call("EmptyState", "onPreparedKey", "draft-B");
  call("ThreadPage", "onBrowserOwnersChange", "draft-B", true);
  stale("draft-A", true);
  expect(
    render()
      .filter(
        (node) =>
          typeof node.type === "function" && node.type.name === "ThreadPage",
      )
      .map((node) => node.props.viewKey),
  ).toEqual(["draft-B"]);
});

it("notification clicks select live content without connecting, sending or changing disconnect intent", async () => {
  h.index = [
    { id: "old-A", agentId: "A", cwd: "/old-A", nativeSessionId: "old-A" },
  ];
  pauseAutomaticConnection("A");
  await h.notification!("old-A");
  expect(component("ThreadPage")).toMatchObject({
    viewKey: "old-A",
    active: true,
  });
  expect(h.open).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
  expect(isAutomaticConnectionAllowed("A")).toBe(false);
  expect(h.draft.text).toBe("OWN-ORIGINAL-DRAFT");
});

it("cold notification navigation waits for an explicit history-open click", async () => {
  h.index = [
    {
      id: "cold-A",
      agentId: "A",
      cwd: "/cold-A",
      nativeSessionId: "native-cold",
    },
  ];
  pauseAutomaticConnection("A");
  await h.notification!("cold-A");
  const page = component("ThreadPage");
  expect(page.viewKey).toBe("cold-A");
  expect(page.onManualOpen).toBeTypeOf("function");
  expect(h.open).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
  expect(isAutomaticConnectionAllowed("A")).toBe(false);
  h.open.mockResolvedValueOnce({ key: "cold-A" });
  (page.onManualOpen as () => void)();
  expect(h.open).toHaveBeenCalledExactlyOnceWith({
    inquiryCurrent: expect.any(Function),
    inquirySignal: expect.any(AbortSignal),
    agentId: "A",
    cwd: "/cold-A",
    nativeSessionId: "native-cold",
  });
  expect(h.draft.text).toBe("OWN-ORIGINAL-DRAFT");
});

it("a notification for a removed conversation cannot recreate it", async () => {
  await h.notification!("deleted-key");
  expect(h.open).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
  expect(render().some((node) => node.props.viewKey === "deleted-key")).toBe(
    false,
  );
});
