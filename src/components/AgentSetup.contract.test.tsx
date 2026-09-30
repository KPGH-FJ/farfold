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
}));
vi.mock("../runtime/agent_preparation", async (original) => ({
  ...(await original<typeof import("../runtime/agent_preparation")>()),
  usePreparation: () => ({ state: h.snapshot, controller: h.controller }),
}));
import { AgentSetup } from "./AgentSetup";
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
  expect(view.html).toContain("尚未测试实际回复");
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
  expect(view.html).toContain("请先连接程序，再读取登录方式");
  const program = view.elements.find(
    (node) => node.type === "button" && node.props.children === "前往连接程序",
  )!;
  (program.props.onClick as () => void)();
  expect(onProgress).toHaveBeenCalledExactlyOnceWith({ ...progress, step: 0 });
  expect(connect).not.toHaveBeenCalled();
  expect(view.onStart).not.toHaveBeenCalled();
});

it.each([false, true])(
  "uses connected login declarations: methods=%s",
  (provided) => {
    const view = render({
      card: {
        ...card,
        authMethods: provided ? ["official-login"] : [],
      },
      progress: { step: 1, choice: "existing" },
    });
    const login = view.elements.find(
      (node) => node.props.role === "radio" && node.key === "login",
    )!;
    expect(login.props.disabled).toBe(!provided);
    expect(view.html.includes(S.loginUnavailable)).toBe(!provided);
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
  expect(view.html).toContain("当前程序未连接");
  expect(view.html).toContain("准备进度和选择已保留");
  expect(view.html.match(/<ol[^>]*>.*?<\/ol>/s)?.[0]).not.toContain(
    'class="complete"',
  );
  expect(onProgress).not.toHaveBeenCalled();
  const program = view.elements.find(
    (node) => node.type === "button" && node.props.children === "前往连接程序",
  )!;
  (program.props.onClick as () => void)();
  expect(onProgress).toHaveBeenCalledExactlyOnceWith({ ...progress, step: 0 });
  expect(connect).not.toHaveBeenCalled();
  expect(view.onStart).not.toHaveBeenCalled();
});

it("marks the program step complete only while the program is connected", () => {
  const view = render({ progress: { step: 1, choice: "existing" } });
  expect(view.html.match(/<ol[^>]*>.*?<\/ol>/s)?.[0]).toContain(
    'class="complete"',
  );
  expect(view.html).not.toContain("当前程序未连接");
});
