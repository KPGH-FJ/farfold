import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type {
  AgentCardModel,
  AgentsState,
} from "../../../../src/runtime/agents";
import { writeEvidencePage } from "./render-shell.mjs";

const h = vi.hoisted(() => ({
  owner: "",
  cursor: 0,
  states: new Map<string, Map<number, unknown>>(),
  preparation: {} as unknown,
  thread: null as unknown,
  inventory: {} as unknown,
  desktop: vi.fn(() => {
    throw new Error("Controlled rendering must never invoke desktop commands");
  }),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      const controlled = h.states.get(h.owner);
      return react.useState(
        controlled?.has(index) ? controlled.get(index) : initial,
      );
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.desktop,
  Channel: class {},
}));
vi.mock("../../../../src/runtime/agent_preparation", async (original) => ({
  ...(await original<
    typeof import("../../../../src/runtime/agent_preparation")
  >()),
  usePreparation: () => ({
    state: h.preparation,
    controller: {
      canPrepare: () => true,
      verified: () => false,
      invalidate: h.desktop,
      prepare: h.desktop,
      confirmRead: h.desktop,
      start: h.desktop,
      stop: h.desktop,
    },
  }),
}));
vi.mock("../../../../src/runtime/sessions", async (original) => ({
  ...(await original<typeof import("../../../../src/runtime/sessions")>()),
  useThread: () => h.thread,
  useThreadsSnapshot: () => ({ index: [], threads: new Map() }),
  threads: {
    getSnapshot: () => ({ index: [], threads: new Map() }),
    thread: () => h.thread,
    setConfig: h.desktop,
  },
}));
vi.mock("../../../../src/runtime/authentication", async (original) => ({
  ...(await original<
    typeof import("../../../../src/runtime/authentication")
  >()),
  useAuthentication: () => new Set(),
  authenticationRequired: () => false,
  useAuthenticationActivity: () => null,
}));
vi.mock("../../../../src/runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({ cwd, ready: true, enabled: () => true }),
}));
vi.mock("../../../../src/runtime/connection_account", async (original) => ({
  ...(await original<
    typeof import("../../../../src/runtime/connection_account")
  >()),
  useConnectionAccount: () => ({
    kind: "account",
    email: "example@example.invalid",
    displayName: "受控账号",
    plan: "示例套餐",
  }),
}));
vi.mock("../../../../src/components/ProgramManager", async (original) => ({
  ...(await original<
    typeof import("../../../../src/components/ProgramManager")
  >()),
  useProgramInventory: () => h.inventory,
}));
// Render the actual children while scoping their test-only initial-state slots.
vi.mock("../../../../src/components/AgentAuthSection", async (original) => {
  const actual =
    await original<
      typeof import("../../../../src/components/AgentAuthSection")
    >();
  return {
    ...actual,
    AgentAuthSection: (
      props: ComponentProps<typeof actual.AgentAuthSection>,
    ) => {
      h.owner = "account";
      h.cursor = 0;
      const result = actual.AgentAuthSection(props);
      h.owner = "";
      return result;
    },
  };
});
vi.mock("../../../../src/components/AgentPrerequisites", async (original) => {
  const actual =
    await original<
      typeof import("../../../../src/components/AgentPrerequisites")
    >();
  return {
    ...actual,
    AgentPrerequisites: (
      props: ComponentProps<typeof actual.AgentPrerequisites>,
    ) => {
      h.owner = "prerequisites";
      h.cursor = 0;
      const result = actual.AgentPrerequisites(props);
      h.owner = "";
      return result;
    },
  };
});

import { AgentSetup } from "../../../../src/components/AgentSetup";
import { CustomAgentDialog } from "../../../../src/components/CustomAgentDialog";
import { preparationProgram } from "../../../../src/runtime/agent_preparation";
import { freshThreadState } from "../../../../src/runtime/session_projection";
import { customAgentDraft } from "../../../../src/runtime/custom_agent_draft";

const noop = () => {};
const cwd = "/controlled/example-project";
const card: AgentCardModel = {
  id: "controlled-agent",
  name: "受控 Agent",
  description: "用于正式组件视觉核对的虚构数据",
  status: "connected",
  version: "1.0.0-example",
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: "custom",
  installable: false,
  registerable: false,
  custom: true,
  handshake: null,
  programPath: "/controlled/programs/example-agent",
};
const selection = {
  service: null,
  config: { model: "example-a", reasoning: "high" },
};
const info = { dependencies: [], links: [], actions: [] };
const authInfo = {
  executionReady: true,
  canLogout: true,
  methods: [
    {
      id: "example-browser",
      name: "浏览器登录（受控样例）",
      description: "由 Agent 提供的登录方式示例",
      kind: "agent",
      purpose: "login",
      terminalCommand: null,
      envName: null,
    },
  ],
};
const agents = {
  cards: [card],
  busy: {},
  errors: {},
  installProgress: {},
  statuses: {
    [card.id]: [
      {
        agentId: card.id,
        cwd,
        purpose: "preparation",
        state: "ready",
        authMethods: [],
      },
    ],
  },
  refresh: h.desktop,
  connect: h.desktop,
  install: h.desktop,
  cancelInstall: h.desktop,
  addCustom: h.desktop,
} as unknown as AgentsState;

function ControlledSetup({ step }: { step: number }) {
  h.owner = "setup";
  h.cursor = 0;
  const result = AgentSetup({
    card,
    agents,
    cwd,
    active: true,
    intent: "manage",
    progress: { step, choice: "existing", accessStage: "method", selection },
    onProgress: noop,
    onClose: noop,
    onStart: noop,
    onOpenApi: noop,
    onImport: noop,
    onConfirmManagement: h.desktop,
  });
  h.owner = "";
  return result;
}
function render(element: ReactNode) {
  h.owner = "";
  h.cursor = 0;
  return renderToStaticMarkup(element);
}
function setupFrame(markup: string) {
  return `<div class="app product-app"><div class="body-row"><div class="workspace-route"><main class="main agent-hub-main agent-redesign">${markup}</main></div></div></div>`;
}
function customFrame(markup: string) {
  return `<div class="app product-app"><div class="body-row"><div class="workspace-route"><main class="main agent-hub-main agent-redesign"></main></div></div>${markup}</div>`;
}

it("renders current Agent setup partitions and custom form with controlled data and no desktop execution", () => {
  h.states = new Map([
    [
      "setup",
      new Map<number, unknown>([
        [1, info],
        [9, authInfo],
        [19, true],
        [20, true],
      ]),
    ],
    ["prerequisites", new Map<number, unknown>([[0, info]])],
    ["account", new Map<number, unknown>([[0, authInfo]])],
  ]);
  h.inventory = {
    loading: false,
    error: null,
    refresh: h.desktop,
    items: [
      {
        id: "example-selected",
        source: "custom",
        path: "/controlled/programs/example-agent",
        version: "1.0.0-example",
        managedRoot: null,
        programOnly: true,
        selected: true,
        inUse: false,
        canUninstall: false,
      },
      {
        id: "example-alternate",
        source: "external",
        path: "/controlled/alternate/example-agent",
        version: "0.9.0-example",
        managedRoot: null,
        programOnly: true,
        selected: false,
        inUse: false,
        canUninstall: false,
      },
    ],
  };
  const thread = freshThreadState(
    "controlled-preparation",
    card.id,
    cwd,
    "controlled-session",
  );
  thread.identity = "draft";
  thread.configOptions = [
    {
      id: "model",
      type: "select",
      name: "模型",
      category: "model",
      currentValue: "example-a",
      options: [
        { value: "example-a", name: "模型示例 A" },
        { value: "example-b", name: "模型示例 B" },
      ],
    },
    {
      id: "reasoning",
      type: "select",
      name: "思考程度",
      category: "thought_level",
      currentValue: "high",
      options: [
        { value: "low", name: "低" },
        { value: "high", name: "高" },
      ],
    },
  ];
  h.thread = thread;
  h.preparation = {
    phase: "untested",
    input: {
      agentId: card.id,
      agentName: card.name,
      cwd,
      program: preparationProgram(card),
      service: null,
      config: selection.config,
      readOptionsOnly: true,
    },
    threadKey: thread.key,
    config: selection.config,
    prompt: "",
    reply: "",
    error: null,
  };

  for (const [step, slug, title] of [
    [0, "program", "Agent 管理：程序"],
    [1, "account", "Agent 管理：账号与来源"],
    [2, "model", "Agent 管理：模型与思考程度"],
  ] as const) {
    const html = writeEvidencePage(
      `agent-setup-${slug}.html`,
      title,
      setupFrame(render(<ControlledSetup step={step} />)),
    );
    expect(html).toContain(`aria-labelledby="agent-setup-tab-${step}"`);
    expect(html).toContain("受控 Agent");
    if (step === 0)
      expect(html).toContain("/controlled/programs/example-agent");
    if (step === 1) expect(html).toContain("example@example.invalid");
    if (step === 2) expect(html).toContain("模型示例 A");
  }
  customAgentDraft.keep({
    name: "我的受控 Agent",
    command: "/controlled/programs/custom-agent",
    args: "--example-mode\nread-only",
    envText: "DISPLAY_MODE=compact",
  });
  try {
    const html = writeEvidencePage(
      "agent-custom-form.html",
      "自定义 Agent：保留的表单",
      customFrame(
        render(
          <CustomAgentDialog agents={agents} onClose={noop} onAdded={noop} />,
        ),
      ),
    );
    expect(html).toContain("我的受控 Agent");
    expect(html).toContain("DISPLAY_MODE=compact");
    // Select the exit-confirmation state for presentation evidence only.
    h.states.set("", new Map<number, unknown>([[4, true]]));
    const exitHtml = writeEvidencePage(
      "agent-custom-exit.html",
      "自定义 Agent：离开前确认",
      customFrame(
        render(
          <CustomAgentDialog agents={agents} onClose={noop} onAdded={noop} />,
        ),
      ),
    );
    expect(exitHtml).toContain("agent-custom-layout agent-custom-exit");
    expect(exitHtml).toContain("<footer");
    expect(exitHtml).toContain("继续填写");
  } finally {
    h.states.delete("");
    customAgentDraft.clear();
  }
  expect(h.desktop).not.toHaveBeenCalled();
});
