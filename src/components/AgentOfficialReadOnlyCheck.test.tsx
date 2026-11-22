import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { OfficialReadOnlyCheck } from "../runtime/preparation";
import type { ConfigOptionView } from "../runtime/session_types";

const h = vi.hoisted(() => ({
  capability: undefined as unknown,
  invoke: vi.fn(),
  slots: [] as unknown[],
  cursor: 0,
  cleanup: undefined as (() => void) | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./useConnectionPreparation", () => ({
  useConnectionPreparation: () => ({
    info: { officialReadOnlyCheck: h.capability },
  }),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) => {
    const slot = h.cursor++;
    h.slots[slot] ??= { current: value };
    return h.slots[slot];
  },
  useState: (value: unknown) => {
    const slot = h.cursor++;
    h.slots[slot] ??= value;
    return [h.slots[slot], (next: unknown) => (h.slots[slot] = next)];
  },
  useLayoutEffect: (effect: () => () => void) => {
    h.cleanup ??= effect();
  },
}));

import { AgentOfficialReadOnlyCheck } from "./AgentOfficialReadOnlyCheck";
import { OFFICIAL_READONLY_CHECK_STRINGS as S } from "../runtime/official_readonly_check_strings";

type Node = ReactElement<Record<string, unknown>>;
const capability: OfficialReadOnlyCheck = {
  id: "check",
  modelOptionId: "chosen_model",
  reasoningOptionId: "chosen_depth",
};
const option = (id: string, value: unknown): ConfigOptionView => ({
  id,
  name: id,
  type: "select",
  currentValue: value,
  options: [],
});
const configOptions = [
  option("chosen_model", "model/a"),
  option("chosen_depth", "high"),
];
const report = {
  model: "model/a",
  reasoningEffort: "high",
  provider: "provider",
  accountPresent: true,
  workspaceReported: true,
};

function setup(options = configOptions) {
  return AgentOfficialReadOnlyCheck({
    program: "existing-program",
    thread: {
      agentId: "fixture",
      cwd: "/example",
      key: "preparation-draft",
      connectionId: "one",
      configOptions: options,
    },
  });
}

function render() {
  h.cursor = 0;
  const child = setup() as ReactElement<unknown, (props: unknown) => ReactNode>;
  const nodes: Node[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (value) => {
      if (!isValidElement<Record<string, unknown>>(value)) return;
      nodes.push(value);
      visit(value.props.children as ReactNode);
    });
  visit(child.type(child.props));
  return nodes;
}

function click(text: string) {
  const button = render().find(
    (node) => node.type === "button" && node.props.children === text,
  );
  expect(button).toBeDefined();
  (button?.props.onClick as () => void)();
}

async function settle() {
  // The typed invoke wrapper and then the view consume the same result.
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  h.capability = capability;
  h.slots = [];
  h.cleanup = undefined;
  h.invoke.mockReset();
});

it("requires explicitly advertised, unambiguous current choices and a click", () => {
  h.capability = undefined;
  expect(setup()).toBeNull();
  h.capability = capability;
  expect(setup([configOptions[0]])).toBeNull();
  expect(setup([...configOptions, configOptions[0]])).toBeNull();
  expect(setup([configOptions[0], option("chosen_depth", " ")])).toBeNull();
  expect(setup()).not.toBeNull();
  expect(h.invoke).not.toHaveBeenCalled();
});

it("checks only the exact selected settings and scopes the result to the temporary conversation", async () => {
  h.invoke.mockResolvedValue(report);
  click(S.start);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    "agent_official_readonly_check",
    {
      requestId: expect.any(String),
      agentId: "fixture",
      checkId: "check",
      cwd: "/example",
      model: "model/a",
      reasoningEffort: "high",
    },
  );
  await settle();
  expect(render().some((node) => node.props.children === S.checked)).toBe(true);
});

it("cancels the initiating request and discards a late successful report", async () => {
  let complete!: (value: unknown) => void;
  h.invoke.mockImplementation((command) =>
    command === "agent_official_readonly_check"
      ? new Promise((resolve) => (complete = resolve))
      : Promise.resolve(),
  );
  click(S.start);
  const requestId = h.invoke.mock.calls[0][1].requestId;
  click(S.cancel);
  expect(h.invoke).toHaveBeenLastCalledWith(
    "agent_official_readonly_check_cancel",
    { agentId: "fixture", requestId },
  );
  expect(render().some((node) => node.props.children === S.cancelling)).toBe(
    true,
  );
  complete(report);
  await settle();
  expect(render().some((node) => node.props.children === S.checked)).toBe(
    false,
  );
  expect(render().some((node) => node.props.children === S.cancelled)).toBe(
    true,
  );
});

it("retires the exact request on view exit without surfacing a late report", async () => {
  let complete!: (value: unknown) => void;
  h.invoke.mockImplementation((command) =>
    command === "agent_official_readonly_check"
      ? new Promise((resolve) => (complete = resolve))
      : Promise.resolve(),
  );
  click(S.start);
  const requestId = h.invoke.mock.calls[0][1].requestId;
  h.cleanup?.();
  expect(h.invoke).toHaveBeenLastCalledWith(
    "agent_official_readonly_check_cancel",
    { agentId: "fixture", requestId },
  );
  complete(report);
  await settle();
  expect(render().some((node) => node.props.children === S.checked)).toBe(
    false,
  );
});

it("rejects model drift and only displays bounded error copy", async () => {
  h.invoke.mockResolvedValueOnce({ ...report, model: "other-model" });
  click(S.start);
  await settle();
  expect(render().some((node) => node.props.children === S.outsideScope)).toBe(
    true,
  );
  h.invoke.mockRejectedValueOnce({ code: "timedOut", message: "untrusted" });
  click(S.start);
  await settle();
  expect(render().some((node) => node.props.children === S.timeout)).toBe(true);
  expect(render().some((node) => node.props.children === "untrusted")).toBe(
    false,
  );
});
