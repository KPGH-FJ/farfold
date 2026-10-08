import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentsState } from "../runtime/agents";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; cleanup?: () => void }[],
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = next;
      },
    ];
  },
  useRef: (value: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: value } }).value,
  useEffect: (setup: () => () => void) => {
    const i = h.cursor++;
    if (!h.slots[i]) {
      const slot: (typeof h.slots)[number] = (h.slots[i] = {});
      h.effects.push(() => {
        slot.cleanup = setup();
      });
    }
  },
}));
import { CustomAgentDialog } from "./CustomAgentDialog";
import { CUSTOM_AGENT } from "../runtime/custom_agent_strings";
type Element = ReactElement<Record<string, unknown>>;
const addCustom = vi.fn(),
  onClose = vi.fn(),
  onAdded = vi.fn();
let agents: AgentsState;
function render() {
  h.cursor = 0;
  const tree = CustomAgentDialog({ agents, onClose, onAdded });
  const result: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (isValidElement<Record<string, unknown>>(child)) {
        result.push(child);
        visit(child.props.children as ReactNode);
      }
    });
  visit(tree);
  for (const effect of h.effects.splice(0)) effect();
  return result;
}
function fill(command = "/chosen/agent") {
  const fields = render().filter(
    (node) => node.type === "input" || node.type === "textarea",
  );
  [" My Agent ", command, "--flag\nargument with spaces\n"].forEach(
    (value, i) =>
      (fields[i].props.onChange as (e: unknown) => void)({ target: { value } }),
  );
}
function submit() {
  (
    render().find((node) => node.type === "form")!.props.onSubmit as (
      e: unknown,
    ) => void
  )({ preventDefault: vi.fn() });
}
function unmount() {
  for (const slot of h.slots) slot.cleanup?.();
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  addCustom.mockReset();
  onClose.mockClear();
  onAdded.mockClear();
  agents = { addCustom, errors: {} } as unknown as AgentsState;
});
afterEach(unmount);

it("submits the user's explicit command and argument lines once, and blocks closing while saving", async () => {
  let finish!: (id: string) => void;
  addCustom.mockReturnValue(
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
  );
  fill(" /chosen/agent ");
  submit();
  submit();
  expect(addCustom).toHaveBeenCalledExactlyOnceWith({
    name: "My Agent",
    command: "/chosen/agent",
    args: ["--flag", "argument with spaces"],
    env: {},
  });
  (render()[0].props.onClose as () => void)();
  expect(onClose).not.toHaveBeenCalled();
  finish("added-id");
  await Promise.resolve();
  expect(onAdded).toHaveBeenCalledExactlyOnceWith("added-id");
});

it("retains user input and permits retry when adding fails", async () => {
  addCustom.mockResolvedValueOnce(null).mockResolvedValueOnce("retry-id");
  fill();
  submit();
  agents.errors.__custom = "Could not save";
  await Promise.resolve();
  const view = render();
  expect(view.find((node) => node.props.role === "alert")?.props.children).toBe(
    "Could not save",
  );
  expect(
    view
      .filter((node) => node.type === "input")
      .map((node) => node.props.value),
  ).toEqual([" My Agent ", "/chosen/agent"]);
  expect(onAdded).not.toHaveBeenCalled();
  submit();
  await Promise.resolve();
  expect(onAdded).toHaveBeenCalledExactlyOnceWith("retry-id");
});

it("catches an unexpected rejected add request and re-enables the form", async () => {
  addCustom.mockRejectedValue(new Error("write failed"));
  fill();
  submit();
  await Promise.resolve();
  const view = render();
  expect(view.find((node) => node.props.role === "alert")).toBeDefined();
  expect(
    view.find((node) => node.props.children === CUSTOM_AGENT.add)?.props
      .disabled,
  ).toBe(false);
  expect(onAdded).not.toHaveBeenCalled();
});

it("does not navigate a replacement screen after an unmounted dialog's request completes", async () => {
  let finish!: (id: string) => void;
  addCustom.mockReturnValue(
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
  );
  fill();
  submit();
  unmount();
  finish("late-id");
  await Promise.resolve();
  expect(onAdded).not.toHaveBeenCalled();
});

it("does not submit a multiline command", () => {
  fill("/chosen/agent\nsecond command");
  submit();
  expect(addCustom).not.toHaveBeenCalled();
});

it("passes environment pairs to the registration request", async () => {
  addCustom.mockResolvedValue("env-id");
  fill();
  const env = render().filter((node) => node.type === "textarea")[1];
  (env.props.onChange as (e: unknown) => void)({
    target: { value: "TOKEN_VALUE=abc\n EMPTY=\n" },
  });
  submit();
  await Promise.resolve();
  expect(addCustom).toHaveBeenCalledExactlyOnceWith({
    name: "My Agent",
    command: "/chosen/agent",
    args: ["--flag", "argument with spaces"],
    env: { TOKEN_VALUE: "abc", EMPTY: "" },
  });
  expect(onAdded).toHaveBeenCalledExactlyOnceWith("env-id");
});

it.each(["TOKEN", "1BAD=value", "BAD-NAME=value", "A=1\nA=2"])(
  "rejects invalid environment input: %s",
  (envText) => {
    fill();
    const env = render().filter((node) => node.type === "textarea")[1];
    (env.props.onChange as (e: unknown) => void)({
      target: { value: envText },
    });
    submit();
    expect(addCustom).not.toHaveBeenCalled();
    const view = render();
    expect(view.some((node) => node.props.role === "alert")).toBe(true);
  },
);
