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
import { AgentPreparationActions } from "./AgentPreparationActions";
import { PREPARATION_ACTION_STRINGS as S } from "../runtime/preparation_action_strings";
type Element = ReactElement<Record<string, unknown>>;
const action = {
  id: "configure",
  purpose: "service_configuration",
  transport: "terminal",
  command: "/managed/example",
  args: ["configure"],
  sourceUrl: "https://example.com/official",
};
let props: ComponentProps<typeof AgentPreparationActions>;
function render() {
  h.cursor = 0;
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(AgentPreparationActions(props));
  for (const effect of h.pending.splice(0)) effect();
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
  expect(h.run).toHaveBeenCalledExactlyOnceWith(action);
  expect(button(render(), S.run)).toBeUndefined();
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
