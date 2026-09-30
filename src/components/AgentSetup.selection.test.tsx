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
  snapshot: {} as unknown,
  thread: {} as unknown,
  prepare: vi.fn(),
  start: vi.fn(),
  setConfig: vi.fn(),
  needsAuth: false,
  refresh: vi.fn(async () => {}),
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
vi.mock("../runtime/agent_preparation", async (original) => {
  const actual =
    await original<typeof import("../runtime/agent_preparation")>();
  const controller = {
    canPrepare: () => true,
    verified: () => false,
    invalidate: vi.fn(),
    prepare: h.prepare,
    start: h.start,
  };
  return {
    ...actual,
    usePreparation: () => ({ state: h.snapshot, controller }),
  };
});
vi.mock("../runtime/sessions", () => ({
  useThread: () => h.thread,
  modelConfigOption: (options: { id: string }[]) =>
    options.find((option) => option.id === "model"),
  threads: { setConfig: h.setConfig, thread: () => h.thread },
}));
vi.mock("../runtime/authentication", () => ({
  useAuthentication: () => new Set(),
  authenticationRequired: () => h.needsAuth,
  useAuthenticationActivity: () => null,
  subscribeAuthenticationChanges: () => () => {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({ cwd, ready: true, enabled: () => true }),
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
import { AgentSetup, type AgentSetupProgress } from "./AgentSetup";
import {
  AgentPreparation,
  preparationProgram,
  type PreparationSnapshot,
} from "../runtime/agent_preparation";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { ModelPicker } from "./ModelPicker";
import { AgentAuthSection } from "./AgentAuthSection";
import { ACCESS_STRINGS } from "../runtime/access_strings";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
const card: AgentCardModel = {
  id: "selection-owner",
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
let progress: AgentSetupProgress;
const changed = vi.fn((next: AgentSetupProgress) => {
  progress = next;
});
type Element = ReactElement<Record<string, unknown>>;
function render(active = true) {
  h.cursor = 0;
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(
    AgentSetup({
      card,
      agents: {
        busy: {},
        errors: {},
        installProgress: {},
        refresh: h.refresh,
      } as unknown as AgentsState,
      cwd: "/own",
      active,
      progress,
      onProgress: changed,
      onClose() {},
      onStart() {},
      onOpenApi() {},
    }),
  );
  for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
function options(model: string) {
  return [
    {
      id: "model",
      type: "select",
      name: "Model",
      currentValue: model,
      options: ["A", "B", "C"].map((value) => ({ value, name: value })),
    },
  ];
}
function returnedModel(model: string) {
  h.thread = {
    key: "owned-preparation",
    identity: "draft",
    configOptions: options(model),
  };
  h.snapshot = { ...(h.snapshot as PreparationSnapshot), config: { model } };
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.prepare.mockReset();
  h.start.mockReset();
  h.setConfig.mockReset();
  h.needsAuth = false;
  h.refresh.mockClear();
  changed.mockClear();
  progress = {
    step: 2,
    choice: "existing",
    selection: { service: null, config: { model: "A" } },
  };
  h.snapshot = {
    phase: "untested",
    input: {
      agentId: card.id,
      agentName: card.name,
      cwd: "/own",
      program: preparationProgram(card),
      service: null,
      config: { model: "A" },
    },
    threadKey: "owned-preparation",
    config: { model: "A" },
    prompt: "",
    reply: "",
    error: null,
  };
  returnedModel("A");
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
  const prerequisites = render().find(
    (node) => node.type === AgentPrerequisites,
  )!;
  (prerequisites.props.onChange as (ready: boolean) => void)(true);
  render();
  h.prepare.mockClear();
  changed.mockClear();
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
  vi.unstubAllGlobals();
});

it("does not copy preparation A into a newly selected B when the container reopens", () => {
  progress = {
    ...progress,
    selection: { service: null, config: { model: "B" } },
  };
  render();
  expect(changed).not.toHaveBeenCalled();
  expect(progress.selection?.config).toEqual({ model: "B" });
  expect(h.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ config: { model: "B" } }),
  );
});
it("cannot apply a late model change to a different caller selection", async () => {
  let finish!: () => void;
  h.setConfig.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const picker = render().find((node) => node.type === ModelPicker)!;
  (picker.props.onPick as ComponentProps<typeof ModelPicker>["onPick"])("B");
  render();
  returnedModel("B");
  progress = {
    ...progress,
    selection: { service: null, config: { model: "C" } },
  };
  render();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  render();
  expect(changed).not.toHaveBeenCalled();
  expect(progress.selection?.config).toEqual({ model: "C" });
  expect(h.prepare).toHaveBeenLastCalledWith(
    expect.objectContaining({ config: { model: "C" } }),
  );
});
it("keeps a valid model change and the tab the user moved to while it completed", async () => {
  let finish!: () => void;
  h.setConfig.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const picker = render().find((node) => node.type === ModelPicker)!;
  (picker.props.onPick as ComponentProps<typeof ModelPicker>["onPick"])("B");
  render();
  progress = { ...progress, step: 0 };
  render();
  returnedModel("B");
  finish();
  await Promise.resolve();
  await Promise.resolve();
  render();
  expect(progress.step).toBe(0);
  expect(progress.selection?.config).toEqual({ model: "B" });
});

it("keeps a failed automatic model read visible across renders and navigation until the retry button is clicked", async () => {
  const port = {
    open: vi.fn().mockRejectedValue(new Error("model-read-fixture-error")),
    thread: () => undefined,
    subscribeThread: () => () => {},
    send: vi.fn(),
    cancel: vi.fn(),
    discardDraft: vi.fn(),
    dequeue: vi.fn(),
    rename: vi.fn(),
  };
  const controller = new AgentPreparation(port, () => "own-model-read");
  h.snapshot = controller.getSnapshot();
  h.thread = null;
  controller.subscribe(() => {
    h.snapshot = controller.getSnapshot();
  });
  h.prepare.mockImplementation((input, fresh) =>
    controller.prepare(input, fresh),
  );
  progress = { step: 2, choice: "existing" };

  render();
  await Promise.resolve();
  expect(controller.getSnapshot().phase).toBe("failed");
  const failure = controller.getSnapshot();
  for (let i = 0; i < 3; i++) {
    render();
    await Promise.resolve();
  }
  expect(port.open).toHaveBeenCalledTimes(1);
  expect(h.prepare).toHaveBeenCalledTimes(1);
  render(false);
  render(true);
  await Promise.resolve();
  expect(port.open).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toBe(failure);

  const retry = render().find(
    (node) => node.type === "button" && node.props.children === "重新读取模型",
  )!;
  expect(retry).toBeDefined();
  expect(retry.props.disabled).toBe(false);
  (retry.props.onClick as () => void)();
  await Promise.resolve();
  render();
  expect(port.open).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot().phase).toBe("failed");
  expect(port.send).not.toHaveBeenCalled();
});

it("describes unavailable API delivery as this entry's configuration limit", async () => {
  progress = { ...progress, step: 1 };
  await Promise.resolve();
  await Promise.resolve();
  const api = render().find(
    (node) => node.props.role === "radio" && node.key === "api",
  )!;
  const small = Children.toArray(api.props.children as ReactNode)
    .filter(isValidElement<{ children?: ReactNode }>)
    .flatMap((node) => Children.toArray(node.props.children))
    .find((node) => isValidElement(node) && node.type === "small") as Element;
  expect(api.props.disabled).toBe(true);
  expect(small.props.children).toBe(
    "此处暂不支持配置新的 API 服务，可沿用已有设置。",
  );
});

it("allows an explicit model read after login while automatic reads and return still require real authentication evidence", async () => {
  h.needsAuth = true;
  render();
  const account = render().find((node) => node.type === AgentAuthSection)!;
  await (account.props.onChanged as () => Promise<void>)();
  expect(h.refresh).toHaveBeenCalledOnce();
  expect(h.prepare).not.toHaveBeenCalled();

  progress = { ...progress, step: 2 };
  const nodes = render();
  const retry = nodes.find(
    (node) => node.type === "button" && node.props.children === "重新读取模型",
  )!;
  const returning = nodes.find(
    (node) =>
      node.type === "button" &&
      node.props.children === ACCESS_STRINGS.useSelection,
  )!;
  expect(retry.props.disabled).toBe(false);
  expect(returning.props.disabled).toBe(true);
  expect(h.prepare).not.toHaveBeenCalled();
  (retry.props.onClick as () => void)();
  expect(h.prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ agentId: card.id, cwd: "/own", service: null }),
    true,
  );
  expect(h.needsAuth).toBe(true);
});

it("refuses a model-read handler when current preparation requirements disable it", () => {
  const prerequisites = render().find(
    (node) => node.type === AgentPrerequisites,
  )!;
  (prerequisites.props.onChange as (ready: boolean) => void)(false);
  const retry = render().find(
    (node) => node.type === "button" && node.props.children === "重新读取模型",
  )!;
  expect(retry.props.disabled).toBe(true);
  (retry.props.onClick as () => void)();
  expect(h.prepare).not.toHaveBeenCalled();
});

it("allows an explicit request test with model options while a previous request still needs login", () => {
  h.needsAuth = true;
  render();
  progress = { ...progress, step: 2 };
  const nodes = render();
  const test = nodes.find(
    (node) =>
      node.type === "button" &&
      node.props.children === ACCESS_STRINGS.testInConversation,
  )!;
  const returning = nodes.find(
    (node) =>
      node.type === "button" &&
      node.props.children === ACCESS_STRINGS.useSelection,
  )!;
  expect(test.props.disabled).toBe(false);
  expect(returning.props.disabled).toBe(true);
  expect(h.start).not.toHaveBeenCalled();
  (test.props.onClick as () => void)();
  expect(h.start).toHaveBeenCalledOnce();
  expect(h.needsAuth).toBe(true);
});

it("confirms the returned reasoning choice without replacing the chosen model", async () => {
  const thread = h.thread as { configOptions: ReturnType<typeof options> };
  thread.configOptions.push({
    id: "reasoning_effort",
    type: "select",
    name: "思考",
    currentValue: "high",
    options: ["high", "ultra"].map((value) => ({ value, name: value })),
  });
  h.setConfig.mockImplementation(async (_key, id, value) => {
    const option = thread.configOptions.find((item) => item.id === id)!;
    option.currentValue = value;
  });
  const reasoning = render().find(
    (node) => node.type === "select" && node.props["aria-label"] === "思考",
  )!;
  expect(reasoning).toBeDefined();
  await (reasoning.props.onChange as (event: unknown) => Promise<void>)({
    target: { value: "ultra" },
  });
  await Promise.resolve();
  expect(h.setConfig).toHaveBeenCalledWith(
    "owned-preparation",
    "reasoning_effort",
    "ultra",
  );
  expect(progress.selection?.config).toEqual({
    model: "A",
    reasoning_effort: "ultra",
  });
});
