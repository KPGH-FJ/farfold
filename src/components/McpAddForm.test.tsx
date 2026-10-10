import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
  type ComponentProps,
} from "react";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as {
    value?: unknown;
    cleanup?: () => void;
    deps?: readonly unknown[];
  }[],
  inspect: vi.fn(),
  retire: vi.fn(),
  get: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: value } }).value,
  useState: (value: unknown) => {
    const s = (h.slots[h.cursor++] ??= { value });
    return [
      s.value,
      (v: unknown) => {
        s.value = typeof v === "function" ? v(s.value) : v;
      },
    ];
  },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => {
    const i = h.cursor++,
      old = h.slots[i];
    if (!old || deps.some((x, n) => !Object.is(x, old.deps?.[n]))) {
      old?.cleanup?.();
      h.slots[i] = { deps, cleanup: fn() || undefined };
    }
  },
}));
vi.mock("../runtime/skill_management_controller", () => ({
  skillManagement: {
    inspect: h.inspect,
    retireAddition: h.retire,
    get: h.get,
    confirm: h.confirm,
  },
}));
import { McpAddForm } from "./McpAddForm";
import { MCP_ADD_STRINGS as S } from "../runtime/mcp_add_strings";
import { id, snapshot } from "../runtime/mcp_management.test-support";
let props: ComponentProps<typeof McpAddForm>;
function render() {
  h.cursor = 0;
  return McpAddForm(props);
}
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (c) => {
    if (isValidElement<Record<string, unknown>>(c))
      out.push(c, ...nodes(c.props.children as ReactNode));
  });
  return out;
}
const all = () => nodes(render());
const button = (label: string) =>
  all().find(
    (n) =>
      n.type === "button" &&
      (n.props.children === label || n.props["aria-label"] === label),
  )!;
const click = (label: string) => (button(label).props.onClick as () => void)();
function edit(label: string, value: string) {
  const n = all().find(
    (n) => n.type === "input" && n.props["aria-label"] === label,
  )!;
  (n.props.onChange as (e: unknown) => void)({ currentTarget: { value } });
  render();
}
const submit = () => {
  const e = { preventDefault: vi.fn() };
  (
    all().find((n) => n.type === "form")!.props.onSubmit as (e: unknown) => void
  )(e);
  expect(e.preventDefault).toHaveBeenCalledOnce();
};
function text() {
  return all()
    .map((n) => (typeof n.props.children === "string" ? n.props.children : ""))
    .join(" ");
}
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  h.inspect.mockReset().mockReturnValue(true);
  h.retire.mockReset();
  h.get.mockReset().mockReturnValue({ request: null });
  h.confirm.mockReset();
  const owner = { agentId: "form-test", token: {}, current: () => true };
  const result = {
    owner,
    cwd: "/controlled",
    stale: false,
    request: {
      agentId: owner.agentId,
      requestId: id,
      kind: "mcp" as const,
      cwd: "/controlled",
    },
    snapshot,
  };
  props = {
    owner,
    result,
    enabled: true,
    current: () => true,
    changed: vi.fn(),
  };
});
afterEach(() => h.slots.forEach((s) => s.cleanup?.()));
it("first editing does not claim a nonexistent earlier review was invalidated", () => {
  click(S.open);
  edit(S.name, "new-name");
  edit(S.executable, "/local program/run");
  expect(text()).not.toContain(S.invalidated);
  expect(h.inspect).not.toHaveBeenCalled();
});
it("form submission only inspects exact indexed argv, never confirms or shell-splits", () => {
  click(S.open);
  edit(S.name, "new-name");
  edit(S.executable, "/local program/run");
  click(S.addArgument);
  click(S.addArgument);
  edit("参数 2", "a b 'quoted' \\ rest");
  submit();
  expect(h.inspect).toHaveBeenCalledOnce();
  const target = h.inspect.mock.calls[0][0];
  expect(target.input).toEqual({
    name: "new-name",
    executablePath: "/local program/run",
    args: ["", "a b 'quoted' \\ rest"],
  });
  expect(h.confirm).not.toHaveBeenCalled();
  expect(button(S.inspectButton).props.type).toBe("submit");
});
it("editing A-B-A invalidates the exact old input owner and uses a new inputId", () => {
  click(S.open);
  edit(S.name, "new-name");
  edit(S.executable, "/local/run");
  submit();
  const target = h.inspect.mock.calls[0][0];
  expect(target.current()).toBe(true);
  h.get.mockReturnValue({
    request: {
      action: "inspect",
      target: { kind: "mcpAddition", inputId: target.inputId },
    },
  });
  edit(S.name, "different");
  edit(S.name, "new-name");
  expect(target.current()).toBe(false);
  expect(text()).toContain(S.invalidated);
  submit();
  expect(h.inspect.mock.calls[1][0].inputId).not.toBe(target.inputId);
  expect(h.retire).toHaveBeenCalledWith(props.owner, target.inputId);
});
it("closed form or late callback from another selection cannot inspect or revive permission", () => {
  click(S.open);
  edit(S.name, "new-name");
  edit(S.executable, "/local/run");
  const oldSubmit = all().find((n) => n.type === "form")!.props.onSubmit as (
    e: unknown,
  ) => void;
  submit();
  const target = h.inspect.mock.calls[0][0];
  click(S.cancelForm);
  oldSubmit({ preventDefault: () => {} });
  expect(h.inspect).toHaveBeenCalledOnce();
  expect(target.current()).toBe(false);
  click(S.open);
  expect(button(S.inspectButton).props.disabled).toBe(true);
  props = { ...props, current: () => false };
  oldSubmit({ preventDefault: () => {} });
  expect(h.inspect).toHaveBeenCalledOnce();
});
