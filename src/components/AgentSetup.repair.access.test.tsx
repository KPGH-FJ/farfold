import {
  h,
  card,
  props,
  render,
  programConnect,
  conversationOnly,
  type Element,
} from "./AgentSetup.repair.test-support";
import { expect, it, vi } from "vitest";
import { Children, type ComponentProps } from "react";
import {
  initialAgentSetupProgress,
  type AgentSetupProgress,
} from "./AgentSetup";
import { AgentSetupNavigation } from "./AgentSetupNavigation";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { AgentInstallOptions } from "./AgentInstallOptions";
import { ProgramManager } from "./ProgramManager";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { ACCESS_STRINGS as S } from "../runtime/access_strings";

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
  props.agents.connect = vi.fn(async () => true);
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
  props.agents.connect = vi.fn(async () => true);
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
    const connect = vi.fn(async () => true);
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
  const connect = vi.fn(async () => true);
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
  const connect = vi.fn(async () => true);
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
    const connect = vi.fn(async () => true);
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

it("establishes one preparation connection at the account step when only a conversation connection exists", async () => {
  props.intent = "use";
  props.conversation = undefined;
  props.progress = { step: 1, choice: "existing" };
  const connect = vi.fn(async () => true);
  props.agents = {
    ...props.agents,
    connect,
    statuses: conversationOnly(),
  };
  render();
  await Promise.resolve();
  expect(connect).not.toHaveBeenCalled();
  // Only an empty declaration triggers the one-shot preparation connect.
  const auth = render().find((node) => node.type === AgentAuthSection)!;
  (auth.props.onInfoChange as (info: unknown) => void)({
    methods: [],
    canLogout: false,
    executionReady: false,
  });
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
    const connect = vi.fn(async () => true);
    props.agents = {
      ...props.agents,
      connect,
      statuses: conversationOnly(),
    };
    render();
    await Promise.resolve();
    const auth = render().find((node) => node.type === AgentAuthSection)!;
    (auth.props.onInfoChange as (info: unknown) => void)({
      methods: [],
      canLogout: false,
      executionReady: false,
    });
    render();
    await Promise.resolve();
    render();
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
  } finally {
    restore();
  }
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
