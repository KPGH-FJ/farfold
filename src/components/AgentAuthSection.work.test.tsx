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
  recheck: vi.fn(async () => {}),
  info: {
    methods: [{ id: "declared-login", kind: "agent", name: "Own login" }] as {
      id: string;
      kind: string;
      name: string;
      unavailableReason?: string;
    }[],
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
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../runtime/agents", () => ({ authMethods: vi.fn() }));
vi.mock("../runtime/auth_actions", () => ({
  beginAuthentication: h.begin,
  recheckAuthentication: h.recheck,
}));
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
import { AgentAccountLinks } from "./AgentAccountLinks";
import { ManualAuthSection } from "./ManualAuthSection";

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
function render(source?: string, methodId?: string) {
  h.cursor = 0;
  return elements(
    AgentAuthSection({
      agentId: "agent-a",
      cwd: "/work",
      source,
      methodId,
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
  h.info.methods = [{ id: "declared-login", kind: "agent", name: "Own login" }];
});

it("keeps an unavailable method visible but blocks both automatic login entries", async () => {
  const reason = "此登录方式的程序目标尚未确认，请使用其他方式。";
  h.info.methods[0].unavailableReason = reason;
  const nodes = render();
  expect(nodes.some((node) => node.props.children === reason)).toBe(true);
  expect(button(nodes, STRINGS.agents.auth.start).props.disabled).toBe(true);
  click(button(nodes, STRINGS.agents.auth.start));
  const links = nodes.find((node) => node.type === AgentAccountLinks)!;
  expect(links.props.loginDisabled).toBe(true);
  expect(links.props.loginHint).toBe(reason);
  (links.props.onContinueLogin as () => void)();
  expect(h.begin).not.toHaveBeenCalled();
  expect(button(nodes, S.check).props.disabled).toBe(false);
  click(button(nodes, S.check));
  await vi.waitFor(() => expect(h.recheck).toHaveBeenCalledOnce());
  const manual = nodes.find((node) => node.type === ManualAuthSection)!;
  expect(manual.props.disabled).toBe(false);
  (manual.props.onRun as () => void)();
  expect(h.begin).toHaveBeenCalledOnce();
  expect(h.begin.mock.calls[0][0].manual).toBe(true);
});

it("does not block a different declared method when one automatic route is unavailable", () => {
  h.info.methods[0].unavailableReason = "此登录方式的程序目标尚未确认。";
  h.info.methods.push({ id: "other-login", kind: "agent", name: "Other" });
  const nodes = render(undefined, "other-login");
  expect(button(nodes, STRINGS.agents.auth.start).props.disabled).toBe(false);
  click(button(nodes, STRINGS.agents.auth.start));
  expect(h.begin).toHaveBeenCalledOnce();
  expect(h.begin.mock.calls[0][0].method.id).toBe("other-login");
});

it("shows concrete work and opens it while blocking account mutations", () => {
  running();
  const nodes = render();
  expect(nodes.some((node) => node.props.children === "Pending approval")).toBe(
    true,
  );
  for (const label of [STRINGS.agents.auth.start, STRINGS.agents.auth.logout]) {
    expect(button(nodes, label).props.disabled).toBe(true);
    click(button(nodes, label));
  }
  expect(h.begin).not.toHaveBeenCalled();
  expect(reconnect).not.toHaveBeenCalled();
  click(button(nodes, S.workOpen));
  expect(open).toHaveBeenCalledExactlyOnceWith("work");
});

it("can recheck this directory while retaining account-change guards for work elsewhere", async () => {
  running();
  const nodes = render();
  expect(button(nodes, STRINGS.agents.auth.start).props.disabled).toBe(true);
  expect(button(nodes, S.check).props.disabled).toBe(false);
  click(button(nodes, S.check));
  await vi.waitFor(() => expect(h.recheck).toHaveBeenCalledOnce());
});

it("rechecks exact-directory work again before replacing that connection", () => {
  const nodes = render();
  running();
  h.threads.get("work")!.cwd = "/work";
  click(button(nodes, S.check));
  expect(h.recheck).not.toHaveBeenCalled();
  expect(button(render(), S.check).props.disabled).toBe(true);
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

it("checks an existing account in the visible directory without a global reconnect", async () => {
  click(button(render(), S.check));
  await vi.waitFor(() =>
    expect(h.recheck).toHaveBeenCalledExactlyOnceWith(
      { agentId: "agent-a", cwd: "/work" },
      changed,
    ),
  );
  expect(reconnect).not.toHaveBeenCalled();
});
