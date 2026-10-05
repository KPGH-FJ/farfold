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
  invoke: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = initial;
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

import { ManualAuthSection } from "./ManualAuthSection";
import { STRINGS } from "../runtime/strings";
import { PREPARATION_STRINGS } from "../runtime/preparation_strings";

type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof ManualAuthSection>;
const release = vi.fn();
function render() {
  h.cursor = 0;
  const result: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      result.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(ManualAuthSection(props));
  for (const effect of h.pending.splice(0)) effect();
  return result;
}
async function settled() {
  let nodes: Element[] = [];
  for (let round = 0; round < 5; round++) {
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
function click(node: Element) {
  (node.props.onClick as () => void)();
}
function fill(nodes: Element[], type: "input" | "textarea", value: string) {
  const field = nodes.find((node) => node.type === type)!;
  (field.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
}
async function expanded() {
  const nodes = await settled();
  click(button(nodes, STRINGS.repair.manualAuth));
  return settled();
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.invoke.mockReset().mockResolvedValue(null);
  release.mockClear();
  props = {
    agentId: "manual-agent",
    methodId: "official-method",
    declaredEnv: "DECLARED_KEY_NAME",
    onAcquire: vi.fn(() => release),
    onInvalidate: vi.fn(),
    onRun: vi.fn(),
  };
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
});

it("reads an old environment-only record and asks for a command without exposing a key input", async () => {
  h.invoke.mockResolvedValueOnce({
    command: "",
    args: [],
    envName: "LEGACY_KEY_NAME",
  });
  const nodes = await expanded();
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("auth_manual_get", {
    agentId: props.agentId,
    methodId: props.methodId,
  });
  expect(nodes.filter((node) => node.type === "input")).toHaveLength(1);
  expect(
    nodes.some((node) => node.props.children === STRINGS.repair.envName),
  ).toBe(false);
  expect(
    nodes.find((node) => node.props.role === "status")?.props.children,
  ).toBe(STRINGS.repair.executableRequired);
  const save = button(nodes, STRINGS.repair.save);
  const run = button(nodes, STRINGS.repair.run);
  expect(save.props.disabled).toBe(true);
  expect(run.props.disabled).toBe(true);
  click(save);
  click(run);
  expect(props.onAcquire).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("does not save a new blank command even when the method declares an environment name", async () => {
  let nodes = await expanded();
  fill(nodes, "input", "   ");
  nodes = render();
  click(button(nodes, STRINGS.repair.save));
  expect(props.onAcquire).not.toHaveBeenCalled();
  expect(props.onInvalidate).not.toHaveBeenCalled();
  expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
    "auth_manual_get",
  ]);
});

it("repairs an old record with the explicit command and arguments while preserving its environment metadata", async () => {
  h.invoke.mockResolvedValueOnce({
    command: "",
    args: [],
    envName: "LEGACY_KEY_NAME",
  });
  let nodes = await expanded();
  fill(nodes, "input", " /chosen/login-program ");
  fill(nodes, "textarea", "login\nargument with spaces\n\n--flag");
  nodes = render();
  click(button(nodes, STRINGS.repair.save));
  nodes = await settled();
  expect(h.invoke).toHaveBeenLastCalledWith("auth_manual_set", {
    agentId: props.agentId,
    methodId: props.methodId,
    config: {
      command: "/chosen/login-program",
      args: ["login", "argument with spaces", "--flag"],
      envName: "LEGACY_KEY_NAME",
    },
  });
  expect(release).toHaveBeenCalledOnce();
  expect(
    nodes.find((node) => node.props.role === "status")?.props.children,
  ).toBe(STRINGS.repair.manualSaved);
  const run = button(nodes, STRINGS.repair.run);
  expect(run.props.disabled).toBe(false);
  click(run);
  expect(props.onRun).toHaveBeenCalledOnce();
  expect(h.invoke).toHaveBeenCalledTimes(2);
});

it("waits for the saved record before allowing an edit to overwrite hidden metadata", async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let nodes = await expanded();
  expect(nodes.find((node) => node.type === "input")!.props.disabled).toBe(
    true,
  );
  click(button(nodes, STRINGS.repair.save));
  expect(props.onAcquire).not.toHaveBeenCalled();
  finish({
    command: "/chosen/original-login",
    args: ["login"],
    envName: "SAVED_KEY_NAME",
  });
  nodes = await settled();
  expect(nodes.find((node) => node.type === "input")!.props.value).toBe(
    "/chosen/original-login",
  );
  click(button(nodes, STRINGS.repair.run));
  expect(props.onRun).toHaveBeenCalledOnce();
  expect(h.invoke).toHaveBeenCalledTimes(1);
  fill(nodes, "textarea", "login\n--again");
  click(button(render(), STRINGS.repair.save));
  await settled();
  expect(h.invoke).toHaveBeenLastCalledWith("auth_manual_set", {
    agentId: props.agentId,
    methodId: props.methodId,
    config: {
      command: "/chosen/original-login",
      args: ["login", "--again"],
      envName: "SAVED_KEY_NAME",
    },
  });
});

it("retries a failed configuration read without starting authentication or overwriting the saved record", async () => {
  const record = {
    command: "/chosen/saved-login",
    args: ["login"],
    envName: "SAVED_KEY_NAME",
  };
  h.invoke
    .mockRejectedValueOnce(new Error("configuration read failed"))
    .mockResolvedValueOnce(record);
  let nodes = await expanded();
  expect(button(nodes, STRINGS.repair.save).props.disabled).toBe(true);
  expect(button(nodes, STRINGS.repair.run).props.disabled).toBe(true);
  click(button(nodes, STRINGS.repair.save));
  click(button(nodes, STRINGS.repair.run));
  click(button(nodes, PREPARATION_STRINGS.retry));
  nodes = await settled();
  expect(h.invoke.mock.calls).toEqual([
    ["auth_manual_get", { agentId: props.agentId, methodId: props.methodId }],
    ["auth_manual_get", { agentId: props.agentId, methodId: props.methodId }],
  ]);
  expect(props.onAcquire).not.toHaveBeenCalled();
  expect(props.onInvalidate).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
  expect(nodes.find((node) => node.type === "input")!.props.value).toBe(
    record.command,
  );
  expect(button(nodes, STRINGS.repair.run).props.disabled).toBe(false);
  expect(
    nodes.some((node) => node.props.children === PREPARATION_STRINGS.retry),
  ).toBe(false);
  fill(nodes, "textarea", "login\n--again");
  click(button(render(), STRINGS.repair.save));
  await settled();
  expect(h.invoke).toHaveBeenLastCalledWith("auth_manual_set", {
    agentId: props.agentId,
    methodId: props.methodId,
    config: { ...record, args: ["login", "--again"] },
  });
});

it.each(["input", "textarea"] as const)(
  "requires unsaved %s changes to be saved before running the login callback",
  async (field) => {
    const record = {
      command: "/chosen/saved-login",
      args: ["login"],
      envName: "SAVED_KEY_NAME",
    };
    h.invoke.mockResolvedValueOnce(record);
    let nodes = await expanded();
    expect(button(nodes, STRINGS.repair.run).props.disabled).toBe(false);
    fill(
      nodes,
      field,
      field === "input" ? "/chosen/edited-login" : "login\n--edited",
    );
    nodes = render();
    const run = button(nodes, STRINGS.repair.run);
    expect(run.props.disabled).toBe(true);
    click(run);
    expect(props.onRun).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    click(button(nodes, STRINGS.repair.save));
    nodes = await settled();
    expect(h.invoke).toHaveBeenLastCalledWith("auth_manual_set", {
      agentId: props.agentId,
      methodId: props.methodId,
      config: {
        ...record,
        command: field === "input" ? "/chosen/edited-login" : record.command,
        args: field === "textarea" ? ["login", "--edited"] : record.args,
      },
    });
    expect(button(nodes, STRINGS.repair.run).props.disabled).toBe(false);
    click(button(nodes, STRINGS.repair.run));
    expect(props.onRun).toHaveBeenCalledOnce();
  },
);
