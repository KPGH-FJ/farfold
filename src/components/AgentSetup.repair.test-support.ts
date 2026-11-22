/** Shared synthetic render and isolated mock lifecycle for the repair suites.
 * Import this before production components so the hoisted mocks register first. */
import { afterEach, beforeEach, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { AgentSetup, type AgentSetupProgress } from "./AgentSetup";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { ProgramManager } from "./ProgramManager";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { preparationProgram } from "../runtime/agent_preparation";
import { freshThreadState } from "../runtime/session_projection";
import type { PreparationInfo } from "../runtime/preparation";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  prepare: vi.fn(),
  invalidate: vi.fn(),
  required: false,
  requiredCwd: null as string | null,
  authJob: null as unknown,
  defaultCwd: "/app-conversations",
  canonical: null as string | null,
  preparation: null as unknown,
  preparationInfo: null as PreparationInfo | null,
  thread: null as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "app_default_working_directory") return h.defaultCwd;
    if (command === "agent_preparation") return h.preparationInfo;
    return null;
  },
  Channel: class {
    onmessage = (_: unknown) => {};
  },
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
}));

vi.mock("../runtime/agent_preparation", async (original) => ({
  ...(await original<typeof import("../runtime/agent_preparation")>()),
  usePreparation: () => ({
    state: h.preparation ?? {
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
      invalidate: h.invalidate,
      prepare: h.prepare,
    },
  }),
}));

vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: () => h.thread,
}));

vi.mock("../runtime/authentication", () => ({
  useAuthentication: () => new Set(),
  authenticationRequired: (_state: unknown, _agent: string, cwd: string) =>
    h.required || h.requiredCwd === cwd,
  useAuthenticationActivity: () => h.authJob,
  subscribeAuthenticationChanges: () => () => {},
}));

vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({
    cwd: h.canonical ?? cwd,
    ready: true,
    enabled: () => true,
  }),
}));

vi.mock("../runtime/credentials", () => ({
  subscribeCredentialChanges: () => () => {},
  listCredentials: async () => [],
  getServiceCapabilities: async () => ({ apiTypes: [], validatedApiTypes: [] }),
}));

vi.mock("./ProgramManager", () => ({
  useProgramInventory: () => ({}),
  programSummary: () => "ready",
  ProgramManager: () => null,
}));

vi.mock("./AgentAuthSection", () => ({ AgentAuthSection: () => null }));

const card: AgentCardModel = {
  id: "repair",
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
  custom: true,
  handshake: null,
};

type Element = ReactElement<Record<string, unknown>>;

let props: ComponentProps<typeof AgentSetup>;

function render() {
  h.cursor = 0;
  const result: Element[] = [];
  const visit = (tree: ReactNode) =>
    Children.forEach(tree, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      result.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(AgentSetup(props));
  for (const effect of h.pending.splice(0)) effect();
  return result;
}

function confirmModelRead() {
  const selection = props.progress.selection!;
  const cwd = h.canonical ?? props.cwd ?? h.defaultCwd;
  const thread = freshThreadState(
    "confirmed-setup-read",
    props.card.id,
    cwd,
    "Read options",
  );
  thread.identity = "draft";
  thread.configOptions = Object.entries(selection.config).map(
    ([id, currentValue]) => ({
      id,
      name: id,
      type: "select",
      currentValue,
      options: [],
    }),
  );
  h.thread = thread;
  h.preparation = {
    phase: "untested",
    input: {
      agentId: props.card.id,
      agentName: props.card.name,
      cwd,
      program: preparationProgram(props.card),
      service: selection.service,
      config: selection.config,
    },
    threadKey: thread.key,
    config: selection.config,
    prompt: "",
    reply: "",
    error: null,
    readError: null,
  };
}

function programConnect(nodes: Element[]) {
  const manager = nodes.find((node) => node.type === ProgramManager)!;
  return {
    props: {
      disabled: manager.props.connectDisabled,
      onClick: manager.props.onConnect,
    },
  };
}

beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.required = false;
  h.requiredCwd = null;
  h.authJob = null;
  h.defaultCwd = "/app-conversations";
  h.canonical = null;
  h.preparation = null;
  h.preparationInfo = null;
  h.thread = null;
  h.prepare.mockReset();
  h.invalidate.mockReset();
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
  props = {
    card,
    agents: { busy: {}, errors: {}, installProgress: {} } as AgentsState,
    cwd: "/old",
    intent: "manage",
    conversation: {
      key: "old",
      sourceContext: "old-official-api",
      service: {
        id: "old-api",
        model: "old-model",
        fingerprint: "old-fingerprint",
      },
      recordedModel: "old-model",
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          name: "Model",
          currentValue: "old-model",
          options: [],
        },
      ],
    },
    progress: { step: 1, choice: "existing" },
    onProgress: vi.fn((next: AgentSetupProgress) => {
      props.progress = next;
    }),
    onClose: vi.fn(),
    onStart: vi.fn(),
    onOpenApi: vi.fn(),
    onOpenConversation: vi.fn(),
  };
});

afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
  vi.unstubAllGlobals();
});

function managementDone() {
  const result = render();
  const prerequisites = result.find(
    (node) => node.type === AgentPrerequisites,
  )!;
  (prerequisites.props.onChange as (ready: boolean) => void)(true);
  return render().find(
    (node) =>
      node.type === "button" &&
      node.props.children ===
        (props.conversation ? P.returnConversation : P.save),
  )!;
}

const conversationOnly = () =>
  ({
    [card.id]: [
      {
        connectionId: "conversation-1",
        purpose: "conversation",
        agentId: card.id,
        cwd: "/old",
        state: "ready",
        agentName: null,
        agentVersion: null,
        authMethods: [],
      },
    ],
  }) as AgentsState["statuses"];

export {
  h,
  card,
  props,
  render,
  confirmModelRead,
  programConnect,
  managementDone,
  conversationOnly,
};
export type { Element };
