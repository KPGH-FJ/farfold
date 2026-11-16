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
}));
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
const pending: AgentSetupProgress = {
  step: 2,
  choice: "api",
  authMethodId: "chosen-method",
  selection: {
    service: {
      id: "new-draft-api",
      model: "new-model",
      revision: "new-revision",
    },
    config: { model: "new-model", reasoning: "ultra" },
  },
};
const pendingScope = JSON.stringify(["A", "/new-draft", pending.selection]);
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
function renderHub() {
  for (let pass = 0; pass < 8; pass++) {
    h.cursor = 0;
    const result = nodes(Hub(props));
    if (!h.effects.length) return result;
    for (const effect of h.effects.splice(0)) effect();
  }
  throw new Error("Unexpected render loop");
}
function setup() {
  return renderHub().find((node) => node.type === Setup)!;
}
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
  h.slots = [];
  h.effects = [];
  h.invoke.mockReset().mockResolvedValue(null);
  ({ AgentHub: Hub } = await import("./AgentHub"));
  ({ AgentSetup: Setup } = await import("./AgentSetup"));
  ({ setupStorage: storage } = await import("../runtime/setup_storage"));
  await storage.load();
  storage.remember("A", pendingScope, pending);
  await storage.flush();
  h.invoke.mockClear();
  const card: AgentCardModel = {
    id: "A",
    name: "Example",
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
  props = {
    agents: {
      cards: [card],
      busy: {},
      errors: {},
      installProgress: {},
      loading: false,
    } as unknown as AgentsState,
    initialAgentId: "A",
    initialIntent: "manage",
    preparationContext: {
      agentId: "A",
      cwd: "/old-work",
      repair: {
        panel: "account",
        needsAuthentication: true,
        sourceContext: "old-official-source",
      },
      conversation: {
        key: "old",
        sourceContext: "old-official-source",
        service: {
          id: "old-api",
          model: "old-model",
          fingerprint: "old-fingerprint",
        },
        configOptions: [],
      },
    },
    onStart: vi.fn(),
    onReturn: vi.fn(),
    onOpenApi: vi.fn(),
    onOpenConversation: vi.fn(),
  };
});
afterEach(async () => {
  await storage.flush();
  for (const slot of h.slots) slot.cleanup?.();
  vi.unstubAllGlobals();
});

it("repairs an old API conversation without adopting or completing the pending new draft", async () => {
  const original = structuredClone(storage.snapshot());
  const node = setup();
  expect(node.props.intent).toBe("manage");
  expect(node.props.cwd).toBe("/old-work");
  expect(node.props.sourceContext).toBe("old-official-source");
  expect(node.props.conversation).toEqual(
    props.preparationContext?.conversation,
  );
  expect(node.props.onConfirmManagement).toBeUndefined();
  expect(node.props.progress).toMatchObject({ step: 1 });
  expect((node.props.progress as AgentSetupProgress).selection).toBeUndefined();
  (node.props.onProgress as (progress: AgentSetupProgress) => void)({
    ...(node.props.progress as AgentSetupProgress),
    step: 2,
  });
  expect(setup().props.progress).toMatchObject({ step: 2 });
  await (setup().props.onStart as (agent: string) => Promise<void>)("A");
  expect(props.onReturn).toHaveBeenCalledOnce();
  expect(props.onStart).not.toHaveBeenCalled();
  expect(storage.snapshot()).toEqual(original);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "settings_set"),
  ).toHaveLength(0);
  expect(storage.completed("A")).toBe(false);
});

it("returns to the old conversation and later resumes the exact pending wizard", () => {
  (setup().props.onClose as () => void)();
  expect(props.onReturn).toHaveBeenCalledOnce();
  props = { ...props, preparationContext: undefined, requestRevision: 1 };
  const resumed = setup();
  expect(resumed.props.intent).toBe("use");
  expect(resumed.key).toBe(pendingScope);
  expect(resumed.props.cwd).toBe("/new-draft");
  expect(resumed.props.progress).toEqual(pending);
  expect(resumed.props.conversation).toBeUndefined();
  expect(resumed.props.sourceContext).toBeUndefined();
});

it("never writes new-draft progress during a mounted use-to-old-conversation management transition", async () => {
  const repairContext = props.preparationContext;
  props = { ...props, initialIntent: "use", preparationContext: undefined };
  setup();
  await storage.flush();
  const original = structuredClone(storage.snapshot());
  h.invoke.mockClear();
  props = {
    ...props,
    initialIntent: "manage",
    requestRevision: 1,
    preparationContext: repairContext,
  };
  expect(setup().props.conversation).toEqual(repairContext?.conversation);
  await storage.flush();
  expect(storage.snapshot()).toEqual(original);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "settings_set"),
  ).toHaveLength(0);
});

it("does not write a previously selected Agent into the new readonly conversation's folder", async () => {
  const repairContext = props.preparationContext;
  props.agents.cards.push({ ...props.agents.cards[0], id: "B", name: "Other" });
  await storage.complete("B", pending.selection);
  props = {
    ...props,
    initialAgentId: "B",
    initialIntent: "use",
    preparationContext: undefined,
  };
  setup();
  await storage.flush();
  const original = structuredClone(storage.snapshot());
  h.invoke.mockClear();
  props = {
    ...props,
    initialAgentId: "A",
    initialIntent: "manage",
    requestRevision: 1,
    preparationContext: repairContext,
  };
  expect((setup().props.card as AgentCardModel).id).toBe("A");
  await storage.flush();
  expect(storage.snapshot()).toEqual(original);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "settings_set"),
  ).toHaveLength(0);
});

it("locates a normal repair inside saved preparation without resetting its service or model", () => {
  props = {
    ...props,
    preparationContext: {
      agentId: "A",
      cwd: "/other-entry",
      repair: { panel: "account", needsAuthentication: true },
    },
  };
  const node = setup();
  expect(node.props.intent).toBe("use");
  expect(node.props.progress).toEqual({ ...pending, step: 1 });
  expect(node.key).toBe(pendingScope);
  expect(storage.completed("A")).toBe(false);
});

it.each(["A", "B"])(
  "marks the explicit start-new card action for Agent %s independently of the old conversation origin",
  async (agentId) => {
    props.agents.cards.push({
      ...props.agents.cards[0],
      id: "B",
      name: "Other",
    });
    await storage.complete(agentId, pending.selection);
    const card = renderHub().find(
      (node) => node.type === "article" && node.key === agentId,
    )!;
    const start = nodes(card).find(
      (node) =>
        node.type === "button" &&
        String(node.props.className).includes("agent-hub-start"),
    )!;
    (
      start.props.onClick as (event: {
        currentTarget: HTMLButtonElement;
      }) => void
    )({
      currentTarget: { focus: vi.fn() } as unknown as HTMLButtonElement,
    });
    expect(props.onStart).toHaveBeenCalledWith(
      agentId,
      pending.selection,
      "new-conversation",
    );
    expect(props.onReturn).not.toHaveBeenCalled();
    expect(props.preparationContext?.conversation?.key).toBe("old");
  },
);
