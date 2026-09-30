import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  methods: vi.fn(async () => ({ methods: [], canLogout: false })),
  recheck: vi.fn(async (_target: unknown, changed: () => Promise<void>) => {
    await changed();
  }),
  reconnect: vi.fn(async () => {}),
  changed: vi.fn(async () => {}),
}));
// Keep real effect dependencies and state updates: a method-table reload must
// not silently clear the error raised by the preceding account check.
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
    const index = h.cursor++;
    const previous = h.effects[index];
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../runtime/agents", () => ({ authMethods: h.methods }));
vi.mock("../runtime/auth_actions", () => ({
  beginAuthentication: vi.fn(),
  recheckAuthentication: h.recheck,
}));
vi.mock("../runtime/authentication", () => ({
  useAuthenticationActivity: () => null,
  authenticationActivity: () => ({ getSnapshot: () => null }),
  invalidateAuthentication: vi.fn(),
}));
vi.mock("../runtime/sessions", () => ({
  useThreadsSnapshot: () => ({ threads: new Map() }),
  threads: { getSnapshot: () => ({ threads: new Map() }) },
}));
vi.mock("./ManualAuthSection", () => ({ ManualAuthSection: () => null }));
vi.mock("./InlineTerminal", () => ({ InlineTerminal: () => null }));
vi.mock("./AgentAccountLinks", () => ({ AgentAccountLinks: () => null }));

import { AgentAuthSection } from "./AgentAuthSection";
import { AUTH_ACTIVITY_STRINGS as S } from "../runtime/auth_strings";

type Element = ReactElement<Record<string, unknown>>;
function render(source?: string) {
  h.cursor = 0;
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(
    AgentAuthSection({
      agentId: "account-check",
      cwd: "/original",
      source,
      onConfigureKey() {},
      onChanged: h.changed,
      onReconnect: h.reconnect,
    }),
  );
  for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
async function settled(source?: string) {
  let nodes: Element[] = [];
  // Flush both async action callbacks and the effects they schedule.
  for (let round = 0; round < 6; round++) {
    nodes = render(source);
    await Promise.resolve();
  }
  return nodes;
}
function check(nodes: Element[]) {
  const button = nodes.find(
    (node) => node.type === "button" && node.props.children === S.check,
  )!;
  expect(button.props.disabled).toBe(false);
  (button.props.onClick as () => void)();
}
function alerts(nodes: Element[]) {
  return nodes
    .filter((node) => node.props.role === "alert")
    .flatMap((node) => Children.toArray(node.props.children as ReactNode))
    .filter((node) => typeof node === "string");
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  vi.clearAllMocks();
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
});

it("keeps a failed existing-account check visible until a successful retry", async () => {
  h.recheck.mockRejectedValueOnce(new Error("账号连接检查失败，请重试"));
  check(await settled());
  expect(alerts(await settled())).toContain("账号连接检查失败，请重试");
  expect(alerts(await settled())).toContain("账号连接检查失败，请重试");
  expect(h.methods).toHaveBeenCalledOnce();
  expect(h.changed).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();

  check(await settled());
  expect(alerts(await settled())).toEqual([]);
  expect(h.recheck).toHaveBeenCalledTimes(2);
  expect(h.recheck).toHaveBeenLastCalledWith(
    { agentId: "account-check", cwd: "/original" },
    h.changed,
  );
  expect(h.changed).toHaveBeenCalledOnce();
  expect(h.methods).toHaveBeenCalledTimes(2);
});

it("keeps API rechecking on its selected service and preserves a failed result", async () => {
  h.reconnect.mockRejectedValueOnce(new Error("所选 API 检查失败，请重试"));
  check(await settled("selected-service"));
  expect(alerts(await settled("selected-service"))).toContain(
    "所选 API 检查失败，请重试",
  );
  expect(h.recheck).not.toHaveBeenCalled();
  expect(h.methods).toHaveBeenCalledOnce();

  check(await settled("selected-service"));
  expect(alerts(await settled("selected-service"))).toEqual([]);
  expect(h.reconnect).toHaveBeenCalledTimes(2);
  expect(h.recheck).not.toHaveBeenCalled();
});
