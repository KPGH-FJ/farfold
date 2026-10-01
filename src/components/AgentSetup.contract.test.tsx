import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({
  locationReady: false,
  snapshot: {
    phase: "untested",
    input: null,
    threadKey: null,
    config: {},
    prompt: "",
    reply: "",
    error: null,
  } as unknown,
  controller: {
    canPrepare: () => true,
    verified: () => false,
    invalidate: vi.fn(),
    prepare: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
  inventory: {
    items: [],
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
  },
}));
vi.mock("../runtime/agent_preparation", async (original) => ({
  ...(await original<typeof import("../runtime/agent_preparation")>()),
  usePreparation: () => ({ state: h.snapshot, controller: h.controller }),
}));
// Account operation subscriptions are client-only and covered by their own
// behavioral tests. This SSR contract checks how setup composes that control.
vi.mock("./AgentAuthSection", () => ({ AgentAuthSection: () => null }));
// A previously completed read has a confirmed directory. Other SSR cases
// retain the pending lookup; resolving it is covered by the effect harness.
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({
    ready: h.locationReady,
    cwd: h.locationReady ? cwd : undefined,
    enabled: () => h.locationReady,
  }),
}));
vi.mock("./ProgramManager", async (original) => ({
  ...(await original<typeof import("./ProgramManager")>()),
  useProgramInventory: () => h.inventory,
}));
import { AgentSetup } from "./AgentSetup";
import { AgentSetupNavigation } from "./AgentSetupNavigation";
import { AgentAuthSection } from "./AgentAuthSection";
import { AgentPrerequisites } from "./AgentPrerequisites";
import { preparationProgram } from "../runtime/agent_preparation";
import { ACCESS_STRINGS as S } from "../runtime/access_strings";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
const card: AgentCardModel = {
  id: "setup-contract",
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
const agents = { busy: {}, errors: {}, installProgress: {} } as AgentsState;
type Element = ReactElement<Record<string, unknown>>;
function render(extra: Partial<ComponentProps<typeof AgentSetup>> = {}) {
  const onClose = vi.fn(),
    onStart = vi.fn();
  let tree: ReactNode;
  function Capture() {
    tree = AgentSetup({
      card,
      agents,
      cwd: "/own-test",
      onClose,
      onStart,
      onOpenApi() {},
      progress: {
        step: 2,
        choice: "existing",
        selection: { service: null, config: { model: "chosen" } },
      },
      onProgress() {},
      ...extra,
    });
    return tree;
  }
  const html = renderToStaticMarkup(<Capture />);
  const elements: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return { html, elements, onClose, onStart };
}
beforeEach(() => {
  h.locationReady = false;
  vi.clearAllMocks();
  h.snapshot = {
    phase: "untested",
    input: null,
    threadKey: null,
    config: {},
    prompt: "",
    reply: "",
    error: null,
  };
});
it("refreshes an installed candidate's list without applying a choice or invalidating the current preparation", async () => {
  const refresh = vi.fn(async () => {});
  const onProgress = vi.fn();
  const view = render({ agents: { ...agents, refresh }, onProgress });
  const prerequisites = view.elements.find(
    (node) => node.type === AgentPrerequisites,
  )!;
  await (prerequisites.props.onInstalled as () => Promise<void>)();
  expect(refresh).toHaveBeenCalledOnce();
  expect(h.inventory.refresh).toHaveBeenCalledOnce();
  expect(h.controller.invalidate).not.toHaveBeenCalled();
  expect(h.controller.prepare).not.toHaveBeenCalled();
  expect(onProgress).not.toHaveBeenCalled();
  expect(view.onStart).not.toHaveBeenCalled();
});
it("does not describe a failed short test as never tested", () => {
  h.snapshot = {
    phase: "failed",
    input: null,
    threadKey: null,
    config: {},
    prompt: "",
    reply: "",
    error: "AUTH_REQUIRED",
  };
  const view = render();
  expect(view.html).toContain("当前选择尚无成功回复");
  expect(view.html).not.toContain("尚未测试实际回复");
});
it("still refreshes the local candidate list when a catalog refresh fails", async () => {
  const refresh = vi.fn(async () => {
    throw new Error("catalog unavailable");
  });
  const view = render({ agents: { ...agents, refresh } });
  const prerequisites = view.elements.find(
    (node) => node.type === AgentPrerequisites,
  )!;
  await expect(
    (prerequisites.props.onInstalled as () => Promise<void>)(),
  ).rejects.toThrow("catalog unavailable");
  expect(h.inventory.refresh).toHaveBeenCalledOnce();
  expect(h.controller.invalidate).not.toHaveBeenCalled();
});
it("completes management by closing without applying a choice or starting a conversation", () => {
  const view = render({ intent: "manage" });
  expect(view.html).toContain("账号与服务");
  expect(view.html).toContain("不改变已有对话");
  const done = view.elements.find(
    (node) => node.type === "button" && node.props.children === P.save,
  )!;
  expect(done.props.disabled).toBe(false);
  (done.props.onClick as () => void)();
  expect(view.onClose).toHaveBeenCalledOnce();
  expect(view.onStart).not.toHaveBeenCalled();
});

it("keeps daily model controls direct while preserving the first-use review", () => {
  const managed = render({ intent: "manage" });
  expect(managed.html).not.toContain('class="agent-setup-review"');
  expect(managed.html).toContain("不改变已有对话");
  expect(render({ intent: "use" }).html).toContain(
    'class="agent-setup-review"',
  );
});

it("does not close the Agent setup when a nested dialog receives Escape", () => {
  const view = render({ intent: "manage" });
  const dialog = view.elements.find((node) => node.type === "dialog")!;
  const currentTarget = {},
    preventDefault = vi.fn(),
    stopPropagation = vi.fn();
  const cancel = dialog.props.onCancel as (event: unknown) => void;
  cancel({ target: {}, currentTarget, preventDefault, stopPropagation });
  expect(view.onClose).not.toHaveBeenCalled();
  cancel({
    target: currentTarget,
    currentTarget,
    preventDefault,
    stopPropagation,
  });
  expect(view.onClose).toHaveBeenCalledOnce();
  expect(stopPropagation).toHaveBeenCalledOnce();
});

it("puts daily disconnect before advanced program controls without first-use instructions", () => {
  const disconnect = vi.fn(),
    onImport = vi.fn();
  const managed = render({
    intent: "manage",
    agents: { ...agents, disconnect },
    progress: { step: 0, choice: "existing" },
    onImport,
  });
  expect(managed.html).not.toContain(P.programHint);
  expect(managed.html).not.toContain(S.connectedHint);
  const stop = managed.elements.find(
    (node) => node.type === "button" && node.props.children === "断开",
  )!;
  expect(stop).toBeDefined();
  expect(managed.elements.indexOf(stop)).toBeLessThan(
    managed.elements.findIndex((node) => node.type === "details"),
  );
  (stop.props.onClick as () => void)();
  expect(disconnect).toHaveBeenCalledExactlyOnceWith(card.id);
  const importButton = render({ intent: "manage", onImport }).elements.find(
    (node) =>
      node.type === "button" && node.props.children === S.importConversations,
  )!;
  const opener = {} as HTMLElement;
  (
    importButton.props.onClick as (event: {
      currentTarget: HTMLElement;
    }) => void
  )({ currentTarget: opener });
  expect(onImport).toHaveBeenCalledExactlyOnceWith(card.id, opener);
});
it("shows model-read failure and retry outside the optional message test", () => {
  h.locationReady = true;
  h.snapshot = {
    phase: "failed",
    input: {
      agentId: card.id,
      agentName: card.name,
      cwd: "/own-test",
      program: preparationProgram(card),
      service: null,
      config: { model: "chosen" },
    },
    config: { model: "chosen" },
    threadKey: null,
    prompt: "",
    reply: "",
    error: "READ-OPTIONS-FAILED",
  };
  const view = render();
  expect(view.html).toContain("模型选项读取失败，原选择已保留");
  expect(view.html).toContain("重新读取模型");
  expect(view.html.indexOf("READ-OPTIONS-FAILED")).toBeLessThan(
    view.html.indexOf("发送一条短消息测试（可选）"),
  );
  expect(view.html).toContain(S.untestedReturnHint);
  expect(h.controller.start).not.toHaveBeenCalled();
});

it("routes unknown login capability to the program step while retaining management choices", () => {
  const onProgress = vi.fn();
  const connect = vi.fn();
  const progress = {
    step: 1,
    choice: "existing" as const,
    selection: { service: null, config: { model: "chosen" } },
    authMethodId: "previous-choice",
  };
  const view = render({
    intent: "manage",
    card: { ...card, status: "installed" },
    agents: { ...agents, connect },
    progress,
    onProgress,
  });
  expect(view.html).not.toContain(S.loginUnavailable);
  const navigation = view.elements.find(
    (node) => node.type === AgentSetupNavigation,
  )!;
  expect(navigation.props.step).toBe(0);
  expect(view.html).toContain("准备进度和选择已保留");
  expect(onProgress).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(view.onStart).not.toHaveBeenCalled();
});

it.each([false, true])(
  "leaves login methods to the shared account control: methods=%s",
  (provided) => {
    const view = render({
      card: {
        ...card,
        authMethods: provided ? ["official-login"] : [],
      },
      progress: { step: 1, choice: "existing" },
    });
    expect(
      view.elements.filter((node) => node.props.role === "radio"),
    ).toHaveLength(2);
    expect(view.elements.some((node) => node.type === AgentAuthSection)).toBe(
      true,
    );
    expect(view.html).not.toContain("请先连接程序，再读取登录方式");
  },
);

it.each([
  { accessStage: "method" as const, choice: "existing" as const },
  { accessStage: "account" as const, choice: "login" as const },
  { accessStage: undefined, choice: "login" as const },
])("explains disconnected restored preparation at $accessStage", (saved) => {
  const onProgress = vi.fn();
  const connect = vi.fn();
  const progress = {
    ...saved,
    step: 1,
    authMethodId: "saved-method",
    selection: {
      service: null,
      config: { model: "chosen", reasoning: "ultra" },
    },
  };
  const view = render({
    card: { ...card, status: "installed", authMethods: [] },
    agents: { ...agents, connect },
    progress,
    onProgress,
  });
  expect(view.html).toContain("准备进度和选择已保留");
  expect(
    view.elements.find((node) => node.type === AgentSetupNavigation)?.props
      .step,
  ).toBe(0);
  expect(onProgress).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(view.onStart).not.toHaveBeenCalled();
});

it("uses tabs without presenting prior steps as proof of completed preparation", () => {
  const view = render({ progress: { step: 1, choice: "existing" } });
  expect(view.html).toContain('role="tablist"');
  expect(view.html).not.toContain('class="complete"');
  expect(view.html).not.toContain("确认使用");
  expect(view.html).not.toContain("当前程序未连接");
});

it("orders preparation tabs and keyboard navigation from program through account to model", () => {
  const onStep = vi.fn();
  const navigation = AgentSetupNavigation({ step: 0, connected: true, onStep });
  const tabs = Children.toArray(navigation.props.children) as Element[];
  expect(tabs.map((tab) => [tab.props.id, tab.props.children])).toEqual([
    ["agent-setup-tab-0", "程序"],
    ["agent-setup-tab-1", "账号与服务"],
    ["agent-setup-tab-2", "模型"],
  ]);
  const buttons = tabs.map((tab) => ({
    focus: vi.fn(),
    click: tab.props.onClick,
    parentElement: { querySelectorAll: () => buttons },
  }));
  const press = (index: number, key: string) =>
    (tabs[index].props.onKeyDown as (event: unknown) => void)({
      key,
      preventDefault: vi.fn(),
      currentTarget: buttons[index],
    });
  press(0, "ArrowRight");
  expect(onStep).toHaveBeenLastCalledWith(1);
  press(1, "End");
  expect(onStep).toHaveBeenLastCalledWith(2);
  press(2, "Home");
  expect(onStep).toHaveBeenLastCalledWith(0);
  expect(buttons.every((button) => button.focus.mock.calls.length === 1)).toBe(
    true,
  );
});

it("keeps a pending account operation accessible while disconnected without enabling model reads", () => {
  const navigation = AgentSetupNavigation({
    step: 1,
    connected: false,
    accountActive: true,
    onStep() {},
  });
  const tabs = Children.toArray(navigation.props.children) as Element[];
  expect(
    tabs.find((node) => node.props.id === "agent-setup-tab-1")?.props.disabled,
  ).toBe(false);
  expect(
    tabs.find((node) => node.props.id === "agent-setup-tab-2")?.props.disabled,
  ).toBe(true);
  expect(
    tabs.find((node) => node.props.id === "agent-setup-tab-0")?.props.disabled,
  ).toBe(false);
});
