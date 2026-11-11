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
import { customAgentDraft } from "../runtime/custom_agent_draft";
import { AGENT_REDESIGN as U } from "../runtime/agent_redesign_strings";
import {
  CustomAgentDialog,
  parseEnvLines,
  parseSecretEntries,
} from "./CustomAgentDialog";
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
  customAgentDraft.clear();
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
      .slice(0, 2)
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

it("keeps all input when closing is cancelled, including environment lines", () => {
  fill();
  const env = render().filter((node) => node.type === "textarea")[1];
  (env.props.onChange as (e: unknown) => void)({
    target: { value: "LOCAL_VALUE=do-not-persist" },
  });
  (render()[0].props.onClose as () => void)();
  expect(onClose).not.toHaveBeenCalled();
  const resume = render().find(
    (node) => node.props.children === U.customContinue,
  )!;
  (resume.props.onClick as () => void)();
  expect(
    render().filter((node) => node.type === "textarea")[1].props.value,
  ).toBe("LOCAL_VALUE=do-not-persist");
  expect(addCustom).not.toHaveBeenCalled();
});

it("retains a custom form only by explicit in-memory choice and restores it on reopening", () => {
  fill();
  (render()[0].props.onClose as () => void)();
  expect(customAgentDraft.read()).toBeNull();
  (
    render().find((node) => node.props.children === U.customKeep)!.props
      .onClick as () => void
  )();
  expect(onClose).toHaveBeenCalledOnce();
  unmount();
  h.slots = [];
  h.effects = [];
  const values = render()
    .filter((node) => node.type === "input")
    .slice(0, 2)
    .map((node) => node.props.value);
  expect(values).toEqual([" My Agent ", "/chosen/agent"]);
  expect(addCustom).not.toHaveBeenCalled();
});

it("discards a retained custom draft only after the explicit discard choice", () => {
  customAgentDraft.keep({
    name: "old",
    command: "/old/program",
    args: "",
    envText: "",
  });
  (render()[0].props.onClose as () => void)();
  expect(customAgentDraft.read()).not.toBeNull();
  (
    render().find((node) => node.props.children === U.customDiscard)!.props
      .onClick as () => void
  )();
  expect(customAgentDraft.read()).toBeNull();
  expect(onClose).toHaveBeenCalledOnce();
});

it("provides a password input for a protected environment value", () => {
  expect(
    render().find(
      (node) => node.type === "input" && node.props.type === "password",
    ),
  ).toBeDefined();
});

function fillSecret(name: string, value: string) {
  (
    render().filter((node) => node.type === "input")[2].props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: name } });
  (
    render().find(
      (node) => node.type === "input" && node.props.type === "password",
    )!.props.onChange as (event: unknown) => void
  )({ target: { value } });
}

it("submits protected values separately and preserves ordinary spaces exactly", async () => {
  addCustom.mockResolvedValue("protected-id");
  fill();
  (
    render().filter((node) => node.type === "textarea")[1].props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: "OPTION=  preserve =  " } });
  fillSecret("UNCLASSIFIED_NAME", "synthetic-secret = exact");
  submit();
  await Promise.resolve();
  expect(addCustom).toHaveBeenCalledExactlyOnceWith({
    name: "My Agent",
    command: "/chosen/agent",
    args: ["--flag", "argument with spaces"],
    env: { OPTION: "  preserve =  " },
    secretEnv: { UNCLASSIFIED_NAME: "synthetic-secret = exact" },
  });
  expect(customAgentDraft.read()).toBeNull();
});

it("rejects a name appearing in both ordinary and protected inputs", () => {
  fill();
  (
    render().filter((node) => node.type === "textarea")[1].props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: "SAME=ordinary" } });
  fillSecret("SAME", "synthetic-secret");
  // Invalid input remains actionable so clicking Add exposes the correction.
  expect(
    render().find((node) => node.props.children === CUSTOM_AGENT.add)!.props
      .disabled,
  ).toBe(false);
  submit();
  expect(addCustom).not.toHaveBeenCalled();
  expect(
    render().some(
      (node) =>
        node.props.role === "alert" &&
        node.props.children === CUSTOM_AGENT.envDuplicate("SAME"),
    ),
  ).toBe(true);
});

it("retains protected values only through the explicit in-memory draft choice", () => {
  fill();
  fillSecret("TOKEN", "synthetic-secret");
  (render()[0].props.onClose as () => void)();
  expect(customAgentDraft.read()).toBeNull();
  (
    render().find((node) => node.props.children === U.customKeep)!.props
      .onClick as () => void
  )();
  unmount();
  h.slots = [];
  h.effects = [];
  expect(
    render().find(
      (node) => node.type === "input" && node.props.type === "password",
    )!.props.value,
  ).toBe("synthetic-secret");
  (render()[0].props.onClose as () => void)();
  (
    render().find((node) => node.props.children === U.customDiscard)!.props
      .onClick as () => void
  )();
  expect(customAgentDraft.read()).toBeNull();
});

it("treats names literally, rejects duplicate protected names and cannot forge a reference through ordinary input", () => {
  expect(parseEnvLines("__proto__=ordinary").env.__proto__).toBe("ordinary");
  expect(parseEnvLines("VALUE=__keychain__").error).toBe(
    CUSTOM_AGENT.envReserved,
  );
  expect(
    parseSecretEntries([{ name: "VALUE", value: "__keychain__" }], {}).env
      .VALUE,
  ).toBe("__keychain__");
  expect(
    parseSecretEntries(
      [
        { name: "A", value: "one" },
        { name: "A", value: "two" },
      ],
      {},
    ).error,
  ).toBe(CUSTOM_AGENT.envDuplicate("A"));
  expect(parseSecretEntries([{ name: "A", value: "" }], {}).error).toBe(
    CUSTOM_AGENT.secretInvalid,
  );
});
