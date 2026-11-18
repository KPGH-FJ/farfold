import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import type { AgentHubProps } from "./AgentHub";
import type { AgentSetupProgress } from "./AgentSetup";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  invoke: vi.fn(),
  hold: vi.fn(),
}));
vi.mock("../runtime/connection_hold", () => ({ useConnectionHold: h.hold }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));

type Element = ReactElement<Record<string, unknown>>;
let Hub: typeof import("./AgentHub").AgentHub;
let Setup: typeof import("./AgentSetup").AgentSetup;
let storage: typeof import("../runtime/setup_storage").setupStorage;
let props: AgentHubProps;
const progress: AgentSetupProgress = {
  step: 2,
  choice: "api",
  authMethodId: "official-login",
  selection: {
    service: { id: "service-A", model: "model-A", revision: "revision-A" },
    config: { model: "model-A", reasoning: "ultra" },
  },
};
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
// Component hooks run only in this test, together with the real setup store and
// actual AgentHub callbacks. No production hook or application data is changed.
function render() {
  let result: Element[] = [];
  for (let pass = 0; pass < 8; pass++) {
    h.cursor = 0;
    result = nodes(Hub(props));
    if (!h.effects.length) return result;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw new Error("Unexpected render loop");
}
function setup() {
  const node = render().find((node) => node.type === Setup);
  expect(node).toBeDefined();
  return node!;
}
function clickEntry(id: string, manage = false) {
  const card = render().find(
    (node) => node.type === "article" && node.key === id,
  )!;
  const button = nodes(card).find(
    (node) =>
      node.type === "button" &&
      (manage
        ? String(node.props.className).includes("agent-hub-detail-button")
        : String(node.props.className).includes("agent-hub-start")),
  )!;
  (
    button.props.onClick as (event: {
      currentTarget: HTMLButtonElement;
    }) => void
  )({
    currentTarget: { focus: vi.fn() } as unknown as HTMLButtonElement,
  });
}
function closeSetup() {
  (setup().props.onClose as () => void)();
}

it("offers a saved offline Agent as standby and starts with the same confirmed choice", async () => {
  await storage.complete("A", progress.selection);
  props.agents.cards[0] = { ...props.agents.cards[0], status: "installed" };
  const card = render().find(
    (node) => node.type === "article" && node.key === "A",
  )!;
  const text = nodes(card)
    .flatMap((node) => Children.toArray(node.props.children as ReactNode))
    .filter((child) => typeof child === "string")
    .join(" ");
  expect(text).toContain("可以使用");
  expect(text).toContain("开始新对话");
  expect(text).not.toContain("继续准备");
  expect(props.onStart).not.toHaveBeenCalled();
  clickEntry("A");
  expect(props.onStart).toHaveBeenCalledWith(
    "A",
    progress.selection,
    "new-conversation",
  );
  expect(storage.completed("A")).toBe(true);
  expect(storage.confirmedSelection("A")).toEqual(progress.selection);
});

it.each(["manual", "failure"])(
  "keeps saved preparation and exposes the actual disconnected state (%s)",
  async (reason) => {
    const { pauseAutomaticConnection, isAutomaticConnectionAllowed } =
      await import("../runtime/connection_intent");
    await storage.complete("A", progress.selection);
    props.agents.cards[0] = {
      ...props.agents.cards[0],
      status: "installed",
      connectionFailed: reason === "failure",
    };
    if (reason === "manual") pauseAutomaticConnection("A");
    const card = render().find(
      (node) => node.type === "article" && node.key === "A",
    )!;
    const text = nodes(card)
      .flatMap((node) => Children.toArray(node.props.children as ReactNode))
      .filter((child) => typeof child === "string")
      .join(" ");
    expect(text).toContain(reason === "manual" ? "可以使用" : "出现问题");
    expect(text).toContain("开始新对话");
    expect(text).not.toContain("待命");
    expect(text).not.toContain("继续准备");
    clickEntry("A");
    expect(isAutomaticConnectionAllowed("A")).toBe(true);
    expect(props.onStart).toHaveBeenCalledWith(
      "A",
      progress.selection,
      "new-conversation",
    );
    expect(storage.confirmedSelection("A")).toEqual(progress.selection);
  },
);

it("holds the selected preparation only while its page is visible without starting a connection", () => {
  render();
  expect(h.hold).toHaveBeenLastCalledWith(null);
  clickEntry("A", true);
  render();
  expect(h.hold).toHaveBeenLastCalledWith({ agentId: "A" });
  props.active = false;
  render();
  expect(h.hold).toHaveBeenLastCalledWith(null);
  expect(h.invoke.mock.calls.some(([name]) => name === "agent_connect")).toBe(
    false,
  );
});

it("keeps a retired registration out of daily lists after refresh without deleting its selection or history entry", async () => {
  const hidden = { ...props.agents.cards[0], firstBatchVisible: false };
  props.agents = {
    ...props.agents,
    cards: [hidden, props.agents.cards[1]],
    remove: vi.fn(),
    install: vi.fn(),
  };
  expect(
    render().some((node) => node.type === "article" && node.key === "A"),
  ).toBe(false);
  props.agents = { ...props.agents, cards: [{ ...hidden }] };
  expect(
    render().some((node) => node.type === "article" && node.key === "A"),
  ).toBe(false);
  const mine = render().find(
    (node) =>
      node.type === "button" &&
      String(node.props.children).includes("我的 Agent"),
  );
  expect(mine).toBeDefined();
  (mine!.props.onClick as () => void)();
  await storage.complete("A", progress.selection);
  expect(
    render().some((node) => node.type === "article" && node.key === "A"),
  ).toBe(false);
  expect(storage.confirmedSelection("A")).toEqual(progress.selection);
  expect(props.agents.cards).toEqual([hidden]);
  expect(props.agents.remove).not.toHaveBeenCalled();
  expect(props.agents.install).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("allows an existing deferred Agent's direct management entry without reclassifying its configuration", async () => {
  const original = props.agents.cards[0];
  props.agents.cards[0] = { ...original, firstBatchVisible: false };
  props.initialAgentId = "A";
  props.initialIntent = "manage";
  props.preparationContext = {
    agentId: "A",
    cwd: "/original-history",
    selection: progress.selection,
    preserveOrigin: true,
  };
  expect(setup().props.card).toBe(props.agents.cards[0]);
  expect(setup().props.cwd).toBe("/original-history");
  expect(setup().props.progress).toMatchObject({
    selection: progress.selection,
  });
  closeSetup();
  expect(props.onReturn).toHaveBeenCalledOnce();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("shows configuration progress and locates the same account tab without changing its choices", async () => {
  const { authenticationActivity } = await import("../runtime/authentication");
  const job = authenticationActivity("A");
  clickEntry("A", true);
  setProgress();
  const scope = setup().key;
  closeSetup();
  job.begin(
    { agentId: "A", cwd: "/original" },
    {
      kind: "preparation",
      actionId: "configure",
      purpose: "service_configuration",
      title: "配置模型服务",
      completion: "exit_code",
    },
    "one-operation",
  );
  const card = render().find(
    (node) => node.type === "article" && node.key === "A",
  )!;
  const text = nodes(card)
    .flatMap((node) =>
      Children.toArray(node.props.children as ReactNode).filter(
        (child) => typeof child === "string",
      ),
    )
    .join(" ");
  expect(text).toContain("配置尚未结束");
  expect(text).toContain("查看配置进度");
  expect(text).not.toContain("查看登录进度");
  clickEntry("A");
  expect(setup().key).toBe(scope);
  expect(setup().props.progress).toEqual({ ...progress, step: 1 });
  expect(job.getSnapshot()?.attemptId).toBe("one-operation");
  expect(
    h.invoke.mock.calls.some(
      ([name]) => name === "agent_preparation_action_run",
    ),
  ).toBe(false);
});

it.each(["same-directory", "no-directory", "other-directory", "api-source"])(
  "respects the shared explicit-read requirement from a completed directory card (%s)",
  async (target) => {
    const { preparationFor } = await import("../runtime/agent_preparation");
    const selection = {
      service: target === "api-source" ? progress.selection!.service : null,
      config: { model: "chosen", mode: "off" },
    };
    await storage.complete("A", selection);
    if (target !== "no-directory")
      props.preparationContext = {
        agentId: "A",
        cwd: target === "other-directory" ? "/other" : "/original",
        selection,
      };
    preparationFor("A").requireExplicitRead({ agentId: "A", cwd: "/original" });
    clickEntry("A");
    if (target === "same-directory" || target === "no-directory") {
      expect(props.onStart).not.toHaveBeenCalled();
      expect(setup().props.progress).toMatchObject({ selection });
    } else
      expect(props.onStart).toHaveBeenCalledWith(
        "A",
        selection,
        "new-conversation",
      );
    expect(storage.confirmedSelection("A")).toEqual(selection);
  },
);

it.each(["discover", "added"] as const)(
  "closes a directory management page back to the same %s list and search",
  (view) => {
    props = {
      ...props,
      initialIntent: "manage",
      initialView: view,
      restoredState: {
        selected: null,
        detail: null,
        intent: "manage",
        view,
        query: "A",
        source: "all",
        availability: "all",
      },
      onStateChange: vi.fn(),
    };
    clickEntry("A", true);
    setProgress();
    closeSetup();
    const list = render();
    expect(list.some((node) => node.type === Setup)).toBe(false);
    expect(props.onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ selected: null, view, query: "A" }),
    );
    expect(
      list.some((node) => node.type === "article" && node.key === "A"),
    ).toBe(true);
    expect(
      list.some((node) => node.type === "article" && node.key === "B"),
    ).toBe(false);
    expect(props.onReturn).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
    clickEntry("A", true);
    expect(setup().props.progress).toEqual(progress);
  },
);

it("returns a completed directory management page to its list without leaving the hub", async () => {
  await storage.complete("A", progress.selection);
  clickEntry("A", true);
  expect(setup().props.intent).toBe("manage");
  await finishSetup();
  expect(render().some((node) => node.type === Setup)).toBe(false);
  expect(props.onReturn).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("closes a directory preparation restored from API settings back to its original list", () => {
  props = { ...props, onStateChange: vi.fn() };
  clickEntry("A", true);
  setProgress();
  const surface = vi.mocked(props.onStateChange!).mock.calls.at(-1)![0];
  (setup().props.onOpenApi as () => void)();
  props = { ...props, active: false };
  render();
  props = {
    ...props,
    active: true,
    requestRevision: 1,
    restoredState: surface,
  };
  expect(setup().props.progress).toEqual(progress);
  closeSetup();
  expect(render().some((node) => node.type === Setup)).toBe(false);
  expect(props.onReturn).not.toHaveBeenCalled();
  expect(props.onOpenApi).toHaveBeenCalledOnce();
});

it("keeps an unfinished Agent's separate conversation preparation in management and returns to that origin", async () => {
  const oldScope = JSON.stringify(["A", "/old-wizard", null]);
  storage.remember("A", oldScope, progress);
  props.initialAgentId = "A";
  props.initialIntent = "manage";
  props.preparationContext = {
    agentId: "A",
    cwd: "/original-draft",
    preserveOrigin: true,
    selection: { service: null, config: { model: "original", mode: "off" } },
  };
  expect(storage.completed("A")).toBe(false);
  expect(setup().props.intent).toBe("manage");
  expect(setup().props.cwd).toBe("/original-draft");
  expect(setup().props.progress).toMatchObject({
    selection: props.preparationContext.selection,
  });
  setProgress({ ...(setup().props.progress as AgentSetupProgress), step: 2 });
  expect(storage.snapshot().pending.A).toBe(oldScope);
  expect(storage.snapshot().progress[oldScope]).toEqual(progress);
  await (
    setup().props.onStart as (id: string, selection: unknown) => Promise<void>
  )("A", props.preparationContext?.selection);
  expect(props.onStart).not.toHaveBeenCalled();
  expect(props.onReturn).toHaveBeenCalledOnce();
});

it("keeps ordinary directory management inside the directory", () => {
  clickEntry("A", true);
  closeSetup();
  expect(props.onReturn).not.toHaveBeenCalled();
});

it("returns only the targeted draft preparation to its origin, even without a work folder", () => {
  props.initialAgentId = "A";
  props.returnToDraftOnClose = true;
  expect(setup().props).toMatchObject({ intent: "use", cwd: undefined });
  closeSetup();
  expect(props.onReturn).toHaveBeenCalledOnce();
  expect(props.onStart).not.toHaveBeenCalled();

  clickEntry("B");
  closeSetup();
  expect(props.onReturn).toHaveBeenCalledOnce();
  expect(render().some((node) => node.type === Setup)).toBe(false);
});
function setProgress(value = progress) {
  (setup().props.onProgress as (value: AgentSetupProgress) => void)(value);
}
async function loadModules() {
  ({ AgentHub: Hub } = await import("./AgentHub"));
  ({ AgentSetup: Setup } = await import("./AgentSetup"));
  ({ setupStorage: storage } = await import("../runtime/setup_storage"));
  await storage.load();
}
function cleanup() {
  for (const slot of h.slots) slot.cleanup?.();
  h.slots = [];
  h.effects = [];
}
function slowWrite() {
  let resolve!: () => void;
  const waiting = new Promise<void>((done) => {
    resolve = done;
  });
  h.invoke.mockImplementation(async (name: string) => {
    if (name === "settings_set") await waiting;
    return null;
  });
  return resolve;
}
function finishSetup() {
  return (
    setup().props.onStart as (id: string, selection: unknown) => Promise<void>
  )("A", progress.selection);
}
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
  h.slots = [];
  h.effects = [];
  h.invoke.mockReset().mockResolvedValue(null);
  h.hold.mockClear();
  const cards: AgentCardModel[] = ["A", "B"].map((id) => ({
    id,
    name: id,
    description: id,
    status: "connected",
    version: "1.0",
    authMethods: [],
    discoveredPath: null,
    registryVersion: null,
    source: null,
    installable: false,
    registerable: false,
    custom: false,
    handshake: null,
  }));
  props = {
    agents: {
      cards,
      busy: {},
      errors: {},
      installProgress: {},
      loading: false,
    } as unknown as AgentsState,
    onStart: vi.fn(),
    onReturn: vi.fn(),
    onOpenApi: vi.fn(),
  };
  await loadModules();
});
afterEach(async () => {
  await storage.flush();
  cleanup();
  vi.unstubAllGlobals();
});

it("uses the same unfinished wizard and choices from first-use and management entries", async () => {
  clickEntry("A", true);
  expect(setup().props.intent).toBe("use");
  setProgress();
  const scope = setup().key;
  await storage.flush();
  closeSetup();
  clickEntry("A");
  expect(setup().key).toBe(scope);
  expect(setup().props.intent).toBe("use");
  expect(setup().props.progress).toEqual(progress);
  closeSetup();
  clickEntry("A", true);
  expect(setup().key).toBe(scope);
  expect(setup().props.progress).toEqual(progress);
  expect(storage.completed("A")).toBe(false);
  expect(props.onStart).not.toHaveBeenCalled();
});

it("saves a delayed completion without navigating away from another Agent opened after leaving", async () => {
  clickEntry("A");
  setProgress();
  await storage.flush();
  const completeWrite = slowWrite();
  const finishing = finishSetup();
  await vi.waitFor(() => expect(storage.snapshot().saving).toBe(true));
  closeSetup();
  clickEntry("B", true);
  expect((setup().props.card as AgentCardModel).id).toBe("B");
  completeWrite();
  await finishing;
  expect(storage.completed("A")).toBe(true);
  expect(props.onStart).not.toHaveBeenCalled();
  expect((setup().props.card as AgentCardModel).id).toBe("B");
});

it("does not navigate after a delayed completion when its page is hidden", async () => {
  clickEntry("A");
  setProgress();
  await storage.flush();
  const completeWrite = slowWrite();
  const finishing = finishSetup();
  await vi.waitFor(() => expect(storage.snapshot().saving).toBe(true));
  props = { ...props, active: false };
  render();
  completeWrite();
  await finishing;
  expect(storage.completed("A")).toBe(true);
  expect(props.onStart).not.toHaveBeenCalled();
});

it("preserves an open preparation when its entry leaves the catalog and does not start from its delayed completion", async () => {
  clickEntry("A");
  setProgress();
  await storage.flush();
  const scope = setup().key;
  const completeWrite = slowWrite();
  const finishing = finishSetup();
  await vi.waitFor(() => expect(storage.snapshot().saving).toBe(true));
  props.agents = {
    ...props.agents,
    cards: props.agents.cards.map((card) =>
      card.id === "A"
        ? { ...card, source: "registry", firstBatchVisible: false }
        : card,
    ),
  };
  expect(setup().key).toBe(scope);
  expect(setup().props.progress).toEqual(progress);
  completeWrite();
  await finishing;
  expect(storage.confirmedSelection("A")).toEqual(progress.selection);
  expect(props.onStart).not.toHaveBeenCalled();
  expect(setup().key).toBe(scope);
  await finishSetup();
  expect(props.onStart).not.toHaveBeenCalled();
  closeSetup();
  expect(
    render().some((node) => node.type === "article" && node.key === "A"),
  ).toBe(false);
});

it("restores the ordinary-folder scope after restart instead of adopting a later draft's folder or source", async () => {
  clickEntry("A");
  setProgress();
  await storage.flush();
  const originalScope = setup().key;
  const saved = structuredClone(
    h.invoke.mock.calls.filter(([name]) => name === "settings_set").at(-1)![1]
      .value,
  );
  cleanup();
  vi.resetModules();
  h.invoke.mockImplementation(async (name: string) =>
    name === "settings_get" ? saved : null,
  );
  await loadModules();
  props = {
    ...props,
    initialAgentId: "A",
    initialIntent: "manage",
    requestRevision: 1,
    preparationContext: {
      agentId: "A",
      cwd: "/later-folder",
      locationLabel: "Later folder",
      selection: { service: null, config: { model: "later-model" } },
    },
  };
  expect(setup().key).toBe(originalScope);
  expect(setup().props.cwd).toBeUndefined();
  expect(setup().props.locationLabel).toBeUndefined();
  expect(setup().props.intent).toBe("use");
  expect(setup().props.progress).toEqual(progress);
  expect(storage.completed("A")).toBe(false);
});

it("keeps distinct completed preparation contexts", async () => {
  props = {
    ...props,
    initialAgentId: "A",
    preparationContext: {
      agentId: "A",
      cwd: "/source-A",
      selection: progress.selection,
    },
  };
  setProgress();
  await storage.flush();
  await finishSetup();
  expect(props.onStart).toHaveBeenCalledWith(
    "A",
    progress.selection,
    "new-conversation",
  );
  props = {
    ...props,
    initialAgentId: "A",
    initialIntent: "manage",
    requestRevision: 1,
    preparationContext: {
      agentId: "A",
      cwd: "/source-B",
      selection: { service: null, config: { model: "B-model" } },
    },
  };
  expect(setup().props.intent).toBe("manage");
  expect(setup().props.cwd).toBe("/source-B");
  expect((setup().props.progress as AgentSetupProgress).selection).toEqual(
    props.preparationContext!.selection,
  );
  props = {
    ...props,
    requestRevision: 2,
    preparationContext: {
      agentId: "A",
      cwd: "/source-A",
      selection: progress.selection,
    },
  };
  expect(setup().props.progress).toEqual(progress);
});

it("does not use completed preparation to clear a subsequent real authentication requirement", async () => {
  await storage.complete("A", progress.selection);
  const { observeAuthentication } = await import("../runtime/authentication");
  observeAuthentication("A", "/ordinary", "AUTH_REQUIRED");
  clickEntry("A");
  expect(storage.completed("A")).toBe(true);
  expect((setup().props.card as AgentCardModel).id).toBe("A");
  expect(props.onStart).not.toHaveBeenCalled();
});

it("does not let an earlier completion consume a later entry for the same Agent", async () => {
  props = {
    ...props,
    initialAgentId: "A",
    requestRevision: 1,
    preparationContext: { agentId: "A", cwd: "/first" },
  };
  setProgress();
  await storage.flush();
  const completeWrite = slowWrite();
  const finishing = finishSetup();
  await vi.waitFor(() => expect(storage.snapshot().saving).toBe(true));
  props = {
    ...props,
    requestRevision: 2,
    initialIntent: "manage",
    preparationContext: { agentId: "A", cwd: "/second" },
  };
  render();
  completeWrite();
  await finishing;
  expect(props.onStart).not.toHaveBeenCalled();
  expect(setup().props.cwd).toBe("/second");
  expect(setup().props.intent).toBe("manage");
});

it("starts from the saved confirmed selection after switching drafts and reopening discovery", async () => {
  props = {
    ...props,
    initialAgentId: "A",
    preparationContext: {
      agentId: "A",
      cwd: "/first",
      selection: progress.selection,
    },
  };
  setProgress();
  await finishSetup();
  const saved = structuredClone(
    h.invoke.mock.calls.filter(([name]) => name === "settings_set").at(-1)![1]
      .value,
  );
  cleanup();
  vi.resetModules();
  h.invoke.mockImplementation(async (name: string) =>
    name === "settings_get" ? saved : null,
  );
  await loadModules();
  props = {
    ...props,
    initialAgentId: null,
    preparationContext: undefined,
    requestRevision: 1,
    onStart: vi.fn(),
  };
  clickEntry("A");
  expect(props.onStart).toHaveBeenCalledWith(
    "A",
    progress.selection,
    "new-conversation",
  );
  expect(storage.scope("A", "independent-scope")).toBe("independent-scope");
});

it("uses the current draft choice before the saved default without altering either confirmation or scope", async () => {
  await storage.complete("A", progress.selection);
  const current = {
    service: {
      id: "current-api",
      revision: "current-revision",
      model: "current-model",
    },
    config: { model: "current-model", reasoning: "high" },
  };
  props = {
    ...props,
    preparationContext: { agentId: "A", cwd: "/current", selection: current },
  };
  clickEntry("A");
  expect(props.onStart).toHaveBeenCalledWith("A", current, "new-conversation");
  expect(storage.confirmedSelection("A")).toEqual(progress.selection);
  expect(storage.scope("A", "another-scope")).toBe("another-scope");
});

it("returns a reviewed model and thinking profile only to the originating draft", async () => {
  const old = {
    service: null,
    config: { model: "old", thought_level: "high" },
  };
  const current = {
    service: null,
    config: { model: "new", thought_level: "medium" },
  };
  await storage.complete("A", old);
  const before = structuredClone(storage.snapshot());
  const applyToDraft = vi.fn(() => true);
  props = {
    ...props,
    initialAgentId: "A",
    preparationContext: {
      agentId: "A",
      cwd: "/current",
      selection: old,
      repair: { panel: "model" },
      applyToDraft,
    },
  };
  expect(setup().props.draftReview).toBe(true);
  expect(setup().props.progress).toMatchObject({ step: 2, selection: old });
  setProgress({ step: 2, choice: "existing", selection: current });
  await (
    setup().props.onStart as (
      agentId: string,
      selection: unknown,
    ) => Promise<void>
  )("A", current);
  expect(applyToDraft).toHaveBeenCalledExactlyOnceWith(current);
  expect(props.onStart).not.toHaveBeenCalled();
  await storage.flush();
  expect(storage.snapshot()).toEqual(before);
});

it("returns a completed Agent with no trustworthy choice to confirmation instead of starting with defaults", async () => {
  await storage.complete("A");
  clickEntry("A");
  expect(props.onStart).not.toHaveBeenCalled();
  expect(setup().props.intent).toBe("use");
  expect(setup().props.progress).toMatchObject({ step: 2 });
});

it("updates new-conversation defaults only when ordinary management explicitly confirms", async () => {
  await storage.complete("A", progress.selection);
  clickEntry("A", true);
  const changed: AgentSetupProgress = {
    step: 2,
    choice: "existing",
    selection: {
      service: null,
      config: { model: "new-default", reasoning: "ultra" },
    },
  };
  setProgress(changed);
  await storage.flush();
  expect(storage.confirmedSelection("A")).toEqual(progress.selection);
  closeSetup();
  clickEntry("A");
  expect(props.onStart).toHaveBeenLastCalledWith(
    "A",
    progress.selection,
    "new-conversation",
  );
  clickEntry("A", true);
  expect(
    await (
      setup().props.onConfirmManagement as (
        id: string,
        selection: unknown,
      ) => Promise<boolean>
    )("A", changed.selection),
  ).toBe(true);
  expect(storage.confirmedSelection("A")).toEqual(changed.selection);
  closeSetup();
  clickEntry("A");
  expect(props.onStart).toHaveBeenLastCalledWith(
    "A",
    changed.selection,
    "new-conversation",
  );
});

it("does not close another management entry when an earlier confirmation saves late", async () => {
  await storage.complete("A", progress.selection);
  await storage.complete("B", progress.selection);
  clickEntry("A", true);
  await storage.flush();
  const release = slowWrite();
  const next = { service: null, config: { model: "changed" } };
  const finishing = (
    setup().props.onConfirmManagement as (
      id: string,
      selection: unknown,
    ) => Promise<boolean>
  )("A", next);
  await vi.waitFor(() => expect(storage.snapshot().saving).toBe(true));
  closeSetup();
  clickEntry("B", true);
  release();
  expect(await finishing).toBe(false);
  expect((setup().props.card as AgentCardModel).id).toBe("B");
  expect(storage.confirmedSelection("A")).toEqual(next);
});

it("fills only a missing scoped selection from the confirmed choice before ordinary management", async () => {
  const scope = JSON.stringify(["A", null, null]);
  storage.remember("A", scope, { step: 1, choice: "existing" });
  await storage.complete("A", progress.selection);
  clickEntry("A", true);
  expect(setup().props.progress).toEqual({
    step: 1,
    choice: "api",
    selection: progress.selection,
  });
  const explicit: AgentSetupProgress = {
    step: 1,
    choice: "existing",
    selection: { service: null, config: {} },
  };
  setProgress(explicit);
  expect(setup().props.progress).toEqual(explicit);
  expect(storage.confirmedSelection("A")).toEqual(progress.selection);
});
