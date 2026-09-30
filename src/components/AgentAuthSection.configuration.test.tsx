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
  methods: vi.fn(),
  prepare: vi.fn(),
  recheck: vi.fn(async (_target: unknown, changed: () => Promise<void>) => {
    await changed();
  }),
  changed: vi.fn(async () => {}),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
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
  beginPreparationAction: h.prepare,
  recheckAuthentication: h.recheck,
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
import { InlineTerminal } from "./InlineTerminal";
import { AgentPreparationActions } from "./AgentPreparationActions";
import { authenticationActivity } from "../runtime/authentication";
import { AUTH_ACTIVITY_STRINGS as A } from "../runtime/auth_strings";
import { PREPARATION_ACTION_STRINGS as S } from "../runtime/preparation_action_strings";
import { STRINGS } from "../runtime/strings";
type Element = ReactElement<Record<string, unknown>>;
let sequence = 0,
  agentId: string;
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
      agentId,
      cwd: "/original",
      source,
      onConfigureKey() {},
      onChanged: h.changed,
      onReconnect: async () => {},
      onOpenModels: () => {},
    }),
  );
  for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
async function settled(source?: string) {
  let nodes: Element[] = [];
  for (let i = 0; i < 6; i++) {
    nodes = render(source);
    await Promise.resolve();
  }
  return nodes;
}
const button = (nodes: Element[], label: string) =>
  nodes.find(
    (node) => node.type === "button" && node.props.children === label,
  )!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  vi.clearAllMocks();
  agentId = `configuration-view-${++sequence}`;
  h.methods.mockResolvedValue({ methods: [], canLogout: false });
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
});

it("keeps an old result visible beside an API choice while refusing another configuration start", async () => {
  const job = authenticationActivity(agentId);
  job.begin(
    { agentId, cwd: "/original" },
    {
      kind: "preparation",
      actionId: "configure",
      purpose: "service_configuration",
      title: S.title,
      completion: "exit_code",
    },
    "attempt",
  );
  job.terminal({
    start: async () => "terminal",
    wait: async () => 1,
    close: async () => 1,
    reconnect: h.changed,
  });
  const nodes = await settled("api-context");
  expect(nodes.some((node) => node.props.children === S.exitFailed(1))).toBe(
    true,
  );
  const actions = nodes.find((node) => node.type === AgentPreparationActions)!;
  expect(actions.props.source).toBe("api-context");
  (actions.props.onRun as (value: unknown) => void)({ id: "configure" });
  expect(h.prepare).not.toHaveBeenCalled();
  await (button(nodes, A.check).props.onClick as () => Promise<void>)();
  expect(h.recheck).toHaveBeenCalledWith(
    { agentId, cwd: "/original" },
    h.changed,
  );
});

it("keeps the ended command, original terminal and failed check visible when methods disappear", async () => {
  const job = authenticationActivity(agentId),
    exit = deferred<number>();
  job.begin(
    { agentId, cwd: "/original" },
    {
      kind: "preparation",
      actionId: "configure",
      purpose: "service_configuration",
      title: S.title,
      completion: "exit_code",
    },
    "attempt",
  );
  job.terminal({
    start: async () => "terminal",
    wait: () => exit.promise,
    close: async () => 1,
    reconnect: async () => {
      throw new Error("connection failed");
    },
  });
  await settled();
  exit.resolve(0);
  await vi.waitFor(() => expect(job.getSnapshot()?.phase).toBe("completed"));
  h.methods.mockRejectedValue(new Error("methods unavailable"));
  // Remount the view with no retained method table or component state.
  for (const effect of h.effects) effect?.cleanup?.();
  h.slots = [];
  h.effects = [];
  let nodes = await settled();
  expect(nodes.some((node) => node.props.children === S.title)).toBe(true);
  expect(nodes.some((node) => node.props.children === S.ended)).toBe(true);
  expect(nodes.some((node) => node.props.role === "alert")).toBe(true);
  expect(
    nodes.find((node) => node.type === InlineTerminal)?.props,
  ).toMatchObject({
    session: job.getSnapshot()!.terminal,
    purpose: "service_configuration",
  });
  expect(nodes.some((node) => node.type === AgentPreparationActions)).toBe(
    true,
  );
  expect(button(nodes, A.check).props.disabled).toBe(false);
  await (button(nodes, A.check).props.onClick as () => Promise<void>)();
  nodes = await settled();
  expect(h.recheck).toHaveBeenCalledWith(
    { agentId, cwd: "/original" },
    h.changed,
  );
  expect(job.getSnapshot()).toMatchObject({
    phase: "completed",
    checked: true,
    error: null,
  });
  expect(nodes.some((node) => node.props.children === S.ended)).toBe(true);
  expect(nodes.some((node) => node.props.children === S.checked)).toBe(true);
});

it.each([1, 130])(
  "retains a nonzero or cancelled terminal exit %i with an explicit recheck",
  async (code) => {
    const job = authenticationActivity(agentId),
      exit = deferred<number>();
    job.begin(
      { agentId, cwd: "/original" },
      {
        kind: "preparation",
        actionId: "configure",
        purpose: "service_configuration",
        title: S.title,
        completion: "exit_code",
      },
      "attempt",
    );
    job.terminal({
      start: async () => "terminal",
      wait: () => exit.promise,
      close: async () => code,
      reconnect: h.changed,
    });
    if (code === 130) await job.cancel();
    else exit.resolve(code);
    let nodes = await settled();
    expect(job.getSnapshot()?.phase).toBe(
      code === 130 ? "cancelled" : "failed",
    );
    expect(button(nodes, A.check).props.disabled).toBe(false);
    expect(h.changed).not.toHaveBeenCalled();
    expect(nodes.some((node) => node.props.children === S.ended)).toBe(false);
    await (button(nodes, A.check).props.onClick as () => Promise<void>)();
    nodes = await settled();
    expect(job.getSnapshot()?.checked).toBe(true);
    expect(nodes.some((node) => node.type === InlineTerminal)).toBe(true);
    expect(
      nodes.some(
        (node) =>
          node.props.children ===
          (code === 130 ? S.cancelled : S.exitFailed(code)),
      ),
    ).toBe(true);
    exit.resolve(code);
  },
);

it("uses frozen authentication completion even when the latest method table is empty", async () => {
  const job = authenticationActivity(agentId),
    exit = deferred<number>();
  const operation = {
    kind: "authentication" as const,
    methodId: "method",
    title: "Original setup",
    completion: "return_and_verify" as const,
  };
  job.begin({ agentId, cwd: "/original" }, operation, "attempt");
  job.terminal({
    start: async () => "terminal",
    wait: () => exit.promise,
    close: async () => 1,
    reconnect: h.changed,
  });
  operation.title = "changed";
  const nodes = await settled();
  expect(nodes.some((node) => node.props.children === "Original setup")).toBe(
    true,
  );
  expect(button(nodes, STRINGS.agents.auth.returnToCheck)).toBeDefined();
  await job.cancel();
  exit.resolve(1);
});
