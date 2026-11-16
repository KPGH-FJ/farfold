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
  get: vi.fn(),
  run: vi.fn(),
  canonical: "/original" as string | null,
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
vi.mock("../runtime/preparation", () => ({ getAgentPreparation: h.get }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({
    ready: !!h.canonical,
    cwd: h.canonical,
    retry: vi.fn(),
  }),
}));
import { AgentPreparationActions } from "./AgentPreparationActions";
import { authConnectionOptions } from "./agent_auth_options";
import { PREPARATION_ACTION_STRINGS as S } from "../runtime/preparation_action_strings";
import type { AgentAccessPrimary } from "../runtime/access_primary";
import type { PreparationAction } from "../runtime/preparation";
type Element = ReactElement<Record<string, unknown>>;
const action: PreparationAction = {
  id: "configure",
  purpose: "service_configuration",
  transport: "terminal",
  command: "/managed/example",
  args: ["configure"],
  sourceUrl: "https://example.com/official",
};
let props: ComponentProps<typeof AgentPreparationActions>;
function render(flushEffects = true) {
  h.cursor = 0;
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(AgentPreparationActions(props));
  if (flushEffects) for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
async function settle() {
  let nodes: Element[] = [];
  for (let i = 0; i < 4; i++) {
    nodes = render();
    await Promise.resolve();
  }
  return nodes;
}
function button(nodes: Element[], label: string) {
  return nodes.find(
    (node) => node.type === "button" && node.props.children === label,
  )!;
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  vi.clearAllMocks();
  h.canonical = "/original";
  h.get.mockResolvedValue({ actions: [action], dependencies: [], links: [] });
  props = {
    agentId: "example",
    cwd: "/original",
    program: "program-a",
    disabled: false,
    onRun: h.run,
  };
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
});

it("requires a separate command review and an explicit run without deriving anything from auth methods", async () => {
  let nodes = await settle();
  expect(h.run).not.toHaveBeenCalled();
  expect(button(nodes, S.run)).toBeUndefined();
  (button(nodes, S.review).props.onClick as () => void)();
  nodes = render();
  expect(
    nodes.some(
      (node) =>
        node.type === "pre" &&
        node.props.children ===
          JSON.stringify([action.command, ...action.args]),
    ),
  ).toBe(true);
  expect(nodes.some((node) => node.props.children === S.effects)).toBe(true);
  expect(nodes.some((node) => node.props.children === S.environment)).toBe(
    true,
  );
  (button(nodes, S.run).props.onClick as () => void)();
  expect(h.run).toHaveBeenCalledExactlyOnceWith(action, "/original");
  expect(button(render(), S.run)).toBeUndefined();
});

it("keeps the official account login separate from the declared key setup and reviews the exact command", async () => {
  const login: PreparationAction = {
    ...action,
    id: "login-amp-account",
    purpose: "account_login",
    command: "/managed/amp",
    args: ["login"],
  };
  const choices = authConnectionOptions({
    existingAccount: null,
    methods: [
      {
        id: "setup",
        name: "Amp API Key Setup",
        kind: "terminal",
        description: null,
        terminalCommand: null,
        envName: null,
      },
    ],
    actions: [login],
    apiState: "unsupported",
  });
  expect(choices.map((choice) => choice.title)).toEqual([
    "Amp API Key Setup",
    S.accountLogin.title,
  ]);
  props.data = { actions: [login], error: null, onRetry: vi.fn() };
  let nodes = await settle();
  expect(button(nodes, S.accountLogin.run)).toBeUndefined();
  (button(nodes, S.review).props.onClick as () => void)();
  nodes = render();
  expect(h.run).not.toHaveBeenCalled();
  expect(
    nodes.some((node) => node.props.children === S.accountLogin.effects),
  ).toBe(true);
  expect(
    nodes.some(
      (node) =>
        node.type === "pre" &&
        node.props.children === JSON.stringify([login.command, "login"]),
    ),
  ).toBe(true);
  (button(nodes, S.accountLogin.run).props.onClick as () => void)();
  expect(h.run).toHaveBeenCalledExactlyOnceWith(login, "/original");
});
it("waits for the real location and reviews and runs the canonical directory from an independent account entry", async () => {
  props.cwd = "/tmp/alias";
  h.canonical = null;
  let nodes = await settle();
  expect(button(nodes, S.review).props.disabled).toBe(true);
  (button(nodes, S.review).props.onClick as () => void)();
  expect(h.run).not.toHaveBeenCalled();
  h.canonical = "/private/tmp/alias";
  nodes = await settle();
  (button(nodes, S.review).props.onClick as () => void)();
  nodes = render();
  expect(
    nodes.some((node) =>
      Children.toArray(node.props.children as ReactNode).includes(
        "/private/tmp/alias",
      ),
    ),
  ).toBe(true);
  (button(nodes, S.run).props.onClick as () => void)();
  expect(h.run).toHaveBeenCalledExactlyOnceWith(action, h.canonical);
  expect(props.cwd).toBe("/tmp/alias");
});
it.each([{ source: "api-context" }, { disabled: true }])(
  "does not start a blocked account source or busy operation: %j",
  async (blocked) => {
    Object.assign(props, blocked);
    const nodes = await settle(),
      review = button(nodes, S.review);
    expect(review.props.disabled).toBe(true);
    (review.props.onClick as () => void)();
    expect(button(render(), S.run)).toBeUndefined();
    expect(h.run).not.toHaveBeenCalled();
  },
);
it("requires a new review after the selected program changes", async () => {
  let nodes = await settle();
  (button(nodes, S.review).props.onClick as () => void)();
  props.program = "program-b";
  nodes = render();
  const staleRun = button(nodes, S.run);
  (staleRun.props.onClick as () => void)();
  expect(h.run).not.toHaveBeenCalled();
  nodes = await settle();
  expect(button(nodes, S.run)).toBeUndefined();
});
it("keeps a failed action lookup honest and allows one explicit retry", async () => {
  h.get.mockRejectedValueOnce(new Error("lookup failed"));
  let nodes = await settle();
  expect(nodes.some((node) => node.props.role === "alert")).toBe(true);
  expect(button(nodes, S.review)).toBeUndefined();
  (button(nodes, S.retry).props.onClick as () => void)();
  nodes = await settle();
  expect(button(nodes, S.review)).toBeDefined();
  expect(h.get).toHaveBeenCalledTimes(2);
  expect(h.run).not.toHaveBeenCalled();
});

function reviewedFooter() {
  const receive = vi.fn();
  props = {
    ...props,
    selectedId: action.id,
    reviewSelected: true,
    hideChoices: true,
    data: { actions: [action], error: null, onRetry: vi.fn() },
    onPrimaryChange: receive,
  };
  return receive;
}

it("reviews the shared selected terminal action and exposes its run only through one footer", async () => {
  const receive = reviewedFooter();
  const nodes = await settle();
  expect(h.get).not.toHaveBeenCalled();
  expect(button(nodes, S.review)).toBeUndefined();
  expect(button(nodes, S.run)).toBeUndefined();
  expect(nodes.find((node) => node.type === "pre")?.props.children).toBe(
    JSON.stringify([action.command, ...action.args]),
  );
  const footer = receive.mock.calls.at(-1)![0] as AgentAccessPrimary;
  expect(footer).toMatchObject({ label: S.run, disabled: false });
  expect(h.run).not.toHaveBeenCalled();
  footer.run();
  expect(h.run).toHaveBeenCalledExactlyOnceWith(action, "/original");
  await settle();
  expect(receive.mock.calls.at(-1)![0]).toBeNull();
  footer.run();
  expect(h.run).toHaveBeenCalledOnce();
});

it("uses only the owner return and revokes the old footer when it leaves the review", async () => {
  const receive = reviewedFooter();
  const cancel = vi.fn();
  Object.assign(props, { onCancelReview: cancel });
  const nodes = await settle();
  const footer = receive.mock.calls.at(-1)![0] as AgentAccessPrimary;
  expect(button(nodes, S.cancelReview)).toBeUndefined();
  props = { ...props, reviewSelected: false };
  await settle();
  expect(cancel).not.toHaveBeenCalled();
  expect(props.selectedId).toBe(action.id);
  expect(receive.mock.calls.at(-1)![0]).toBeNull();
  footer.run();
  expect(h.run).not.toHaveBeenCalled();
});

it("locks a reviewed old action when its shared data lookup fails before effect cleanup", async () => {
  const receive = reviewedFooter();
  await settle();
  const footer = receive.mock.calls.at(-1)![0] as AgentAccessPrimary;
  props = {
    ...props,
    data: { ...props.data!, error: S.loadFailed },
  };
  const nodes = render(false);
  expect(nodes.some((node) => node.props.role === "alert")).toBe(true);
  footer.run();
  expect(h.run).not.toHaveBeenCalled();
  await settle();
  const current = receive.mock.calls.at(-1)![0] as AgentAccessPrimary | null;
  expect(current === null || current.disabled).toBe(true);
});

it.each([
  "agent",
  "directory",
  "source",
  "program",
  "changed-action",
  "removed-action",
])(
  "rejects the previous reviewed footer when %s changes before effect cleanup",
  async (cause) => {
    const receive = reviewedFooter();
    await settle();
    const footer = receive.mock.calls.at(-1)![0] as AgentAccessPrimary;
    if (cause === "agent") props = { ...props, agentId: "another" };
    else if (cause === "directory") {
      h.canonical = "/new-directory";
      props = { ...props, cwd: h.canonical };
    } else if (cause === "source") props = { ...props, source: "api-context" };
    else if (cause === "program") props = { ...props, program: "program-b" };
    else
      props = {
        ...props,
        data: {
          ...props.data!,
          actions:
            cause === "removed-action"
              ? []
              : [{ ...action, args: ["changed"] }],
        },
      };
    render(false);
    footer.run();
    expect(h.run).not.toHaveBeenCalled();
  },
);
