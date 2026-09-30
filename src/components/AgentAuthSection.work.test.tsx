import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ThreadState } from "../runtime/session_types";

const h = vi.hoisted(() => ({
  cursor: 0,
  threads: new Map<string, ThreadState>(),
  begin: vi.fn(),
  invalidate: vi.fn(),
  info: {
    methods: [{ id: "declared-login", kind: "agent", name: "Own login" }],
    canLogout: true,
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useRef: (value: unknown) => ({ current: value }),
  useState: (initial: unknown) => [
    h.cursor++ === 0 ? h.info : initial,
    vi.fn(),
  ],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../runtime/agents", () => ({ authMethods: vi.fn() }));
vi.mock("../runtime/auth_actions", () => ({ beginAuthentication: h.begin }));
vi.mock("../runtime/authentication", () => ({
  useAuthenticationActivity: () => null,
  authenticationActivity: () => ({ getSnapshot: () => null }),
  invalidateAuthentication: h.invalidate,
}));
vi.mock("../runtime/sessions", () => ({
  useThreadsSnapshot: () => ({ threads: h.threads }),
  threads: { getSnapshot: () => ({ threads: h.threads }) },
}));
vi.mock("./ManualAuthSection", () => ({ ManualAuthSection: () => null }));
vi.mock("./InlineTerminal", () => ({ InlineTerminal: () => null }));
vi.mock("./AgentAccountLinks", () => ({ AgentAccountLinks: () => null }));

import { AgentAuthSection } from "./AgentAuthSection";
import { freshThreadState } from "../runtime/session_projection";
import { AUTH_ACTIVITY_STRINGS as S } from "../runtime/auth_strings";
import { STRINGS } from "../runtime/strings";

type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode) {
  const result: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      result.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return result;
}
const open = vi.fn();
const changed = vi.fn(async () => {});
const reconnect = vi.fn(async () => {});
function render(source?: string) {
  h.cursor = 0;
  return elements(
    AgentAuthSection({
      agentId: "agent-a",
      cwd: "/work",
      source,
      onConfigureKey: vi.fn(),
      onChanged: changed,
      onReconnect: reconnect,
      onOpenConversation: open,
    }),
  );
}
const button = (nodes: Element[], label: string) =>
  nodes.find(
    (node) => node.type === "button" && node.props.children === label,
  )!;
const click = (node: Element) => (node.props.onClick as () => void)();
function running(agentId = "agent-a") {
  const state = freshThreadState("work", agentId, "/elsewhere", "native");
  Object.assign(state, {
    identity: "established",
    title: "Pending approval",
    running: true,
  });
  h.threads.set(state.key, state);
}
beforeEach(() => {
  h.threads.clear();
  vi.clearAllMocks();
});

it("shows concrete work and opens it while blocking account mutations", () => {
  running();
  const nodes = render();
  expect(nodes.some((node) => node.props.children === "Pending approval")).toBe(
    true,
  );
  for (const label of [
    STRINGS.agents.auth.start,
    STRINGS.agents.auth.logout,
    S.check,
  ]) {
    expect(button(nodes, label).props.disabled).toBe(true);
    click(button(nodes, label));
  }
  expect(h.begin).not.toHaveBeenCalled();
  expect(reconnect).not.toHaveBeenCalled();
  click(button(nodes, S.workOpen));
  expect(open).toHaveBeenCalledExactlyOnceWith("work");
});

it("rechecks the current work at click time instead of using an earlier enabled render", () => {
  const nodes = render();
  expect(button(nodes, STRINGS.agents.auth.start).props.disabled).toBe(false);
  running();
  click(button(nodes, STRINGS.agents.auth.start));
  expect(h.begin).not.toHaveBeenCalled();
  h.threads.clear();
  click(button(render(), STRINGS.agents.auth.start));
  expect(h.begin).toHaveBeenCalledOnce();
});

it("does not block another Agent and retains the API authentication boundary", () => {
  running("other-agent");
  expect(button(render(), STRINGS.agents.auth.start).props.disabled).toBe(
    false,
  );
  const nodes = render("selected-api");
  expect(button(nodes, STRINGS.agents.auth.start).props.disabled).toBe(true);
  click(button(nodes, STRINGS.agents.auth.start));
  expect(h.begin).not.toHaveBeenCalled();
});
