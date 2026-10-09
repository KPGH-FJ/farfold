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
  confirmRead: vi.fn(),
  needsAuth: false,
  authJob: null as unknown,
  refresh: vi.fn(async () => {}),
  close: vi.fn(),
  getCapabilities: vi.fn(),
  listCredentials: vi.fn(),
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
vi.mock("react-dom", async (original) => ({
  ...(await original<typeof import("react-dom")>()),
  createPortal: (node: ReactNode) => node,
}));
vi.mock("../runtime/agent_preparation", async (original) => {
  const actual =
    await original<typeof import("../runtime/agent_preparation")>();
  const controller = {
    canPrepare: () => true,
    verified: () => false,
    invalidate: vi.fn(),
    prepare: h.prepare,
    confirmRead: h.confirmRead,
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
  useAuthenticationActivity: () => h.authJob,
  subscribeAuthenticationChanges: () => () => {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({ cwd, ready: true, enabled: () => true }),
}));
vi.mock("../runtime/credentials", () => ({
  subscribeCredentialChanges: () => () => {},
  listCredentials: h.listCredentials,
  getServiceCapabilities: h.getCapabilities,
}));
vi.mock("./ProgramManager", () => ({
  useProgramInventory: () => ({}),
  programSummary: () => "ready",
  ProgramManager: () => null,
}));
vi.mock("./AgentAuthSection", () => ({ AgentAuthSection: () => null }));
import { AgentSetupExitReview } from "./AgentSetupExitReview";
import { AgentSetup, type AgentSetupProgress } from "./AgentSetup";
import {
  AgentPreparation,
  preparationProgram,
  type PreparationSnapshot,
} from "../runtime/agent_preparation";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { ModelPicker } from "./ModelPicker";
import { AgentModelReadNotice } from "./AgentModelReadNotice";
import { AgentSelectionReview } from "./AgentSelectionReview";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentServiceSection } from "./AgentServiceSection";
import { ServiceModelPicker } from "./ServiceModelPicker";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { R5_SETUP_STRINGS as R } from "../runtime/r5_setup_strings";
import { ACCESS_STRINGS } from "../runtime/access_strings";
import { STRINGS } from "../runtime/strings";
import { AGENT_SETUP_STRINGS as M } from "../runtime/agent_setup_strings";
import type { Credential, ServiceCapability } from "../runtime/credentials";
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
      const connection = child.props.connection as
        { apiContent?: ReactNode } | undefined;
      if (connection) visit(connection.apiContent);
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
      onClose: h.close,
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
  h.confirmRead.mockReset();
  h.needsAuth = false;
  h.authJob = null;
  h.refresh.mockClear();
  h.close.mockClear();
  h.getCapabilities.mockReset().mockResolvedValue({
    apiTypes: [],
    validatedApiTypes: [],
    selectionScope: "connection",
    unavailableReason: null,
  });
  h.listCredentials.mockReset().mockResolvedValue([]);
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

it("shows the actual boolean read difference before accepting it without replacing saved choices", () => {
  progress.selection = { service: null, config: { model: "A", toggle: "off" } };
  h.snapshot = {
    ...(h.snapshot as PreparationSnapshot),
    input: {
      ...(h.snapshot as PreparationSnapshot).input!,
      readOptionsOnly: true,
      config: { model: "A", toggle: "off" },
    },
    config: { model: "A", toggle: false },
  };
  h.thread = {
    ...(h.thread as object),
    configOptions: [
      ...(h.thread as { configOptions: unknown[] }).configOptions,
      {
        id: "toggle",
        name: "Toggle",
        type: "boolean",
        currentValue: false,
        options: [],
      },
    ],
  };
  const nodes = render();
  const readDifference = nodes.find(
    (node) =>
      node.type === AgentSelectionReview &&
      (node.props.after as { config: Record<string, unknown> }).config
        .toggle === false,
  );
  expect(readDifference).toBeDefined();
  expect(readDifference?.props.before).toEqual(progress.selection);
  expect(readDifference?.props.after).toEqual({
    service: null,
    config: { model: "A", toggle: false },
  });
  expect(progress.selection.config.toggle).toBe("off");
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(h.confirmRead).not.toHaveBeenCalled();
});

it.each(["confirmed", "failed"])(
  "retains mismatched read choices until an explicit model change is %s",
  async (outcome) => {
    returnedModel("B");
    h.snapshot = {
      ...(h.snapshot as PreparationSnapshot),
      input: {
        ...(h.snapshot as PreparationSnapshot).input!,
        readOptionsOnly: true,
      },
    };
    const nodes = render();
    const picker = nodes.find((node) => node.type === ModelPicker)!;
    expect(picker).toBeDefined();
    expect(picker.props.option).toMatchObject({ currentValue: "B" });
    expect(picker.props.disabled).toBeFalsy();
    expect(progress.selection?.config).toEqual({ model: "A" });
    expect(
      nodes.find((node) => node.type === AgentModelReadNotice)?.props.mismatch,
    ).toBe(true);
    const action = (items: Element[], label: string) =>
      items.find(
        (node) => node.type === "button" && node.props.children === label,
      )!;
    expect(action(nodes, ACCESS_STRINGS.useSelection).props.disabled).toBe(
      true,
    );
    expect(
      action(nodes, ACCESS_STRINGS.testInConversation).props.disabled,
    ).toBe(true);
    expect(h.prepare).not.toHaveBeenCalled();
    (action(nodes, M.modelRetry).props.onClick as () => void)();
    expect(h.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: { model: "A" },
        readOptionsOnly: true,
      }),
      true,
    );
    expect(h.setConfig).not.toHaveBeenCalled();
    if (outcome === "failed")
      h.setConfig.mockRejectedValueOnce(new Error("selection failed"));
    else h.setConfig.mockImplementation(async () => returnedModel("C"));
    (picker.props.onPick as ComponentProps<typeof ModelPicker>["onPick"])("C");
    await Promise.resolve();
    await Promise.resolve();
    const next = render();
    expect(h.setConfig).toHaveBeenCalledExactlyOnceWith(
      "owned-preparation",
      "model",
      "C",
    );
    expect(progress.selection?.config).toEqual({
      model: outcome === "confirmed" ? "C" : "A",
    });
    expect(action(next, ACCESS_STRINGS.useSelection).props.disabled).toBe(
      outcome !== "confirmed",
    );
    expect(action(next, ACCESS_STRINGS.testInConversation).props.disabled).toBe(
      outcome !== "confirmed",
    );
  },
);

it.each(["current", "stale", "closed", "step", "method", "blocked"])(
  "only confirms empty returned options for a %s read without applying settings",
  (state) => {
    returnedModel("B");
    h.thread = { ...(h.thread as object), configOptions: [] };
    h.snapshot = {
      ...(h.snapshot as PreparationSnapshot),
      input: {
        ...(h.snapshot as PreparationSnapshot).input!,
        readOptionsOnly: true,
      },
      config: {},
    };
    h.confirmRead.mockReturnValue({});
    const nodes = render();
    const notice = nodes.find((node) => node.type === AgentModelReadNotice)!;
    expect(notice.props.mismatch).toBe(true);
    expect(notice.props.disabled).toBe(false);
    expect(progress.selection?.config).toEqual({ model: "A" });
    if (state === "stale") {
      progress = {
        ...progress,
        selection: { service: null, config: { model: "C" } },
      };
      render();
    } else if (state === "closed") {
      render(false);
    } else if (state === "step") {
      progress = { ...progress, step: 1 };
      render();
    } else if (state === "method") {
      progress = { ...progress, authMethodId: "other-method" };
      render();
    } else if (state === "blocked") {
      h.authJob = { phase: "running" };
      render();
    }
    (notice.props.onConfirm as () => void)();
    expect(progress.selection?.config).toEqual(
      state === "current" ? {} : { model: state === "stale" ? "C" : "A" },
    );
    expect(h.confirmRead).toHaveBeenCalledTimes(state === "current" ? 1 : 0);
    expect(h.setConfig).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
    if (state === "current") {
      const next = render();
      expect(
        next.find((node) => node.type === AgentModelReadNotice)?.props.mismatch,
      ).toBe(false);
      expect(
        next.find(
          (node) =>
            node.type === "button" &&
            node.props.children === ACCESS_STRINGS.useSelection,
        )?.props.disabled,
      ).toBeFalsy();
    }
  },
);

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
it("keeps the caller's choices when model reading finishes while an account action owns preparation", () => {
  progress = { ...progress, step: 1 };
  const account = render().find((node) => node.type === AgentAuthSection)!;
  (account.props.onBusyChange as (busy: boolean) => void)(true);
  h.snapshot = {
    ...(h.snapshot as PreparationSnapshot),
    config: { model: "A", thought_level: "off" },
  };
  render();
  expect(progress.selection?.config).toEqual({ model: "A" });
  expect(changed).not.toHaveBeenCalled();
});
it("shares the model navigation gate and rechecks a stale account callback while retaining the latest confirmed account choice", () => {
  progress = { ...progress, step: 1 };
  const initial = render().find((node) => node.type === AgentAuthSection)!;
  expect(initial.props.canOpenModels).toBe(false);
  (initial.props.connection as { onUseExisting: () => void }).onUseExisting();
  const account = render().find((node) => node.type === AgentAuthSection)!;
  expect(account.props.canOpenModels).toBe(true);
  const open = account.props.onOpenModels as () => void;
  h.needsAuth = true;
  const blocked = render().find((node) => node.type === AgentAuthSection)!;
  expect(blocked.props.canOpenModels).toBe(false);
  open();
  expect(progress.step).toBe(1);
  h.needsAuth = false;
  progress = {
    ...progress,
    accessStage: "account",
    authMethodId: "user-selected-account",
  };
  render();
  open();
  expect(progress.step).toBe(1);
  h.authJob = {
    phase: "completed",
    checked: true,
    target: { agentId: card.id, cwd: "/own" },
    operation: {
      kind: "authentication",
      methodId: "user-selected-account",
      completion: "exit_code",
      intent: "login",
    },
  };
  render();
  open();
  expect(progress).toMatchObject({
    step: 2,
    authMethodId: "user-selected-account",
    selection: { service: null, config: { model: "A" } },
  });
});

it("does not use an account navigation callback after the requested model selection has changed", () => {
  progress = { ...progress, step: 1 };
  const account = render().find((node) => node.type === AgentAuthSection)!;
  const open = account.props.onOpenModels as () => void;
  progress = {
    ...progress,
    selection: { service: null, config: { model: "B" } },
  };
  render();
  open();
  expect(progress.step).toBe(1);
  expect(progress.selection?.config).toEqual({ model: "B" });
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
    retirePreparationDraft: vi.fn(),
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

it("hides confirmed unsupported API while retaining unknown, failed and supported capability entries", async () => {
  progress = { ...progress, step: 1 };
  for (let round = 0; round < 6; round++) await Promise.resolve();
  const apiAvailable = (nodes: Element[]) =>
    (
      nodes.find((node) => node.type === AgentAuthSection)!.props
        .connection as { apiAvailable: boolean }
    ).apiAvailable;
  expect(apiAvailable(render())).toBe(false);
  const change = vi.fn();
  const retry = vi.fn();
  const saved = {
    id: "saved-service",
    model: "saved-model",
    revision: "saved",
  };
  const section = (capability: ServiceCapability | null, error: boolean) =>
    AgentServiceSection({
      agentId: card.id,
      capability,
      error,
      items: [],
      value: saved,
      onChange: change,
      onRetry: retry,
      onOpenApi: vi.fn(),
      disabled: false,
      readonly: true,
    });
  expect(
    section(
      {
        apiTypes: [],
        validatedApiTypes: [],
        selectionScope: "connection",
        unavailableReason: null,
      },
      false,
    ),
  ).toBeNull();
  const loading = section(null, false)!;
  expect(
    Children.toArray(loading.props.children)
      .filter(isValidElement<{ children?: ReactNode }>)
      .some((node) => node.props.children === STRINGS.common.loading),
  ).toBe(true);
  const failedSection = section(null, true)!;
  const retryButton = Children.toArray(failedSection.props.children)
    .filter(isValidElement<{ children?: ReactNode; onClick?: () => void }>)
    .find(
      (node) =>
        node.type === "button" && node.props.children === ACCESS_STRINGS.retry,
    )!;
  expect(retryButton).toBeDefined();
  retryButton.props.onClick!();
  expect(retry).toHaveBeenCalledOnce();
  expect(change).not.toHaveBeenCalled();
  const originalAgent = card.id;
  const originalSelection = progress.selection;
  try {
    h.getCapabilities.mockRejectedValueOnce(
      new Error("temporary lookup failure"),
    );
    card.id = "unknown-api-capability";
    expect(apiAvailable(render())).toBe(false);
    for (let round = 0; round < 6; round++) await Promise.resolve();
    const failed = render();
    expect(apiAvailable(failed)).toBe(false);
    expect(
      failed.some((node) => node.props.children === ACCESS_STRINGS.retry),
    ).toBe(true);
    h.getCapabilities.mockResolvedValue({
      apiTypes: ["responses"],
      validatedApiTypes: [],
      selectionScope: "connection",
      unavailableReason: null,
    });
    card.id = "supported-api-capability";
    render();
    for (let round = 0; round < 6; round++) await Promise.resolve();
    expect(apiAvailable(render())).toBe(true);
    expect(progress.selection).toBe(originalSelection);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    card.id = originalAgent;
  }
});

it("keeps confirmed unsupported API hidden when the service list fails", async () => {
  const originalAgent = card.id;
  const originalSelection = progress.selection;
  try {
    progress = { ...progress, step: 1, choice: "api" };
    h.listCredentials.mockRejectedValueOnce(new Error("list unavailable"));
    card.id = "unsupported-with-list-failure";
    render();
    for (let round = 0; round < 6; round++) await Promise.resolve();
    const nodes = render();
    expect(
      nodes.find((node) => node.props.role === "radio" && node.key === "api"),
    ).toBeUndefined();
    const section = nodes.find((node) => node.type === AgentServiceSection)!;
    expect(section.props.capability).toEqual({
      apiTypes: [],
      validatedApiTypes: [],
      selectionScope: "connection",
      unavailableReason: null,
    });
    expect(section.props.error).toBe(true);
    expect(
      AgentServiceSection(
        section.props as ComponentProps<typeof AgentServiceSection>,
      ),
    ).toBeNull();
    expect(progress.selection).toBe(originalSelection);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    card.id = originalAgent;
  }
});

it("retains the loaded service list and retry when the capability lookup fails", async () => {
  const originalAgent = card.id;
  const originalSelection = progress.selection;
  const records: Credential[] = [
    {
      id: "saved-service",
      label: "Saved service",
      provider: "example",
      endpoint: "https://example.test",
      apiType: "responses",
      models: ["saved-model"],
      revision: "saved",
      complete: true,
      deleting: false,
      grants: [],
    },
  ];
  try {
    progress = { ...progress, step: 1, choice: "api" };
    h.getCapabilities.mockRejectedValueOnce(new Error("lookup unavailable"));
    h.listCredentials.mockResolvedValue(records);
    card.id = "unknown-with-loaded-services";
    render();
    for (let round = 0; round < 6; round++) await Promise.resolve();
    const nodes = render();
    expect(
      (
        nodes.find((node) => node.type === AgentAuthSection)!.props
          .connection as { apiAvailable: boolean }
      ).apiAvailable,
    ).toBe(false);
    const section = nodes.find((node) => node.type === AgentServiceSection)!;
    expect(section.props.capability).toBeNull();
    expect(section.props.items).toEqual(records);
    expect(section.props.error).toBe(true);
    expect(
      AgentServiceSection(
        section.props as ComponentProps<typeof AgentServiceSection>,
      ),
    ).not.toBeNull();
    h.getCapabilities.mockResolvedValue({
      apiTypes: ["responses"],
      validatedApiTypes: [],
      selectionScope: "connection",
      unavailableReason: null,
    });
    (section.props.onRetry as () => void)();
    render();
    for (let round = 0; round < 6; round++) await Promise.resolve();
    const recovered = render().find(
      (node) => node.type === AgentServiceSection,
    )!;
    expect(recovered.props.items).toEqual(records);
    expect(recovered.props.error).toBe(false);
    expect(progress.selection).toBe(originalSelection);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    card.id = originalAgent;
  }
});

it("retains supported capability and retry without a stale service list after list failure", async () => {
  const originalAgent = card.id;
  const capability: ServiceCapability = {
    apiTypes: ["responses"],
    validatedApiTypes: [],
    selectionScope: "connection",
    unavailableReason: null,
  };
  const records: Credential[] = [
    {
      id: "previous-service",
      label: "Previous service",
      provider: "example",
      endpoint: "https://example.test",
      apiType: "responses",
      models: ["previous-model"],
      revision: "previous",
      complete: true,
      deleting: false,
      grants: [],
    },
  ];
  try {
    progress = { ...progress, step: 1, choice: "api" };
    h.getCapabilities.mockResolvedValue(capability);
    h.listCredentials.mockResolvedValue(records);
    card.id = "supported-with-list-failure";
    render();
    for (let round = 0; round < 6; round++) await Promise.resolve();
    const previous = render().find(
      (node) => node.type === AgentServiceSection,
    )!;
    expect(previous.props.items).toEqual(records);
    h.listCredentials.mockRejectedValueOnce(new Error("list unavailable"));
    (previous.props.onRetry as () => void)();
    render();
    for (let round = 0; round < 6; round++) await Promise.resolve();
    const failed = render().find((node) => node.type === AgentServiceSection)!;
    expect(failed.props.capability).toEqual(capability);
    expect(failed.props.items).toEqual([]);
    expect(failed.props.error).toBe(true);
    const section = AgentServiceSection(
      failed.props as ComponentProps<typeof AgentServiceSection>,
    )!;
    expect(
      Children.toArray(section.props.children)
        .filter(isValidElement<{ children?: ReactNode }>)
        .some((node) => node.props.children === ACCESS_STRINGS.retry),
    ).toBe(true);
  } finally {
    card.id = originalAgent;
  }
});

it("ignores late service data and failures from the previous Agent", async () => {
  const originalAgent = card.id;
  let finishCapability!: (capability: ServiceCapability) => void;
  let failList!: (reason: Error) => void;
  const pendingCapability = new Promise<ServiceCapability>((resolve) => {
    finishCapability = resolve;
  });
  const pendingList = new Promise<Credential[]>((_resolve, reject) => {
    failList = reject;
  });
  const currentCapability: ServiceCapability = {
    apiTypes: ["responses"],
    validatedApiTypes: [],
    selectionScope: "connection",
    unavailableReason: null,
  };
  try {
    progress = { ...progress, step: 1, choice: "api" };
    h.getCapabilities.mockReturnValueOnce(pendingCapability);
    h.listCredentials.mockReturnValueOnce(pendingList);
    card.id = "previous-pending-agent";
    render();
    h.getCapabilities.mockResolvedValue(currentCapability);
    card.id = "current-loaded-agent";
    render();
    for (let round = 0; round < 6; round++) await Promise.resolve();
    const loaded = render().find((node) => node.type === AgentServiceSection)!;
    expect(loaded.props.capability).toEqual(currentCapability);
    expect(loaded.props.error).toBe(false);
    finishCapability({ ...currentCapability, apiTypes: [] });
    failList(new Error("previous list unavailable"));
    for (let round = 0; round < 6; round++) await Promise.resolve();
    const current = render().find((node) => node.type === AgentServiceSection)!;
    expect(current.props.capability).toEqual(currentCapability);
    expect(current.props.items).toEqual([]);
    expect(current.props.error).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    card.id = originalAgent;
  }
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

it("lets a new draft reach every model and reasoning choice while retaining the complete selection", async () => {
  const thread = h.thread as { configOptions: ReturnType<typeof options> };
  const extra = [
    {
      id: "inference_speed",
      category: "model",
      name: "Speed",
      currentValue: "standard",
    },
    {
      id: "reasoning_effort",
      category: "thought_level",
      name: "Reasoning",
      currentValue: "medium",
    },
    {
      id: "thinking_budget",
      category: "thought_level",
      name: "Thinking Budget",
      currentValue: "0",
    },
  ];
  thread.configOptions.push(
    ...extra.map((option) => ({
      ...option,
      type: "select",
      options: [option.currentValue, "other"].map((value) => ({
        value,
        name: value,
      })),
    })),
  );
  const config = Object.fromEntries(
    thread.configOptions.map((o) => [o.id, o.currentValue]),
  );
  progress.selection = { service: null, config };
  const snapshot = h.snapshot as PreparationSnapshot;
  snapshot.config = config;
  snapshot.input!.config = config;
  h.setConfig.mockImplementation(async (_key, id, value) => {
    thread.configOptions.find((o) => o.id === id)!.currentValue = value;
  });
  const nodes = render();
  const pickers = nodes.filter((node) => node.type === ModelPicker);
  expect(pickers).toHaveLength(2);
  expect(
    nodes
      .filter((node) => node.type === "select")
      .map((node) => node.props["aria-label"]),
  ).toEqual(["Reasoning", "Thinking Budget"]);
  const speed = pickers.find(
    (node) => (node.props.option as { id: string }).id === "inference_speed",
  )!;
  (speed.props.onPick as (value: string) => void)("other");
  await Promise.resolve();
  await Promise.resolve();
  expect(h.setConfig).toHaveBeenCalledWith(
    "owned-preparation",
    "inference_speed",
    "other",
  );
  expect(progress.selection).toEqual({
    service: null,
    config: { ...config, inference_speed: "other" },
  });
  expect(h.start).not.toHaveBeenCalled();
});

it("selects a real method atomically without executing it or borrowing the API source", () => {
  progress = {
    step: 1,
    choice: "api",
    accessStage: "api",
    preparationActionId: "old-action",
    selection: {
      service: { id: "saved", model: "saved-model", revision: "saved" },
      config: { model: "saved-model" },
    },
  };
  h.prepare.mockClear();
  const account = render().find((node) => node.type === AgentAuthSection)!;
  const connection = account.props.connection as {
    onChoice: (
      choice: "existing" | "login" | "api",
      methodId?: string,
      actionId?: string,
    ) => void;
  };
  connection.onChoice("login", "declared-method");
  expect(progress).toEqual(
    expect.objectContaining({
      choice: "login",
      accessStage: "method",
      authMethodId: "declared-method",
      preparationActionId: undefined,
      selection: { service: null, config: {} },
    }),
  );
  connection.onChoice("existing", undefined, "declared-action");
  expect(progress.authMethodId).toBeUndefined();
  expect(progress.preparationActionId).toBe("declared-action");
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
});

it("keeps pure method selection out of the model step and explicitly resumes existing settings", async () => {
  progress = {
    step: 1,
    choice: "existing",
    accessStage: "method",
    selection: { service: null, config: { model: "A" } },
  };
  h.prepare.mockClear();
  let nodes = render();
  expect(
    nodes.find(
      (node) => node.type === "button" && node.props.children === P.nextModel,
    ),
  ).toBeUndefined();
  const connection = nodes.find((node) => node.type === AgentAuthSection)!.props
    .connection as { onUseExisting: () => void };
  connection.onUseExisting();
  expect(progress).toEqual(
    expect.objectContaining({
      choice: "existing",
      accessStage: "account",
      selection: { service: null, config: { model: "A" } },
    }),
  );
  nodes = render();
  const next = nodes.find(
    (node) => node.type === "button" && node.props.children === P.nextModel,
  )!;
  expect(next.props.disabled).toBe(false);
  await (next.props.onClick as () => Promise<void>)();
  expect(progress.step).toBe(2);
  expect(h.start).not.toHaveBeenCalled();
});

it("puts the account action in the footer once and preserves choices on step return", () => {
  progress = {
    step: 1,
    choice: "login",
    accessStage: "method",
    authMethodId: "official",
    selection: { service: null, config: { model: "A" } },
  };
  const account = render().find((node) => node.type === AgentAuthSection)!;
  const primary = {
    id: "official-login",
    label: "继续官方登录",
    disabled: false,
    run: vi.fn(),
  };
  (
    account.props.connection as {
      onPrimaryChange: (value: typeof primary) => void;
    }
  ).onPrimaryChange(primary);
  const nodes = render();
  const buttons = nodes.filter(
    (node) => node.type === "button" && node.props.children === primary.label,
  );
  expect(buttons).toHaveLength(1);
  (buttons[0].props.onClick as () => void)();
  expect(primary.run).toHaveBeenCalledOnce();
  expect(
    nodes.find(
      (node) => node.type === "button" && node.props.children === P.nextModel,
    ),
  ).toBeUndefined();
  const back = nodes.find(
    (node) => node.type === "button" && node.props.children === R.backProgram,
  )!;
  (back.props.onClick as () => void)();
  expect(progress).toEqual(
    expect.objectContaining({
      step: 0,
      authMethodId: "official",
      selection: { service: null, config: { model: "A" } },
    }),
  );
});

it("continues from a compatible service to explicit model selection without an implicit read or completion", async () => {
  const originalAgent = card.id;
  const service: Credential = {
    id: "service",
    label: "Selected service",
    provider: "example",
    endpoint: "https://example.test",
    apiType: "responses",
    models: ["first", "selected"],
    revision: "current",
    complete: true,
    deleting: false,
    grants: [],
  };
  try {
    card.id = "r5-service-model";
    progress = {
      step: 1,
      choice: "api",
      accessStage: "api",
      selection: {
        service: { id: service.id, revision: service.revision, model: "" },
        config: {},
      },
    };
    h.getCapabilities.mockResolvedValue({
      apiTypes: ["responses"],
      validatedApiTypes: [],
      selectionScope: "connection",
      unavailableReason: null,
    });
    h.listCredentials.mockResolvedValue([service]);
    h.prepare.mockClear();
    render();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    let nodes = render();
    const next = nodes.find(
      (node) => node.type === "button" && node.props.children === P.nextModel,
    )!;
    expect(next.props.disabled).toBe(false);
    await (next.props.onClick as () => Promise<void>)();
    nodes = render();
    expect(progress.step).toBe(2);
    expect(progress.selection?.service?.model).toBe("");
    expect(h.prepare).not.toHaveBeenCalled();
    const finish = nodes.find(
      (node) =>
        node.type === "button" &&
        node.props.children === ACCESS_STRINGS.useSelection,
    )!;
    expect(finish.props.disabled).toBe(true);
    const models = nodes.find((node) => node.type === ServiceModelPicker)!;
    (
      models.props.onChange as (
        value: NonNullable<AgentSetupProgress["selection"]>["service"],
      ) => void
    )({ id: service.id, revision: service.revision, model: "selected" });
    nodes = render();
    expect(progress.selection?.service?.model).toBe("selected");
    expect(h.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        service: {
          id: service.id,
          revision: service.revision,
          model: "selected",
        },
      }),
    );
    expect(
      nodes.find(
        (node) =>
          node.type === "button" &&
          node.props.children === ACCESS_STRINGS.useSelection,
      )?.props.disabled,
    ).toBe(true);
    expect(h.start).not.toHaveBeenCalled();
  } finally {
    card.id = originalAgent;
  }
});

it.each([
  { choice: "api", accessStage: "api", method: "official", allow: false },
  { choice: "login", accessStage: "method", method: "official", allow: false },
  { choice: "login", accessStage: "account", method: "other", allow: false },
  { choice: "login", accessStage: "account", method: undefined, allow: false },
  { choice: "login", accessStage: "account", method: "official", allow: true },
] as const)(
  "isolates the model gate from prior receipts for $choice/$accessStage/$method",
  ({ choice, accessStage, method, allow }) => {
    progress = {
      step: 1,
      choice,
      accessStage,
      authMethodId: method,
      selection: { service: null, config: {} },
    };
    h.authJob = {
      phase: "completed",
      checked: true,
      target: { agentId: card.id, cwd: "/own" },
      operation: {
        kind: "authentication",
        methodId: "official",
        intent: "login",
      },
    };
    const nodes = render();
    const account = nodes.find((node) => node.type === AgentAuthSection)!;
    expect(account.props.canOpenModels).toBe(allow);
    const next = nodes.find(
      (node) => node.type === "button" && node.props.children === P.nextModel,
    );
    expect(next?.props.disabled === false).toBe(allow);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  },
);

it.each(["keep", "discard"])(
  "offers an explicit %s exit after source or model choices change",
  (decision) => {
    render();
    progress = {
      ...progress,
      selection: { service: null, config: { model: "C" } },
    };
    const changedView = render();
    const close = changedView.find(
      (node) =>
        node.type === "button" &&
        node.props["aria-label"] === ACCESS_STRINGS.close,
    )!;
    (close.props.onClick as () => void)();
    expect(h.close).not.toHaveBeenCalled();
    const confirmation = render().find(
      (node) => node.type === AgentSetupExitReview,
    )!;
    expect(confirmation).toBeDefined();
    (
      confirmation.props[
        decision === "keep" ? "onKeep" : "onDiscard"
      ] as () => void
    )();
    expect(h.close).toHaveBeenCalledOnce();
    expect(progress.selection?.config).toEqual({
      model: decision === "keep" ? "C" : "A",
    });
    expect(h.start).not.toHaveBeenCalled();
  },
);

it("continues editing without changing choices or closing when the exit review is dismissed", () => {
  render();
  progress = {
    ...progress,
    selection: { service: null, config: { model: "C" } },
  };
  const close = render().find(
    (node) =>
      node.type === "button" &&
      node.props["aria-label"] === ACCESS_STRINGS.close,
  )!;
  (close.props.onClick as () => void)();
  const confirmation = render().find(
    (node) => node.type === AgentSetupExitReview,
  )!;
  (confirmation.props.onContinue as () => void)();
  expect(
    render().find((node) => node.type === AgentSetupExitReview),
  ).toBeUndefined();
  expect(progress.selection?.config).toEqual({ model: "C" });
  expect(h.close).not.toHaveBeenCalled();
});

it("hides the nested exit review when the Agent surface is no longer active", () => {
  render();
  progress = {
    ...progress,
    selection: { service: null, config: { model: "C" } },
  };
  const close = render().find(
    (node) =>
      node.type === "button" &&
      node.props["aria-label"] === ACCESS_STRINGS.close,
  )!;
  (close.props.onClick as () => void)();
  expect(
    render().find((node) => node.type === AgentSetupExitReview),
  ).toBeDefined();
  expect(
    render(false).find((node) => node.type === AgentSetupExitReview),
  ).toBeUndefined();
  expect(progress.selection?.config).toEqual({ model: "C" });
});
