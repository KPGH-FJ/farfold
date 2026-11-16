import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  cleanups: [] as (() => void)[],
  getController: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (compute: () => unknown) => compute(),
  useRef: (value: unknown) =>
    (hooks.values[hooks.cursor++] ??= { current: value }),
  useState: (initial: () => unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.values)) hooks.values[i] = initial();
    return [
      hooks.values[i],
      (next: unknown) => {
        hooks.values[i] =
          typeof next === "function" ? next(hooks.values[i]) : next;
      },
    ];
  },
  useEffect: (fn: () => void | (() => void)) => {
    const cleanup = fn();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("../runtime/session_tool_change_controller", async (original) => ({
  ...(await original<
    typeof import("../runtime/session_tool_change_controller")
  >()),
  getSessionToolChangeController: hooks.getController,
}));
import { SessionToolManagement } from "./SessionToolManagement";
import { McpHttpFields } from "./McpHttpFields";
import { SESSION_TOOL_CHANGE_STRINGS as S } from "../runtime/session_tool_change_strings";
import {
  changeFixture,
  changeInput,
  changed,
  managedItem,
  changeOperation,
  inspected,
} from "../runtime/session_tool_change.test-support";
import { flush } from "../runtime/session_tools.test-support";

let h: ReturnType<typeof changeFixture>,
  props: ComponentProps<typeof SessionToolManagement>;
function render() {
  hooks.cursor = 0;
  return SessionToolManagement(props);
}
function walk(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    out.push(
      child,
      ...walk(
        child.type === McpHttpFields
          ? McpHttpFields(child.props as ComponentProps<typeof McpHttpFields>)
          : (child.props.children as ReactNode),
      ),
    );
  });
  return out;
}
function button(label: string) {
  return walk(render()).find(
    (node) =>
      node.type === "button" &&
      (node.props.children === label || node.props["aria-label"] === label),
  )!;
}
const click = (label: string) => {
  (button(label).props.onClick as () => void)();
};
function edit(label: string, value: string) {
  const input = walk(render()).find(
    (node) => node.type === "input" && node.props["aria-label"] === label,
  )!;
  (input.props.onChange as (e: unknown) => void)({ currentTarget: { value } });
}
function review() {
  click(S.add);
  edit(S.name, changeInput.name);
  edit(S.address, changeInput.url);
  const form = walk(render()).find((node) => node.type === "form")!;
  (form.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
}
beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
  hooks.cleanups = [];
  h = changeFixture();
  hooks.getController.mockReturnValue(h.controller);
  props = { thread: h.owner, active: true, readPending: false };
});
afterEach(() => hooks.cleanups.forEach((cleanup) => cleanup()));
it("shows exact input for a second explicit confirmation, with no request during editing or review", async () => {
  review();
  expect(h.port.start).not.toHaveBeenCalled();
  expect(
    walk(render()).some(
      (node) => node.type === "code" && node.props.children === changeInput.url,
    ),
  ).toBe(true);
  click(S.confirmAdd);
  await flush();
  expect(h.port.start).toHaveBeenCalledExactlyOnceWith(
    h.request(),
    changeInput,
  );
  expect(JSON.stringify(hooks.values)).not.toContain(changeInput.url);
  expect(button(S.checking).props.disabled).not.toBe(true);
  expect(button(S.checking).props["aria-disabled"]).toBe(true);
  h.start.resolve(changed(h.request()));
  await flush();
  expect(button(S.list).props.disabled).not.toBe(true);
  expect(button(`${S.withdraw} ${managedItem.name}`)).toBeDefined();
});
it("invalidates a retained confirmation after returning to edit, even when input is changed back", async () => {
  review();
  const oldConfirm = button(S.confirmAdd).props.onClick as () => void;
  click(S.cancelReview);
  edit(S.address, "https://other.example.test");
  edit(S.address, changeInput.url);
  oldConfirm();
  await flush();
  expect(h.port.start).not.toHaveBeenCalled();
});
it("checks availability again for stale controls after a tab switch, other work, or read operation", async () => {
  for (const apply of [
    () => {
      props.active = false;
    },
    () => {
      h.owner.running = true;
    },
    () => {
      props.readPending = true;
    },
  ]) {
    review();
    const confirm = button(S.confirmAdd).props.onClick as () => void;
    apply();
    render();
    confirm();
    await flush();
    expect(h.port.start).not.toHaveBeenCalled();
    props.active = true;
    h.owner.running = false;
    props.readPending = false;
    click(S.cancelReview);
    click(S.closeForm);
  }
});
it("unmounting an admitted change does not cancel it and reopening exposes the same check and owned item", async () => {
  review();
  click(S.confirmAdd);
  await flush();
  h.start.resolve(changeOperation(h.request()));
  await flush();
  hooks.cleanups.forEach((cleanup) => cleanup());
  hooks.values = [];
  hooks.cleanups = [];
  expect(h.owner.configuring).toBe(true);
  click(S.check);
  await flush();
  expect(h.port.status).toHaveBeenCalledExactlyOnceWith(h.request());
  expect(h.port.start).toHaveBeenCalledOnce();
  h.status.resolve(changed(h.request()));
  await flush();
  click(`${S.withdraw} ${managedItem.name}`);
  expect(button(S.confirmRemove)).toBeDefined();
  expect(h.port.start).toHaveBeenCalledOnce();
});
it("never offers an empty current list as a withdrawal success", async () => {
  click(S.list);
  await flush();
  h.start.resolve(inspected(h.request(), []));
  await flush();
  const texts = walk(render()).map((node) => node.props.children);
  expect(texts).toContain(S.empty);
  expect(texts).not.toContain(S.removed);
});

it.each([
  "changed",
  "busy",
  "unavailable",
  "invalidResponse",
  "queryFailed",
] as const)(
  "shows the %s reason after inspection admission fails, without offering a nonexistent operation check",
  async (code) => {
    click(S.list);
    await flush();
    h.start.reject({
      code,
      message: "PRIVATE backend diagnostic",
      notDispatched: true,
    });
    await flush();
    const status = walk(render()).find((node) => node.props.role === "status")!;
    expect(status.props.children).toBe(S.errors[code]);
    expect(JSON.stringify(status.props.children)).not.toContain("PRIVATE");
    expect(status.props.children).not.toMatch(
      /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter/i,
    );
    expect(button(S.checkInspection)).toBeUndefined();
    expect(button(S.list).props["aria-disabled"]).not.toBe(true);
    expect(h.controller.check()).toBe(false);
    expect(h.port.status).not.toHaveBeenCalled();
  },
);

it("shows a read failure reason and status-only guidance when its dispatch is still unresolved", async () => {
  click(S.list);
  await flush();
  h.start.reject({ code: "queryFailed", message: "PRIVATE" });
  await flush();
  const status = walk(render()).find((node) => node.props.role === "status")!;
  expect(status.props.children).toContain(S.errors.queryFailed);
  expect(status.props.children).toContain(S.inspectPending);
  expect(h.owner.configuring).toBe(false);
  expect(h.owner.sessionToolRecoveryRequired).not.toBe(true);
  click(S.checkInspection);
  await flush();
  expect(h.port.status).toHaveBeenCalledExactlyOnceWith(h.request());
  expect(h.port.start).toHaveBeenCalledOnce();
});
