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
  listeners: new Set<() => void>(),
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
    subscribe: (listener: () => void) => {
      h.listeners.add(listener);
      return () => h.listeners.delete(listener);
    },
    inspect: h.inspect,
    retireAddition: h.retire,
    get: h.get,
    confirm: h.confirm,
  },
}));
import { McpAddForm } from "./McpAddForm";
import { McpHttpFields } from "./McpHttpFields";
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
      out.push(
        c,
        ...nodes(
          c.type === McpHttpFields
            ? McpHttpFields(c.props as ComponentProps<typeof McpHttpFields>)
            : (c.props.children as ReactNode),
        ),
      );
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
  h.listeners.clear();
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
it("HTTP mode keeps full query as user input and close clears owned raw references", () => {
  props = { ...props, httpAvailable: true };
  click("添加 MCP…");
  const select = all().find(
    (n) => n.type === "select" && n.props["aria-label"] === "添加方式",
  )!;
  (select.props.onChange as (e: unknown) => void)({
    currentTarget: { value: "streamableHttp" },
  });
  edit(S.name, "http-name");
  edit("HTTP 地址", "https://endpoint.test/mcp?token=SYNTHETIC&x=&x=+");
  submit();
  const target = h.inspect.mock.calls[0][0];
  expect(target.input).toEqual({
    transport: "streamableHttp",
    name: "http-name",
    url: "https://endpoint.test/mcp?token=SYNTHETIC&x=&x=+",
  });
  expect(target.current()).toBe(true);
  click(S.cancelForm);
  expect(target.current()).toBe(false);
  expect(JSON.stringify(h.slots)).not.toContain("SYNTHETIC");
  expect(all().some((n) => n.type === "a")).toBe(false);
});

function transport(value: string) {
  const select = all().find((n) => n.type === "select")!;
  (select.props.onChange as (e: unknown) => void)({ currentTarget: { value } });
  render();
}
function httpDraft() {
  props = { ...props, httpAvailable: true };
  click("添加 MCP…");
  transport("streamableHttp");
  edit(S.name, "http-name");
  edit("HTTP 地址", "https://endpoint.test/?token=SYNTHETIC");
  submit();
  return h.inspect.mock.calls.at(-1)![0];
}
it("transport HTTP-local-HTTP and URL A-B-A each create a new exact input owner", () => {
  const first = httpDraft();
  transport("stdio");
  expect(first.current()).toBe(false);
  expect(JSON.stringify(h.slots)).not.toContain("SYNTHETIC");
  transport("streamableHttp");
  expect(button(S.inspectButton).props.disabled).toBe(true);
  edit("HTTP 地址", first.input.url);
  submit();
  const second = h.inspect.mock.calls.at(-1)![0];
  expect(second.inputId).not.toBe(first.inputId);
  edit("HTTP 地址", "https://different.test/");
  edit("HTTP 地址", first.input.url);
  submit();
  const third = h.inspect.mock.calls.at(-1)![0];
  expect(second.current()).toBe(false);
  expect(third.inputId).not.toBe(second.inputId);
});
it("closing the review after dispatch synchronously clears the HTTP form even while safe status remains", () => {
  const target = httpDraft();
  h.get.mockReturnValue({
    request: {
      action: "add",
      target: { kind: "mcpAddition", inputId: target.inputId },
    },
    additionInput: null,
    unresolved: true,
  });
  for (const listener of h.listeners) listener();
  expect(target.current()).toBe(false);
  expect(JSON.stringify(h.slots)).not.toContain("SYNTHETIC");
  expect(
    all().some(
      (n) => n.type === "input" && n.props["aria-label"] === "HTTP 地址",
    ),
  ).toBe(false);
});
it("owner replacement clears the old URL without letting its late callbacks consume the replacement draft", () => {
  const first = httpDraft();
  const late = all().find((n) => n.type === "form")!.props.onSubmit as (
    e: unknown,
  ) => void;
  const owner = { ...props.owner, token: {} };
  props = { ...props, owner, result: { ...props.result, owner } };
  render();
  render();
  expect(JSON.stringify(h.slots)).not.toContain("SYNTHETIC");
  expect(first.current()).toBe(false);
  click("添加 MCP…");
  transport("streamableHttp");
  edit(S.name, "other");
  edit("HTTP 地址", "https://other.test/");
  late({ preventDefault() {} });
  expect(h.inspect).toHaveBeenCalledOnce();
  submit();
  expect(h.inspect.mock.calls.at(-1)![0].current()).toBe(true);
});
it("an HTTP-only capability offers no local transport and does not begin inspection by opening the form", () => {
  props = { ...props, httpAvailable: true, stdioAvailable: false };
  click("添加 MCP…");
  expect(
    all()
      .filter((n) => n.type === "option")
      .map((n) => n.props.value),
  ).toEqual(["streamableHttp"]);
  expect(
    all().some(
      (n) => n.type === "input" && n.props["aria-label"] === "HTTP 地址",
    ),
  ).toBe(true);
  expect(h.inspect).not.toHaveBeenCalled();
});
