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
  authJob: null as unknown,
  defaultCwd: "/app-conversations",
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
      invalidate: h.invalidate,
      prepare: h.prepare,
    },
  }),
}));
vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: () => null,
}));
vi.mock("../runtime/authentication", () => ({
  useAuthentication: () => new Set(),
  authenticationRequired: () => h.required,
  useAuthenticationActivity: () => h.authJob,
  subscribeAuthenticationChanges: () => () => {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => true }),
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
import { ModelPicker } from "./ModelPicker";
import { ServicePicker } from "./ServicePicker";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { ACCESS_STRINGS as S } from "../runtime/access_strings";
import { AGENT_SETUP_STRINGS as M } from "../runtime/agent_setup_strings";
import { WORKSPACE_STRINGS } from "../runtime/workspace_strings";
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

it("labels the app-owned default location as an ordinary conversation and retains explicit folders", async () => {
  props.cwd = h.defaultCwd;
  render();
  await Promise.resolve();
  let nodes = render();
  expect(
    nodes.some(
      (node) =>
        node.type === "span" &&
        node.props.title === WORKSPACE_STRINGS.normalConversation &&
        node.props.children === WORKSPACE_STRINGS.normalConversation,
    ),
  ).toBe(true);
  expect(nodes.some((node) => node.props.title === h.defaultCwd)).toBe(false);
  props.cwd = "/my-project";
  render();
  await Promise.resolve();
  nodes = render();
  expect(
    nodes.some(
      (node) =>
        node.type === "span" &&
        node.props.title === "/my-project" &&
        node.props.children === "/my-project",
    ),
  ).toBe(true);
});
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.required = false;
  h.authJob = null;
  h.defaultCwd = "/app-conversations";
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
  const finish = nodes.find(
    (node) => node.type === "button" && node.props.children === S.useSelection,
  )!;
  expect(finish.props.disabled).toBe(false);
  await (finish.props.onClick as () => Promise<void>)();
  expect(props.onStart).toHaveBeenCalledExactlyOnceWith(card.id, selection);
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
    accessStage: "account",
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
  expect(result.some((node) => node.type === AgentAuthSection)).toBe(false);
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

it("opens account actions directly and permits returning to the model without a mandatory login", () => {
  props.intent = "use";
  props.conversation = undefined;
  props.card = {
    ...card,
    authMethods: ["official"],
  };
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
  expect(nodes.some((node) => node.type === AgentAuthSection)).toBe(true);
  expect(nodes.filter((node) => node.props.role === "radio")).toHaveLength(2);
  const navigation = nodes.find((node) => node.type === AgentSetupNavigation)!;
  (navigation.props.onStep as (step: number) => void)(2);
  expect(props.progress).toMatchObject({
    step: 2,
    choice: "existing",
    accessStage: "method",
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

it("exposes account management for an existing source without requiring a source change", () => {
  props.conversation = undefined;
  props.progress = {
    step: 1,
    choice: "existing",
    selection: { service: null, config: { model: "chosen" } },
  };
  const nodes = render();
  expect(nodes.filter((node) => node.props.role === "radio")).toHaveLength(2);
  expect(nodes.some((node) => node.type === AgentAuthSection)).toBe(true);
  expect(props.onProgress).not.toHaveBeenCalled();
});

it.each(["login", "api"] as const)(
  "restores old %s preparation directly to its focused content",
  (choice) => {
    props.intent = "use";
    props.conversation = undefined;
    props.progress = { step: 1, choice };
    const nodes = render();
    expect(nodes.filter((node) => node.props.role === "radio")).toHaveLength(2);
    expect(nodes.some((node) => node.type === AgentAuthSection)).toBe(
      choice === "login",
    );
    expect(props.onProgress).not.toHaveBeenCalled();
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
  expect(props.progress.accessStage).toBe("account");
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
  "restores disconnected %s progress through an explicit connection without changing its choices",
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
    const connectButton = render().find(
      (node) => node.type === "button" && node.props.children === S.connect,
    )!;
    expect(connectButton.props.disabled).toBe(false);
    (connectButton.props.onClick as () => void)();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledExactlyOnceWith(props.card, "/old");
    props.card = { ...props.card, status: "connected" };
    render();
    nodes = render();
    expect(props.progress).toEqual({ ...saved, step: 2 });
    expect(
      nodes.some((node) => node.props.children === P.connectionRequired),
    ).toBe(false);
    expect(nodes.some((node) => node.type === AgentAuthSection)).toBe(false);
    if (saved.selection?.service) expect(h.prepare).not.toHaveBeenCalled();
    else
      expect(h.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ config: saved.selection?.config }),
      );
    expect(props.onStart).not.toHaveBeenCalled();
  },
);
