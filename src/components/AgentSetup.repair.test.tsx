import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
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
  thread: null as unknown,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) =>
    command === "app_default_working_directory" ? h.defaultCwd : null,
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
import {
  AgentSetup,
  initialAgentSetupProgress,
  type AgentSetupProgress,
} from "./AgentSetup";
import { AgentSetupNavigation } from "./AgentSetupNavigation";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { AgentInstallOptions } from "./AgentInstallOptions";
import { ProgramManager } from "./ProgramManager";
import { ModelPicker } from "./ModelPicker";
import { ServicePicker } from "./ServicePicker";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { ACCESS_STRINGS as S } from "../runtime/access_strings";
import { AGENT_SETUP_STRINGS as M } from "../runtime/agent_setup_strings";
import { WORKSPACE_STRINGS } from "../runtime/workspace_strings";
import { preparationProgram } from "../runtime/agent_preparation";
import { freshThreadState } from "../runtime/session_projection";
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

it("shows every protected choice in an existing conversation without editable controls or source changes", () => {
  props.progress = { ...props.progress, step: 2 };
  props.conversation!.configOptions.push(
    {
      id: "inference_speed",
      category: "model",
      name: "Speed",
      type: "select",
      currentValue: "standard",
      options: [],
    },
    {
      id: "reasoning_effort",
      category: "thought_level",
      name: "Reasoning",
      type: "select",
      currentValue: "medium",
      options: [],
    },
    {
      id: "thinking_budget",
      category: "thought_level",
      name: "Thinking",
      type: "select",
      currentValue: "0",
      options: [],
    },
  );
  const before = structuredClone(props.conversation);
  const nodes = render();
  for (const name of ["Model", "Speed", "Reasoning", "Thinking"])
    expect(
      nodes.some((node) => node.type === "dt" && node.props.children === name),
    ).toBe(true);
  expect(props.conversation).toEqual(before);
  expect(props.onStart).not.toHaveBeenCalled();
  expect(props.onProgress).not.toHaveBeenCalled();
});

it("labels the app-owned default location as an ordinary conversation and retains explicit folders", async () => {
  props.cwd = h.defaultCwd;
  render();
  await Promise.resolve();
  let nodes = render();
  expect(
    nodes.some(
      (node) =>
        node.type === "span" &&
        node.props.title === WORKSPACE_STRINGS.normalConversation,
    ),
  ).toBe(true);
  expect(nodes.some((node) => node.props.title === h.defaultCwd)).toBe(false);
  props.cwd = "/my-project";
  render();
  await Promise.resolve();
  nodes = render();
  expect(
    nodes.some(
      (node) => node.type === "span" && node.props.title === "/my-project",
    ),
  ).toBe(true);
});
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

it("shares reviewed startup input between first install and program updates without changing the draft", async () => {
  props.card = { ...card, status: "none", custom: false, installable: true };
  props.conversation = undefined;
  props.intent = "use";
  props.progress = {
    step: 0,
    choice: "existing",
    selection: {
      service: null,
      config: { model: "draft-model", thought_level: "off" },
    },
  };
  props.agents.connect = vi.fn(async () => {});
  props.agents.install = vi.fn(async () => false);
  const options = {
    declarationId: "fixture-model-v1",
    registryVersion: "1.0.0",
    launch: { kind: "uvx" as const, package: "fixture==1.0.0", args: ["-x"] },
    fields: [
      {
        id: "model",
        label: "模型",
        argument: "--model",
        valueKind: "model" as const,
        required: false,
        sourceUrl: "https://example.com/model",
      },
    ],
  };
  let nodes = render();
  const prerequisites = nodes.find((node) => node.type === AgentPrerequisites)!;
  (prerequisites.props.onInfoChange as (info: unknown) => void)({
    dependencies: [],
    links: [],
    installationOptions: options,
  });
  (prerequisites.props.onInstallReadyChange as (ready: boolean) => void)(true);
  nodes = render();
  const fields = nodes.find((node) => node.type === AgentInstallOptions)!;
  const installationInput = {
    declarationId: options.declarationId,
    registryVersion: options.registryVersion,
    launch: options.launch,
    values: { model: "$system.chosen" },
  };
  (fields.props.onChange as (input: unknown) => void)(installationInput);
  nodes = render();
  const start = nodes.find(
    (node) => node.type === "button" && node.props.children === S.install,
  )!;
  expect(start.props.disabled).toBe(false);
  (start.props.onClick as () => void)();
  await Promise.resolve();
  expect(props.agents.connect).toHaveBeenCalledWith(
    props.card,
    "/old",
    installationInput,
  );
  nodes = render();
  const manager = nodes.find((node) => node.type === ProgramManager)!;
  await (manager.props.onInstall as () => Promise<unknown>)();
  expect(props.agents.install).toHaveBeenCalledWith(
    props.card,
    installationInput,
  );
  expect(props.progress.installationInput).toEqual(installationInput);
  expect(props.progress.selection?.config).toEqual({
    model: "draft-model",
    thought_level: "off",
  });
  const latestFields = render().find(
    (node) => node.type === AgentInstallOptions,
  )!;
  (latestFields.props.onValidityChange as (valid: boolean) => void)(false);
  await (manager.props.onInstall as () => Promise<unknown>)();
  expect(props.agents.install).toHaveBeenCalledTimes(1);
});

it("allows the selected registered program to connect when an installation draft is incomplete", async () => {
  props.card = {
    ...card,
    status: "installed",
    custom: false,
    installable: true,
  };
  props.conversation = undefined;
  props.progress = {
    step: 0,
    choice: "existing",
    installationInputInvalid: true,
  };
  props.agents.connect = vi.fn(async () => {});
  let nodes = render();
  const prerequisites = nodes.find((node) => node.type === AgentPrerequisites)!;
  (prerequisites.props.onChange as (ready: boolean) => void)(true);
  nodes = render();
  const connect = programConnect(nodes);
  expect(connect.props.disabled).toBe(false);
  (connect.props.onClick as () => void)();
  await Promise.resolve();
  expect(props.agents.connect).toHaveBeenCalledWith(props.card, "/old");
});

it("reads models for a connected first-use entry and returns its choice without a required test", async () => {
  props.intent = "use";
  props.conversation = undefined;
  const selection = {
    service: null,
    config: { model: "chosen", reasoning: "ultra" },
  };
  props.progress = initialAgentSetupProgress(selection, true);
  let nodes = render();
  expect(
    nodes.find((node) => node.type === AgentSetupNavigation)?.props.step,
  ).toBe(2);
  expect(nodes.some((node) => node.props.role === "radio")).toBe(false);
  const prerequisites = nodes.find((node) => node.type === AgentPrerequisites)!;
  (prerequisites.props.onChange as (ready: boolean) => void)(true);
  nodes = render();
  expect(h.prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentId: card.id,
      cwd: "/old",
      service: null,
      config: selection.config,
    }),
  );
  expect(props.onStart).not.toHaveBeenCalled();
  expect(
    nodes.find(
      (node) =>
        node.type === "button" && node.props.children === S.useSelection,
    )!.props.disabled,
  ).toBe(true);
  confirmModelRead();
  nodes = render();
  const finish = nodes.find(
    (node) => node.type === "button" && node.props.children === S.useSelection,
  )!;
  expect(finish.props.disabled).toBe(false);
  await (finish.props.onClick as () => Promise<void>)();
  expect(props.onStart).toHaveBeenCalledExactlyOnceWith(card.id, selection);
});

it.each([
  [false, true],
  [true, true],
  [false, false],
])(
  "distinguishes a read failure from a later test failure (explicit: %s, read failure: %s)",
  async (explicit, failedRead) => {
    props.conversation = undefined;
    props.intent = "use";
    const selection = { service: null, config: { model: "chosen" } };
    props.progress = initialAgentSetupProgress(selection, true);
    const { preparationProgram } = await import("../runtime/agent_preparation");
    const { freshThreadState } = await import("../runtime/session_projection");
    const thread = freshThreadState("failed-read", card.id, "/old", "failure");
    thread.identity = "draft";
    thread.sourceError = failedRead;
    thread.configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "chosen",
        options: [],
      },
    ];
    if (failedRead)
      thread.configOptions.push({
        id: "mode",
        name: "Thinking",
        type: "select",
        currentValue: "on",
        options: [],
      });
    h.thread = thread;
    h.preparation = {
      phase: "failed",
      input: {
        agentId: card.id,
        agentName: card.name,
        cwd: "/old",
        program: preparationProgram(card),
        service: null,
        config: selection.config,
      },
      threadKey: thread.key,
      config: Object.fromEntries(
        thread.configOptions.map((option) => [option.id, option.currentValue]),
      ),
      prompt: "",
      reply: "",
      error: failedRead ? S.testPrepareFailed : S.testFailed,
      readError: failedRead ? S.testPrepareFailed : null,
      explicitReadTargets: explicit
        ? [JSON.stringify([card.id, "/old", null])]
        : [],
    };
    const nodes = render();
    expect(nodes.some((node) => node.props.children === M.modelFailed)).toBe(
      failedRead,
    );
    expect(nodes.some((node) => node.props.children === M.modelReady)).toBe(
      !failedRead,
    );
    expect(
      nodes.some(
        (node) =>
          node.props.role === "alert" &&
          node.props.children === S.testPrepareFailed,
      ),
    ).toBe(failedRead);
    expect(props.progress?.selection).toEqual(selection);
    expect(h.prepare).not.toHaveBeenCalled();
  },
);

it.each(["/tmp/auth-alias", "/private/tmp/auth-alias"])(
  "retains request-level authentication recorded at %s after resolving the same location",
  (requiredCwd) => {
    props.conversation = undefined;
    props.intent = "use";
    props.cwd = "/tmp/auth-alias";
    h.canonical = "/private/tmp/auth-alias";
    h.requiredCwd = requiredCwd;
    props.progress = initialAgentSetupProgress(
      { service: null, config: { model: "chosen", mode: "off" } },
      true,
    );
    render();
    expect(props.progress).toMatchObject({
      step: 1,
      choice: "login",
      selection: { config: { model: "chosen", mode: "off" } },
    });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
  },
);

it("uses the same canonical configuration target for explicit model reading without changing the displayed folder", () => {
  props.conversation = undefined;
  props.intent = "use";
  props.cwd = "/tmp/project-alias";
  h.canonical = "/private/tmp/project-alias";
  props.progress = initialAgentSetupProgress(
    { service: null, config: { model: "chosen", mode: "off" } },
    true,
  );
  h.preparation = {
    phase: "stale",
    input: null,
    threadKey: null,
    config: {},
    prompt: "",
    reply: "",
    error: null,
    explicitReadTargets: [JSON.stringify([card.id, h.canonical, null])],
  };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  nodes = render();
  expect(h.prepare).not.toHaveBeenCalled();
  const read = nodes.find(
    (node) => node.type === "button" && node.props.children === M.modelRetry,
  )!;
  expect(read.props.disabled).toBe(false);
  (read.props.onClick as () => void)();
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: h.canonical,
      config: { model: "chosen", mode: "off" },
    }),
    true,
  );
  expect(props.cwd).toBe("/tmp/project-alias");
});

it("shows a failed restoration without replacing the caller's choices or hiding it as unread", async () => {
  props.conversation = undefined;
  props.intent = "use";
  const selection = {
    service: null,
    config: { model: "chosen", thought_level: "off", mode: "off" },
  };
  props.progress = initialAgentSetupProgress(selection, true);
  const { preparationProgram } = await import("../runtime/agent_preparation");
  h.preparation = {
    phase: "failed",
    input: {
      agentId: card.id,
      agentName: card.name,
      cwd: "/old",
      program: preparationProgram(card),
      service: null,
      config: selection.config,
    },
    threadKey: "returned-draft",
    config: { model: "chosen", thought_level: "off", mode: "different" },
    prompt: "",
    reply: "",
    error: S.testSelectionNotApplied,
  };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  nodes = render();
  expect(
    nodes.some(
      (node) =>
        node.props.role === "alert" &&
        node.props.children === S.testSelectionNotApplied,
    ),
  ).toBe(true);
  expect(nodes.some((node) => node.props.children === M.modelPending)).toBe(
    false,
  );
  expect(props.progress?.selection).toEqual(selection);
  expect(
    nodes.find(
      (node) =>
        node.type === "button" && node.props.children === S.useSelection,
    )?.props.disabled,
  ).toBe(true);
  const retry = nodes.find(
    (node) => node.type === "button" && node.props.children === M.modelRetry,
  )!;
  expect(retry.props.disabled).toBe(false);
  (retry.props.onClick as () => void)();
  expect(h.prepare).toHaveBeenLastCalledWith(
    expect.objectContaining({ config: selection.config }),
    true,
  );
  expect(props.onStart).not.toHaveBeenCalled();
});

it("locates a connected first-use entry at its explicit login requirement before reading models", () => {
  props.intent = "use";
  props.conversation = undefined;
  props.progress = initialAgentSetupProgress(
    { service: null, config: { model: "chosen" } },
    true,
  );
  h.required = true;
  render();
  expect(props.progress).toMatchObject({
    step: 1,
    choice: "login",
    selection: { config: { model: "chosen" } },
  });
  expect(render().some((node) => node.type === AgentAuthSection)).toBe(true);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("keeps an unfinished login reachable when its program connection is lost", () => {
  props.intent = "use";
  props.conversation = undefined;
  props.card = { ...card, status: "installed" };
  props.progress = { step: 1, choice: "login", accessStage: "account" };
  h.authJob = { phase: "unknown" };
  const nodes = render();
  expect(
    nodes.find((node) => node.type === AgentSetupNavigation)?.props.step,
  ).toBe(1);
  expect(nodes.some((node) => node.type === AgentAuthSection)).toBe(true);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("keeps a completed configuration and failed recheck accessible while disconnected", () => {
  props.conversation = undefined;
  props.card = { ...card, status: "installed" };
  props.progress = { step: 1, choice: "existing", accessStage: "account" };
  h.authJob = { phase: "completed", checked: false, error: "check failed" };
  const nodes = render();
  expect(
    nodes.find((node) => node.type === AgentSetupNavigation)?.props.step,
  ).toBe(1);
  expect(nodes.some((node) => node.type === AgentAuthSection)).toBe(true);
  expect(h.prepare).not.toHaveBeenCalled();
});

it("lets a disconnected completed operation return from the program tab to the same result", () => {
  props.conversation = undefined;
  props.card = { ...card, status: "installed" };
  props.progress = { step: 0, choice: "existing", accessStage: "account" };
  h.authJob = { phase: "completed", checked: false, error: "check failed" };
  const navigation = render().find(
    (node) => node.type === AgentSetupNavigation,
  )!;
  const tabs = Children.toArray(
    AgentSetupNavigation(
      navigation.props as unknown as ComponentProps<
        typeof AgentSetupNavigation
      >,
    ).props.children,
  ) as Element[];
  expect(tabs[0].props.disabled).toBe(false);
  (navigation.props.onStep as (step: number) => void)(1);
  expect(render().some((node) => node.type === AgentAuthSection)).toBe(true);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("retains the prior operation while showing the current API source boundary", () => {
  props.card = { ...card, status: "installed" };
  h.authJob = { phase: "completed", checked: false, error: "check failed" };
  const nodes = render();
  const auth = nodes.find((node) => node.type === AgentAuthSection)!;
  expect(auth).toBeDefined();
  expect(auth.props.source).toBe("old-official-api");
  expect(
    nodes.find((node) => node.type === AgentSetupNavigation)?.props.step,
  ).toBe(1);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("keeps the shared explicit-read requirement across leaving and returning to model selection", () => {
  props.conversation = undefined;
  props.intent = "use";
  const selection = {
    service: null,
    config: { model: "chosen", reasoning: "high" },
  };
  props.progress = initialAgentSetupProgress(selection, true);
  h.preparation = {
    phase: "stale",
    input: null,
    threadKey: null,
    config: {},
    prompt: "",
    reply: "",
    error: null,
    explicitReadTargets: [JSON.stringify([card.id, "/old", null])],
  };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  nodes = render();
  expect(h.prepare).not.toHaveBeenCalled();
  props.active = false;
  render();
  props.active = true;
  nodes = render();
  expect(h.prepare).not.toHaveBeenCalled();
  const read = nodes.find(
    (node) => node.type === "button" && node.props.children === M.modelRetry,
  )!;
  expect(read.props.disabled).toBe(false);
  (read.props.onClick as () => void)();
  expect(h.prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ cwd: "/old", config: selection.config }),
    true,
  );
  expect(props.progress?.selection).toEqual(selection);
  expect(props.onStart).not.toHaveBeenCalled();
});

it("keeps old API authentication on its original source and returns to the selected blocker", () => {
  h.required = true;
  const result = render();
  const auth = result.find((node) => node.type === AgentAuthSection)!;
  expect(auth.props.source).toBe("old-official-api");
  expect(
    result.some(
      (node) => node.type === ServicePicker || node.props.role === "radio",
    ),
  ).toBe(false);
  expect(props.onProgress).not.toHaveBeenCalled();
  (auth.props.onOpenConversation as (key: string) => void)("blocking-thread");
  expect(props.onOpenConversation).toHaveBeenCalledWith("blocking-thread");
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.invalidate).not.toHaveBeenCalled();
});

it("shows the old model as readonly without preparing another conversation or completing setup", async () => {
  props.progress = { step: 2, choice: "existing" };
  let result = render();
  const prerequisites = result.find((node) => node.type === AgentPrerequisites);
  if (prerequisites)
    (prerequisites.props.onChange as (ready: boolean) => void)(true);
  result = render();
  expect(
    result.some(
      (node) => node.type === ModelPicker || node.type === ServicePicker,
    ),
  ).toBe(false);
  expect(
    result.some(
      (node) => node.type === "dd" && node.props.children === "old-model",
    ),
  ).toBe(true);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.invalidate).not.toHaveBeenCalled();
  expect(props.onProgress).not.toHaveBeenCalled();
  const done = result.find(
    (node) =>
      node.type === "button" &&
      node.props.children ===
        (props.conversation ? P.returnConversation : P.save),
  )!;
  await (done.props.onClick as () => Promise<void>)();
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("selects login for an explicit existing-settings requirement while retaining the chosen model", () => {
  props.conversation = undefined;
  props.progress = {
    step: 1,
    choice: "existing",
    selection: {
      service: null,
      config: { model: "chosen", reasoning: "ultra" },
    },
  };
  h.required = true;
  render();
  expect(props.onProgress).toHaveBeenCalledWith({
    ...props.progress,
    choice: "login",
    accessStage: "method",
  });
  expect(props.progress.selection?.config).toEqual({
    model: "chosen",
    reasoning: "ultra",
  });
  expect(render().some((node) => node.type === AgentAuthSection)).toBe(true);
});

it("does not switch a draft API source to login after the Agent requests authentication", () => {
  props.conversation = undefined;
  props.sourceContext = "original-draft-api";
  props.progress = {
    step: 1,
    choice: "api",
    selection: {
      service: { id: "api", model: "chosen", revision: "rev" },
      config: { model: "chosen" },
    },
  };
  h.required = true;
  const result = render();
  expect(props.onProgress).not.toHaveBeenCalled();
  const account = result.find((node) => node.type === AgentAuthSection)!;
  expect(account.props.source).toBe("original-draft-api");
  expect(account.props.connection).toEqual(
    expect.objectContaining({ choice: "api", stage: "api" }),
  );
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.invalidate).not.toHaveBeenCalled();
  expect(props.progress.choice).toBe("api");
  expect(props.progress.selection?.service?.id).toBe("api");
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

it("saves ordinary management only through Done, then closes after the saved confirmation", async () => {
  props.conversation = undefined;
  props.progress = {
    step: 2,
    choice: "existing",
    selection: {
      service: null,
      config: { model: "chosen", reasoning: "ultra" },
    },
  };
  props.onConfirmManagement = vi.fn(async () => true);
  expect(managementDone().props.disabled).toBe(true);
  confirmModelRead();
  const done = managementDone();
  expect(done.props.disabled).toBe(false);
  await (done.props.onClick as () => Promise<void>)();
  expect(props.onConfirmManagement).toHaveBeenCalledWith(
    card.id,
    props.progress.selection,
  );
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("keeps management open after save failure and lets Done retry the same selection", async () => {
  props.conversation = undefined;
  props.progress = {
    step: 2,
    choice: "existing",
    selection: { service: null, config: { model: "chosen" } },
  };
  const save = vi
    .fn()
    .mockRejectedValueOnce(
      new Error("Agent 准备进度尚未保存，请重试后再关闭。"),
    )
    .mockResolvedValue(true);
  props.onConfirmManagement = save;
  confirmModelRead();
  expect(managementDone().props.disabled).toBe(false);
  await (managementDone().props.onClick as () => Promise<void>)();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(render().some((node) => node.props.role === "alert")).toBe(true);
  await (managementDone().props.onClick as () => Promise<void>)();
  expect(save).toHaveBeenCalledTimes(2);
  expect(props.onClose).toHaveBeenCalledOnce();
});

it("does not confirm management through X or through an old conversation's readonly Done", async () => {
  props.onConfirmManagement = vi.fn(async () => true);
  await (managementDone().props.onClick as () => Promise<void>)();
  expect(props.onConfirmManagement).not.toHaveBeenCalled();
  props.conversation = undefined;
  const close = render().find(
    (node) => node.type === "button" && node.props.className === "icon-btn",
  )!;
  (close.props.onClick as () => void)();
  expect(props.onConfirmManagement).not.toHaveBeenCalled();
  expect(props.onClose).toHaveBeenCalledTimes(2);
});

it("does not close a later entry when its management confirmation is no longer current", async () => {
  props.conversation = undefined;
  props.progress = {
    step: 2,
    choice: "existing",
    selection: { service: null, config: { model: "chosen" } },
  };
  props.onConfirmManagement = vi.fn(async () => false);
  await (managementDone().props.onClick as () => Promise<void>)();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("opens shared account choices and explicitly reuses existing settings without a mandatory login", () => {
  props.intent = "use";
  props.conversation = undefined;
  props.card = { ...card, authMethods: ["official"] };
  props.progress = {
    step: 1,
    choice: "existing",
    accessStage: "method",
    selection: {
      service: null,
      config: { model: "chosen", reasoning: "ultra" },
    },
  };
  let nodes = render();
  const account = nodes.find((node) => node.type === AgentAuthSection)!;
  expect(nodes.filter((node) => node.props.role === "radio")).toHaveLength(0);
  expect(account.props.connection).toEqual(
    expect.objectContaining({ choice: "existing", stage: "method" }),
  );
  expect(h.prepare).not.toHaveBeenCalled();
  (account.props.connection as { onUseExisting: () => void }).onUseExisting();
  nodes = render();
  const navigation = nodes.find((node) => node.type === AgentSetupNavigation)!;
  expect(navigation.props.modelsAvailable).toBe(true);
  (navigation.props.onStep as (step: number) => void)(2);
  expect(props.progress).toMatchObject({
    step: 2,
    choice: "existing",
    accessStage: "account",
    selection: { config: { model: "chosen", reasoning: "ultra" } },
  });
  const prerequisites = render().find(
    (node) => node.type === AgentPrerequisites,
  )!;
  (prerequisites.props.onChange as (ready: boolean) => void)(true);
  render();
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      config: { model: "chosen", reasoning: "ultra" },
    }),
  );
  expect(props.onStart).not.toHaveBeenCalled();
});

it("exposes shared account management without changing the existing source", () => {
  props.conversation = undefined;
  props.progress = {
    step: 1,
    choice: "existing",
    selection: { service: null, config: { model: "chosen" } },
  };
  const nodes = render();
  const account = nodes.find((node) => node.type === AgentAuthSection)!;
  expect(nodes.filter((node) => node.props.role === "radio")).toHaveLength(0);
  expect(account.props.connection).toEqual(
    expect.objectContaining({ choice: "existing", stage: "method" }),
  );
  expect(account.props.onMethodChange).toBeTypeOf("function");
  expect(props.onProgress).not.toHaveBeenCalled();
  expect(h.prepare).not.toHaveBeenCalled();
});

it.each(["login", "api"] as const)(
  "restores old %s preparation inside the shared account control",
  (choice) => {
    props.intent = "use";
    props.conversation = undefined;
    props.progress = { step: 1, choice };
    const nodes = render();
    expect(nodes.filter((node) => node.props.role === "radio")).toHaveLength(0);
    const account = nodes.find((node) => node.type === AgentAuthSection)!;
    expect(account.props.connection).toEqual(
      expect.objectContaining({
        choice,
        stage: choice === "api" ? "api" : "method",
      }),
    );
    expect(props.onProgress).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  },
);

it("focuses a newly reported login requirement while preserving access to the other tabs", () => {
  props.intent = "use";
  props.conversation = undefined;
  props.progress = {
    step: 1,
    choice: "login",
    accessStage: "method",
    selection: {
      service: null,
      config: { model: "chosen", reasoning: "ultra" },
    },
  };
  h.required = true;
  render();
  expect(props.progress.accessStage).toBe("method");
  const navigation = render().find(
    (node) => node.type === AgentSetupNavigation,
  )!;
  (navigation.props.onStep as (step: number) => void)(2);
  const nodes = render();
  expect(props.progress.step).toBe(2);
  expect(
    nodes.find((node) => node.type === AgentSetupNavigation)?.props.step,
  ).toBe(2);
  expect(props.progress.selection?.config).toEqual({
    model: "chosen",
    reasoning: "ultra",
  });
  expect(props.onStart).not.toHaveBeenCalled();
});

it.each(["method", "account", "api", undefined] as const)(
  "retains disconnected %s choices while requiring the explicit account next action",
  async (accessStage) => {
    props.intent = "use";
    props.conversation = undefined;
    props.card = { ...card, status: "installed", authMethods: [] };
    const connect = vi.fn(async () => {});
    props.agents = { ...props.agents, connect };
    const saved: AgentSetupProgress = {
      step: 1,
      accessStage,
      choice: accessStage === "api" ? "api" : "login",
      authMethodId: "saved-account-method",
      selection: {
        service:
          accessStage === "api"
            ? { id: "saved-api", model: "chosen", revision: "saved-revision" }
            : null,
        config: { model: "chosen", reasoning: "ultra" },
      },
    };
    props.progress = saved;
    let nodes = render();
    expect(props.progress).toEqual(saved);
    expect(props.onProgress).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(nodes.some((node) => node.type === AgentAuthSection)).toBe(false);
    expect(
      nodes.find((node) => node.type === AgentSetupNavigation)?.props.step,
    ).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    nodes = render();
    const prerequisites = nodes.find(
      (node) => node.type === AgentPrerequisites,
    )!;
    (prerequisites.props.onChange as (ready: boolean) => void)(true);
    const connectButton = programConnect(render());
    expect(connectButton.props.disabled).toBe(false);
    (connectButton.props.onClick as () => void)();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledExactlyOnceWith(props.card, "/old");
    props.card = { ...props.card, status: "connected" };
    render();
    nodes = render();
    expect(props.progress).toEqual({
      ...saved,
      step: 0,
      accessStage: "method",
    });
    const next = nodes.find(
      (node) => node.type === "button" && node.props.children === P.nextAccount,
    )!;
    expect(next.props.disabled).toBe(false);
    await (next.props.onClick as () => Promise<void>)();
    nodes = render();
    expect(props.progress).toEqual({
      ...saved,
      step: 1,
      accessStage: "method",
    });
    expect(
      nodes.some((node) => node.props.children === P.connectionRequired),
    ).toBe(false);
    expect(nodes.some((node) => node.type === AgentAuthSection)).toBe(true);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
  },
);

it("waits for declared installation prerequisites before installing an unregistered entry", async () => {
  props.intent = "use";
  props.conversation = undefined;
  props.progress = { step: 0, choice: "existing" };
  props.card = { ...card, status: "none", custom: false, installable: true };
  const connect = vi.fn(async () => {});
  props.agents = { ...props.agents, connect };
  let nodes = render();
  const prerequisites = nodes.find((node) => node.type === AgentPrerequisites)!;
  const installButton = () =>
    render().find(
      (node) => node.type === "button" && node.props.children === S.install,
    )!;
  expect(installButton().props.disabled).toBe(true);
  (installButton().props.onClick as () => void)();
  await Promise.resolve();
  expect(connect).not.toHaveBeenCalled();
  (prerequisites.props.onChange as (ready: boolean) => void)(true);
  (prerequisites.props.onInfoChange as (info: unknown) => void)({
    dependencies: [],
    links: [],
  });
  (prerequisites.props.onInstallReadyChange as (ready: boolean) => void)(false);
  expect(installButton().props.disabled).toBe(true);
  (prerequisites.props.onInstallReadyChange as (ready: boolean) => void)(true);
  expect(installButton().props.disabled).toBe(false);
  (installButton().props.onClick as () => void)();
  await Promise.resolve();
  expect(connect).toHaveBeenCalledExactlyOnceWith(props.card, "/old");
  expect(props.onStart).not.toHaveBeenCalled();
  expect(h.prepare).not.toHaveBeenCalled();
});

it("does not require installation tools again to connect an installed program", async () => {
  props.intent = "use";
  props.conversation = undefined;
  props.progress = { step: 0, choice: "existing" };
  props.card = {
    ...card,
    status: "installed",
    custom: false,
    installable: true,
  };
  const connect = vi.fn(async () => {});
  props.agents = { ...props.agents, connect };
  const prerequisites = render().find(
    (node) => node.type === AgentPrerequisites,
  )!;
  (prerequisites.props.onChange as (ready: boolean) => void)(true);
  (prerequisites.props.onInstallReadyChange as (ready: boolean) => void)(false);
  const connectButton = programConnect(render());
  expect(connectButton.props.disabled).toBe(false);
  (connectButton.props.onClick as () => void)();
  await Promise.resolve();
  expect(connect).toHaveBeenCalledExactlyOnceWith(props.card, "/old");
});

it.each([undefined, { service: null, config: {} }])(
  "starts a connected new preparation at account review without reading models (%j)",
  (selection) => {
    props.intent = "use";
    props.conversation = undefined;
    props.progress = initialAgentSetupProgress(selection, true);
    let nodes = render();
    (
      nodes.find((node) => node.type === AgentPrerequisites)!.props
        .onChange as (ready: boolean) => void
    )(true);
    nodes = render();
    expect(props.progress.step).toBe(1);
    expect(nodes.some((node) => node.type === AgentAuthSection)).toBe(true);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
  },
);

it.each([
  { authMethods: [] },
  {
    authMethods: ["optional-login"],
  },
])(
  "connects a new program before reviewing optional account methods (%j)",
  async ({ authMethods }) => {
    props.intent = "use";
    props.conversation = undefined;
    props.card = { ...card, status: "installed", authMethods };
    props.progress = initialAgentSetupProgress();
    const connect = vi.fn(async () => {});
    props.agents = { ...props.agents, connect };
    let nodes = render();
    (
      nodes.find((node) => node.type === AgentPrerequisites)!.props
        .onChange as (ready: boolean) => void
    )(true);
    nodes = render();
    const button = programConnect(nodes);
    (button.props.onClick as () => void)();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledExactlyOnceWith(props.card, "/old");
    expect(props.progress.step).toBe(0);
    props.card = { ...props.card, status: "connected" };
    render();
    nodes = render();
    expect(props.progress.step).toBe(0);
    const nextAccount = nodes.find(
      (node) => node.type === "button" && node.props.children === P.nextAccount,
    )!;
    await (nextAccount.props.onClick as () => Promise<void>)();
    nodes = render();
    expect(props.progress.step).toBe(1);
    expect(nodes.some((node) => node.type === AgentAuthSection)).toBe(true);
    expect(h.prepare).not.toHaveBeenCalled();
    const account = nodes.find((node) => node.type === AgentAuthSection)!;
    (account.props.connection as { onUseExisting: () => void }).onUseExisting();
    nodes = render();
    const next = nodes.find(
      (node) =>
        node.type === "button" && node.props.children === "继续选择模型",
    )!;
    expect(next).toBeDefined();
    expect(next.props.disabled).toBe(false);
    await (next.props.onClick as () => Promise<void>)();
    render();
    expect(props.progress.step).toBe(2);
    expect(h.prepare).toHaveBeenCalledOnce();
    expect(props.onStart).not.toHaveBeenCalled();
  },
);

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

it("establishes one preparation connection at the account step when only a conversation connection exists", async () => {
  props.intent = "use";
  props.conversation = undefined;
  props.progress = { step: 1, choice: "existing" };
  const connect = vi.fn(async () => {});
  props.agents = {
    ...props.agents,
    connect,
    statuses: conversationOnly(),
  };
  render();
  await Promise.resolve();
  expect(connect).toHaveBeenCalledExactlyOnceWith(props.card, "/old");
  render();
  await Promise.resolve();
  expect(connect).toHaveBeenCalledTimes(1);
});

it("does not re-establish a connection after an explicit disconnect pauses automation", async () => {
  const { pauseAutomaticConnection } =
    await import("../runtime/connection_intent");
  const restore = pauseAutomaticConnection(card.id);
  try {
    props.intent = "use";
    props.conversation = undefined;
    props.progress = { step: 1, choice: "existing" };
    const connect = vi.fn(async () => {});
    props.agents = {
      ...props.agents,
      connect,
      statuses: conversationOnly(),
    };
    render();
    await Promise.resolve();
    render();
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
  } finally {
    restore();
  }
});

it("verifies saved settings in place and advances to models when the read succeeds", async () => {
  props.intent = "use";
  props.conversation = undefined;
  props.progress = {
    step: 1,
    choice: "existing",
    selection: { service: null, config: { model: "A" } },
  };
  props.agents = {
    ...props.agents,
    statuses: {
      [card.id]: [
        {
          connectionId: "preparation-1",
          purpose: "preparation",
          agentId: card.id,
          cwd: "/old",
          state: "ready",
          agentName: null,
          agentVersion: null,
          authMethods: [],
        },
      ],
    } as AgentsState["statuses"],
  };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  nodes = render();
  const section = nodes.find((node) => node.type === AgentAuthSection)!;
  (
    section.props.connection as {
      onUseExisting: () => void;
      existingVerify?: { status: string };
    }
  ).onUseExisting();
  nodes = render();
  expect(props.progress.accessStage).toBe("account");
  expect(h.prepare).toHaveBeenCalledOnce();
  const verifying = nodes.find((node) => node.type === AgentAuthSection)!;
  expect(
    (
      verifying.props.connection as {
        existingVerify?: { status: string };
      }
    ).existingVerify?.status,
  ).toBe("checking");
  confirmModelRead();
  render();
  expect(props.progress.step).toBe(2);
  expect(props.onStart).not.toHaveBeenCalled();
});

it.each(["required", "active"])(
  "does not advance past an %s account operation through the continue action",
  async (condition) => {
    props.intent = "use";
    props.conversation = undefined;
    props.progress = { step: 1, choice: "existing" };
    h.required = condition === "required";
    h.authJob = condition === "active" ? { phase: "waiting" } : null;
    let nodes = render();
    (
      nodes.find((node) => node.type === AgentPrerequisites)!.props
        .onChange as (ready: boolean) => void
    )(true);
    nodes = render();
    const next = nodes.find(
      (node) =>
        node.type === "button" && node.props.children === "继续选择模型",
    )!;
    expect(next).toBeUndefined();
    render();
    expect(props.progress.step).toBe(1);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
  },
);

it("continues a ready program to account review without saving or sending", async () => {
  props.intent = "use";
  props.conversation = undefined;
  const selection = { service: null, config: { model: "chosen" } };
  props.progress = { step: 0, choice: "existing", selection };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  nodes = render();
  const next = nodes.find(
    (node) =>
      node.type === "button" && node.props.children === "继续设置账号与服务",
  )!;
  expect(next).toBeDefined();
  expect(next.props.disabled).toBe(false);
  await (next.props.onClick as () => Promise<void>)();
  expect(props.progress).toEqual({
    step: 1,
    choice: "existing",
    accessStage: "method",
    selection,
  });
  expect(props.onStart).not.toHaveBeenCalled();
  expect(h.prepare).not.toHaveBeenCalled();
});

it("lets an unselected API source reach its account step before requiring a service", async () => {
  props.intent = "use";
  props.conversation = undefined;
  props.progress = { step: 0, choice: "api" };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  nodes = render();
  const account = nodes.find(
    (node) => node.type === "button" && node.props.children === P.nextAccount,
  )!;
  expect(account.props.disabled).toBe(false);
  await (account.props.onClick as () => Promise<void>)();
  nodes = render();
  expect(props.progress).toEqual({
    step: 1,
    choice: "api",
    accessStage: "method",
  });
  const model = nodes.find(
    (node) => node.type === "button" && node.props.children === P.nextModel,
  )!;
  expect(model).toBeUndefined();
  expect(
    nodes.find((node) => node.type === AgentSetupNavigation)!.props
      .modelsAvailable,
  ).toBe(false);
  expect(props.progress.step).toBe(1);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("resumes a saved model step after reconnect without resetting its source or choices", async () => {
  props.intent = "use";
  props.conversation = undefined;
  props.card = { ...card, status: "installed" };
  const saved: AgentSetupProgress = {
    step: 2,
    choice: "existing",
    selection: {
      service: null,
      config: { model: "chosen", thought_level: "off" },
    },
  };
  props.progress = saved;
  props.agents = { ...props.agents, connect: vi.fn(async () => {}) };
  let nodes = render();
  (
    nodes.find((node) => node.type === AgentPrerequisites)!.props.onChange as (
      ready: boolean,
    ) => void
  )(true);
  const connect = programConnect(render());
  (connect.props.onClick as () => void)();
  await Promise.resolve();
  props.card = { ...props.card, status: "connected" };
  render();
  nodes = render();
  expect(props.progress).toEqual(saved);
  expect(
    nodes.find((node) => node.type === AgentSetupNavigation)?.props.step,
  ).toBe(2);
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ config: saved.selection!.config }),
  );
  expect(props.onStart).not.toHaveBeenCalled();
});

it("keeps an unselected API page through an API settings round trip despite an already focused login requirement", () => {
  props.conversation = undefined;
  h.required = true;
  render();
  props.progress = { step: 1, choice: "api", accessStage: "api" };
  props.active = false;
  render();
  vi.mocked(props.onProgress).mockClear();
  props.active = true;
  render();
  expect(props.progress).toEqual({
    step: 1,
    choice: "api",
    accessStage: "api",
  });
  expect(props.onProgress).not.toHaveBeenCalled();
  h.required = false;
  render();
  h.required = true;
  render();
  expect(props.progress).toMatchObject({
    choice: "login",
    accessStage: "method",
  });
});
