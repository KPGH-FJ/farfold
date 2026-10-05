import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  owner: "setup",
  cursor: 0,
  slots: new Map<string, unknown>(),
  effects: new Map<string, { deps?: unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[],
  required: false,
  authJob: null as unknown,
  methods: vi.fn(),
  begin: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const key = `${h.owner}:${h.cursor++}`;
    if (!h.slots.has(key))
      h.slots.set(key, typeof initial === "function" ? initial() : initial);
    return [
      h.slots.get(key),
      (value: unknown) => {
        h.slots.set(
          key,
          typeof value === "function" ? value(h.slots.get(key)) : value,
        );
      },
    ];
  },
  useRef: (initial: unknown) => {
    const key = `${h.owner}:${h.cursor++}`;
    if (!h.slots.has(key)) h.slots.set(key, { current: initial });
    return h.slots.get(key);
  },
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const key = `${h.owner}:${h.cursor++}`,
      old = h.effects.get(key);
    if (
      !old ||
      !deps ||
      deps.some((value, i) => !Object.is(value, old.deps?.[i]))
    ) {
      const next = { deps } as { deps?: unknown[]; cleanup?: () => void };
      h.effects.set(key, next);
      h.pending.push(() => {
        old?.cleanup?.();
        next.cleanup = effect() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "/work"),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../runtime/agents", async (original) => ({
  ...(await original<typeof import("../runtime/agents")>()),
  authMethods: h.methods,
}));
vi.mock("../runtime/auth_actions", () => ({
  beginAuthentication: h.begin,
  beginPreparationAction: vi.fn(),
  recheckAuthentication: vi.fn(),
}));
vi.mock("../runtime/authentication", () => ({
  useAuthentication: () => new Set(),
  authenticationRequired: () => h.required,
  useAuthenticationActivity: () => h.authJob,
  authenticationActivity: () => ({ getSnapshot: () => h.authJob }),
  invalidateAuthentication: vi.fn(),
  subscribeAuthenticationChanges: () => () => {},
}));
vi.mock("../runtime/sessions", () => ({
  useThread: () => null,
  useThreadsSnapshot: () => ({ threads: new Map() }),
  threads: { thread: () => null, getSnapshot: () => ({ threads: new Map() }) },
  modelConfigOption: () => undefined,
}));
vi.mock("../runtime/agent_preparation", async (original) => ({
  ...(await original<typeof import("../runtime/agent_preparation")>()),
  usePreparation: () => ({
    state: {
      phase: "untested",
      input: null,
      threadKey: null,
      config: {},
      prompt: "",
      reply: "",
      error: null,
    },
    controller: {
      canPrepare: () => true,
      verified: () => false,
      invalidate: vi.fn(),
      prepare: h.prepare,
    },
  }),
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({ cwd, ready: true, enabled: () => true }),
}));
vi.mock("../runtime/credentials", () => ({
  getServiceCapabilities: async () => ({
    apiTypes: [],
    validatedApiTypes: [],
    selectionScope: "unsupported",
  }),
  listCredentials: async () => [],
  subscribeCredentialChanges: () => () => {},
}));
vi.mock("../runtime/preparation", () => ({
  getAgentPreparation: async () => ({ actions: [] }),
}));
vi.mock("./ProgramManager", () => ({
  useProgramInventory: () => ({}),
  ProgramManager: () => null,
}));
vi.mock("./ManualAuthSection", () => ({ ManualAuthSection: () => null }));
vi.mock("./AgentAccountLinks", () => ({ AgentAccountLinks: () => null }));
vi.mock("./InlineTerminal", () => ({ InlineTerminal: () => null }));
vi.mock("./AgentPreparationActions", () => ({
  AgentPreparationActions: () => null,
}));
import { AgentSetup, type AgentSetupProgress } from "./AgentSetup";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentConnectionPicker } from "./AgentConnectionPicker";
import { AgentAccountHeading } from "./AgentAccountHeading";
import { AgentSetupNavigation } from "./AgentSetupNavigation";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { ProgramManager } from "./ProgramManager";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import type { AgentsState } from "../runtime/agents";
type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof AgentSetup>;
function elements(tree: ReactNode) {
  const result: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      result.push(child);
      if (child.type === AgentAccountHeading)
        visit(
          AgentAccountHeading(
            child.props as ComponentProps<typeof AgentAccountHeading>,
          ),
        );
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return result;
}
function render() {
  h.owner = "setup";
  h.cursor = 0;
  const setup = elements(AgentSetup(props));
  const account = setup.find((node) => node.type === AgentAuthSection);
  h.owner = "account";
  h.cursor = 0;
  const auth = account
    ? elements(
        AgentAuthSection(
          account.props as unknown as ComponentProps<typeof AgentAuthSection>,
        ),
      )
    : [];
  for (const effect of h.pending.splice(0)) effect();
  return { setup, auth };
}
async function settled() {
  let result = render();
  for (let round = 0; round < 8; round++) {
    await Promise.resolve();
    result = render();
  }
  return result;
}
const button = (nodes: Element[], label: string) =>
  nodes.find((node) => node.type === "button" && node.props.children === label);
const click = async (node: Element | undefined) => {
  expect(node).toBeDefined();
  await (node!.props.onClick as () => void | Promise<void>)();
};
beforeEach(() => {
  h.slots.clear();
  h.effects.clear();
  h.pending = [];
  h.required = false;
  h.authJob = null;
  vi.clearAllMocks();
  h.methods.mockResolvedValue({
    methods: [
      {
        id: "terminal",
        name: "Official terminal",
        kind: "terminal",
        completion: "return_and_verify",
      },
    ],
    canLogout: false,
  });
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
  props = {
    card: {
      id: "shared-flow",
      name: "Example",
      description: "",
      status: "installed",
      version: null,
      authMethods: ["terminal"],
      discoveredPath: null,
      registryVersion: null,
      source: null,
      installable: false,
      registerable: false,
      custom: true,
      handshake: null,
    },
    agents: {
      busy: {},
      errors: {},
      installProgress: {},
      connect: vi.fn(async () => {
        props.card = { ...props.card, status: "connected" };
      }),
    } as unknown as AgentsState,
    cwd: "/work",
    intent: "manage",
    progress: {
      step: 0,
      choice: "login",
      accessStage: "account",
      authMethodId: "terminal",
      selection: { service: null, config: { model: "keep-model" } },
    },
    onProgress: vi.fn((progress: AgentSetupProgress) => {
      props.progress = progress;
    }),
    onClose: vi.fn(),
    onStart: vi.fn(),
    onOpenApi: vi.fn(),
  };
});
afterEach(() => {
  for (const effect of h.effects.values()) effect.cleanup?.();
  vi.unstubAllGlobals();
});

it.each(
  (["use", "manage"] as const).flatMap((intent) =>
    [0, 1].map((savedStep) => ({ intent, savedStep })),
  ),
)(
  "keeps $intent connection separate from method selection and terminal launch with saved step $savedStep",
  async ({ intent, savedStep }) => {
    props.intent = intent;
    props.progress = { ...props.progress, step: savedStep };
    let view = await settled();
    (
      view.setup.find((node) => node.type === AgentPrerequisites)!.props
        .onChange as (ready: boolean) => void
    )(true);
    view = await settled();
    await (
      view.setup.find((node) => node.type === ProgramManager)!.props
        .onConnect as () => Promise<void>
    )();
    view = await settled();
    expect(props.progress.step).toBe(0);
    const next = button(view.setup, P.nextAccount);
    expect(next?.props.disabled).toBe(false);
    expect(h.begin).not.toHaveBeenCalled();
    await click(next);
    view = await settled();
    expect(
      view.auth.find((node) => node.type === AgentConnectionPicker)?.props
        .options,
    ).toHaveLength(1);
    expect(button(view.setup, R.terminalStart)).toBeUndefined();
    expect(h.begin).not.toHaveBeenCalled();
    await click(button(view.setup, R.continue));
    view = await settled();
    expect(view.auth.some((node) => node.type === AgentConnectionPicker)).toBe(
      false,
    );
    expect(h.begin).not.toHaveBeenCalled();
    await click(button(view.setup, R.terminalStart));
    expect(h.begin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: expect.objectContaining({ id: "terminal", kind: "terminal" }),
      }),
    );
    expect(props.progress.selection?.config).toEqual({ model: "keep-model" });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
  },
);

it("does not let a newly reported authentication requirement bypass the program next action", async () => {
  h.required = true;
  props.card = { ...props.card, status: "connected" };
  let view = await settled();
  (
    view.setup.find((node) => node.type === AgentPrerequisites)!.props
      .onChange as (ready: boolean) => void
  )(true);
  view = await settled();
  expect(props.progress.step).toBe(0);
  await click(button(view.setup, P.nextAccount));
  view = await settled();
  expect(view.auth.some((node) => node.type === AgentConnectionPicker)).toBe(
    true,
  );
  expect(h.begin).not.toHaveBeenCalled();
});

it("enters the method list through the account tab as well as the footer", async () => {
  props.card = { ...props.card, status: "connected" };
  let view = await settled();
  const navigation = view.setup.find(
    (node) => node.type === AgentSetupNavigation,
  )!;
  (navigation.props.onStep as (step: number) => void)(1);
  view = await settled();
  expect(props.progress.accessStage).toBe("method");
  expect(view.auth.some((node) => node.type === AgentConnectionPicker)).toBe(
    true,
  );
  expect(h.begin).not.toHaveBeenCalled();
});

it("preserves an active account operation while blocking program connection and next", async () => {
  props.card = { ...props.card, status: "connected" };
  h.authJob = {
    attemptId: "owned-attempt",
    target: { agentId: props.card.id, cwd: "/work" },
    operation: {
      kind: "authentication",
      methodId: "terminal",
      title: "Owned login",
      completion: "return_and_verify",
    },
    phase: "waiting",
    error: null,
    terminal: null,
    terminalOutcome: null,
    operationConfirmed: false,
    checked: false,
    finishRequested: false,
  };
  const owned = h.authJob;
  let view = await settled();
  (
    view.setup.find((node) => node.type === AgentPrerequisites)!.props
      .onChange as (ready: boolean) => void
  )(true);
  view = await settled();
  const manager = view.setup.find((node) => node.type === ProgramManager)!;
  expect(manager.props.connectDisabled).toBe(true);
  await (manager.props.onConnect as () => Promise<void>)();
  expect(props.agents.connect).not.toHaveBeenCalled();
  const next = button(view.setup, P.nextAccount);
  expect(next?.props.disabled).toBe(true);
  await click(next);
  expect(props.progress.step).toBe(0);
  (
    view.setup.find((node) => node.type === AgentSetupNavigation)!.props
      .onStep as (step: number) => void
  )(1);
  view = await settled();
  expect(props.progress.accessStage).toBe("account");
  expect(view.auth.some((node) => node.props.children === "Owned login")).toBe(
    true,
  );
  expect(view.auth.some((node) => node.type === AgentConnectionPicker)).toBe(
    false,
  );
  expect(h.authJob).toBe(owned);
  expect(h.begin).not.toHaveBeenCalled();
});
