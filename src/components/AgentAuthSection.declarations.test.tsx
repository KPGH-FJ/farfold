import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentAuthSectionProps } from "./AgentAuthSection";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  methods: vi.fn(),
  begin: vi.fn(),
  recheck: vi.fn(async () => {}),
  configure: vi.fn(),
  changed: vi.fn(async () => {}),
  reconnect: vi.fn(async () => {}),
  invoke: vi.fn(async () => "/confirmed"),
  status: new Set<(event: { payload: { agentId: string } }) => void>(),
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      _name: string,
      listener: (event: { payload: { agentId: string } }) => void,
    ) => {
      h.status.add(listener);
      return () => h.status.delete(listener);
    },
  ),
}));
vi.mock("../runtime/agents", () => ({ authMethods: h.methods }));
vi.mock("../runtime/auth_actions", () => ({
  beginAuthentication: h.begin,
  beginPreparationAction: vi.fn(),
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
vi.mock("./AgentPreparationActions", () => ({
  AgentPreparationActions: () => null,
}));

import { AgentAuthSection } from "./AgentAuthSection";
import { AgentAccountLinks } from "./AgentAccountLinks";
import { ManualAuthSection } from "./ManualAuthSection";
import { AUTH_ACTIVITY_STRINGS as S } from "../runtime/auth_strings";
import { SETUP_PRESENTATION as P } from "../runtime/setup_presentation_strings";
import { STRINGS } from "../runtime/strings";

type Element = ReactElement<Record<string, unknown>>;
let props: AgentAuthSectionProps;
function render() {
  h.cursor = 0;
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(AgentAuthSection(props));
  for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
async function settled() {
  let nodes: Element[] = [];
  for (let round = 0; round < 6; round++) {
    nodes = render();
    await Promise.resolve();
  }
  return nodes;
}
function button(nodes: Element[], text: string) {
  return nodes.find(
    (node) => node.type === "button" && node.props.children === text,
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
const response = (kind = "agent", name = "Original method") => ({
  methods: [{ id: "method", name, kind, envName: null, terminalCommand: null }],
  canLogout: false,
});
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  vi.clearAllMocks();
  h.status.clear();
  h.methods.mockReset().mockResolvedValue(response());
  props = {
    agentId: "declaration-view",
    cwd: "/original",
    onConfigureKey: h.configure,
    onChanged: h.changed,
    onReconnect: h.reconnect,
  };
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
});

it.each(["environment", "unsupported"])(
  "shows a %s declaration without an automatic login or API route",
  async (kind) => {
    const reason = "此账号方式暂不能在这里自动完成，请查看官方说明。";
    h.methods.mockResolvedValue({
      methods: [
        {
          ...response(kind).methods[0],
          envNames: kind === "environment" ? ["PUBLIC_PROVIDER_KEY"] : [],
          unavailableReason: reason,
          rawPayload: { secret: "RAW-PAYLOAD-CANARY" },
        },
      ],
      canLogout: false,
    });
    const nodes = await settled();
    expect(button(nodes, STRINGS.agents.auth.start)).toBeUndefined();
    expect(button(nodes, STRINGS.access.apiRoute)).toBeUndefined();
    expect(nodes.some((node) => node.props.children === reason)).toBe(true);
    expect(
      nodes.some((node) => node.props.children === "PUBLIC_PROVIDER_KEY"),
    ).toBe(kind === "environment");
    expect(
      nodes.some((node) => node.props.children === "RAW-PAYLOAD-CANARY"),
    ).toBe(false);
    const links = nodes.find((node) => node.type === AgentAccountLinks)!;
    expect(links.props.onContinueLogin).toBeUndefined();
    expect(links.props.loginDisabled).toBe(true);
    expect(nodes.some((node) => node.props.children === P.moreLogin)).toBe(
      true,
    );
    const manual = nodes.find((node) => node.type === ManualAuthSection)!;
    expect(manual.props.disabled).toBe(false);
    expect(manual.props.declaredEnv).toBeNull();
    (manual.props.onRun as () => void)();
    expect(h.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { agentId: props.agentId, cwd: "/original", source: undefined },
        manual: true,
      }),
    );
    (button(nodes, S.check)!.props.onClick as () => void)();
    await vi.waitFor(() => expect(h.recheck).toHaveBeenCalledOnce());
    expect(h.configure).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  },
);

it("does not turn an environment kind without a reason into ordinary authenticate", async () => {
  h.methods.mockResolvedValue(response("environment"));
  const nodes = await settled();
  expect(button(nodes, STRINGS.agents.auth.start)).toBeUndefined();
  expect(button(nodes, STRINGS.access.apiRoute)).toBeUndefined();
  expect(h.begin).not.toHaveBeenCalled();
});

it("queries each actual directory/source and hides the previous target before its new query completes", async () => {
  const nodes = await settled();
  expect(h.methods).toHaveBeenLastCalledWith(props.agentId, {
    cwd: "/original",
    source: undefined,
  });
  const previousClick = button(nodes, STRINGS.agents.auth.start)!.props
    .onClick as () => void;
  const next = deferred<ReturnType<typeof response>>();
  h.methods.mockReturnValueOnce(next.promise);
  props = { ...props, cwd: "/new-location" };
  const changing = render();
  expect(button(changing, STRINGS.agents.auth.start)).toBeUndefined();
  previousClick();
  expect(h.begin).not.toHaveBeenCalled();
  await settled();
  expect(h.methods).toHaveBeenLastCalledWith(props.agentId, {
    cwd: "/new-location",
    source: undefined,
  });
  next.resolve(response("terminal", "New location method"));
  expect(
    (await settled()).some(
      (node) => node.props.children === "New location method",
    ),
  ).toBe(true);
  props = { ...props, source: "selected-api" };
  await settled();
  expect(h.methods).toHaveBeenLastCalledWith(props.agentId, {
    cwd: "/new-location",
    source: "selected-api",
  });
  expect(h.begin).not.toHaveBeenCalled();
});

it("ignores a late response from another directory without replacing current methods", async () => {
  const old = deferred<ReturnType<typeof response>>();
  h.methods.mockReturnValueOnce(old.promise);
  await settled();
  props = { ...props, cwd: "/current" };
  h.methods.mockResolvedValueOnce(response("terminal", "Current method"));
  await settled();
  old.resolve(response("agent", "Late wrong method"));
  const nodes = await settled();
  expect(nodes.some((node) => node.props.children === "Current method")).toBe(
    true,
  );
  expect(
    nodes.some((node) => node.props.children === "Late wrong method"),
  ).toBe(false);
});

it("queries the resolved default location rather than only an Agent-wide cache", async () => {
  props = { ...props, cwd: undefined };
  await settled();
  expect(h.invoke).toHaveBeenCalledWith("app_default_working_directory");
  expect(h.methods).toHaveBeenLastCalledWith(props.agentId, {
    cwd: "/confirmed",
    source: undefined,
  });
});

it("refreshes a display-only cache when this Agent connection changes, without running it", async () => {
  const cached = response();
  Object.assign(cached.methods[0], {
    unavailableReason: "请重新检查连接后再选择登录方式",
  });
  h.methods.mockResolvedValueOnce(cached);
  let nodes = await settled();
  expect(button(nodes, STRINGS.agents.auth.start)!.props.disabled).toBe(true);
  const calls = h.methods.mock.calls.length;
  for (const listener of h.status)
    listener({ payload: { agentId: "other-agent" } });
  await settled();
  expect(h.methods).toHaveBeenCalledTimes(calls);
  for (const listener of h.status)
    listener({ payload: { agentId: props.agentId } });
  nodes = await settled();
  expect(h.methods).toHaveBeenCalledTimes(calls + 1);
  expect(h.methods).toHaveBeenLastCalledWith(props.agentId, {
    cwd: "/original",
    source: undefined,
  });
  expect(button(nodes, STRINGS.agents.auth.start)!.props.disabled).toBe(false);
  expect(h.begin).not.toHaveBeenCalled();
  expect(h.reconnect).not.toHaveBeenCalled();
});

it.each(["agent", "api-key"])(
  "invalidates an earlier %s button immediately when connection facts change",
  async (kind) => {
    h.methods.mockResolvedValueOnce(response(kind));
    const nodes = await settled();
    const label =
      kind === "api-key" ? STRINGS.access.apiRoute : STRINGS.agents.auth.start;
    const click = button(nodes, label)!.props.onClick as () => void;
    for (const listener of h.status)
      listener({ payload: { agentId: props.agentId } });
    // Click the previously enabled control before React/effects can rerender.
    click();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.configure).not.toHaveBeenCalled();
  },
);

it("keeps another declared terminal choice usable beside an environment declaration", async () => {
  h.methods.mockResolvedValue({
    methods: [
      {
        ...response("environment", "Environment").methods[0],
        id: "environment",
        envNames: ["PUBLIC_PROVIDER_KEY"],
      },
      {
        ...response("terminal", "Official terminal").methods[0],
        id: "terminal",
      },
    ],
    canLogout: false,
  });
  let nodes = await settled();
  const select = nodes.find((node) => node.type === "select")!;
  (select.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "environment" },
  });
  nodes = await settled();
  expect(button(nodes, STRINGS.agents.auth.start)).toBeUndefined();
  expect(button(nodes, STRINGS.agents.auth.terminal)).toBeUndefined();
  (select.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "terminal" },
  });
  nodes = await settled();
  expect(button(nodes, STRINGS.agents.auth.terminal)!.props.disabled).toBe(
    false,
  );
  (button(nodes, STRINGS.agents.auth.terminal)!.props.onClick as () => void)();
  expect(h.begin).toHaveBeenCalledWith(
    expect.objectContaining({
      method: expect.objectContaining({ id: "terminal", kind: "terminal" }),
    }),
  );
  expect(h.configure).not.toHaveBeenCalled();
});

it("keeps an explicit failed account check visible when status events refresh its declaration table", async () => {
  h.recheck.mockRejectedValueOnce(new Error("此次账号连接检查失败，请重试"));
  (button(await settled(), S.check)!.props.onClick as () => void)();
  await settled();
  for (const listener of h.status)
    listener({ payload: { agentId: props.agentId } });
  const nodes = await settled();
  expect(
    nodes.some(
      (node) =>
        node.props.role === "alert" &&
        Children.toArray(node.props.children as ReactNode).includes(
          "此次账号连接检查失败，请重试",
        ),
    ),
  ).toBe(true);
  expect(h.begin).not.toHaveBeenCalled();
});
