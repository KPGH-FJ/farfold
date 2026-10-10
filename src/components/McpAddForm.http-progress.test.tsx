import { afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
  type ComponentProps,
} from "react";
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  }[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) =>
    (hooks.slots[hooks.cursor++] ??= { value: { current: value } }).value,
  useState: (value: unknown) => {
    const slot = (hooks.slots[hooks.cursor++] ??= { value });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => {
    const i = hooks.cursor++,
      old = hooks.slots[i];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps?.[n]))) {
      old?.cleanup?.();
      hooks.slots[i] = { deps, cleanup: fn() || undefined };
    }
  },
}));
import { McpAddForm } from "./McpAddForm";
import { skillManagement } from "../runtime/skill_management_controller";
import { setup, operation, written } from "../runtime/mcp_add.test-support";
import { flush } from "../runtime/extension_inventory.test-support";
let props: ComponentProps<typeof McpAddForm>;
function render() {
  hooks.cursor = 0;
  return McpAddForm(props);
}
function walk(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (c) => {
    if (isValidElement<Record<string, unknown>>(c))
      out.push(c, ...walk(c.props.children as ReactNode));
  });
  return out;
}
function click(label: string) {
  const button = walk(render()).find(
    (n) => n.type === "button" && n.props.children === label,
  )!;
  (button.props.onClick as () => void)();
  render();
}
function edit(label: string, value: string) {
  const input = walk(render()).find(
    (n) => n.type === "input" && n.props["aria-label"] === label,
  )!;
  (input.props.onChange as (e: unknown) => void)({ currentTarget: { value } });
  render();
}
afterEach(() => {
  hooks.slots.forEach((s) => s.cleanup?.());
  hooks.slots = [];
  vi.restoreAllMocks();
});
it.each(["complete", "close"])(
  "own write progress clears only raw form data; %s still owns the admitted operation",
  async (next) => {
    const h = await setup();
    for (const key of [
      "subscribe",
      "get",
      "inspect",
      "retireAddition",
    ] as const)
      vi.spyOn(skillManagement, key).mockImplementation(
        h.controller[key].bind(h.controller) as never,
      );
    props = {
      owner: h.owner,
      result: h.result,
      httpAvailable: true,
      stdioAvailable: false,
      enabled: true,
      current: () => h.inventory.isCurrentResult(h.owner, props.result),
      changed: () => h.inventory.markStale(h.result),
    };
    click("添加 MCP…");
    edit("MCP 名称", "new-http");
    edit("HTTP 地址", "https://endpoint.test/?token=PROGRESS_CANARY");
    (
      walk(render()).find((n) => n.type === "form")!.props.onSubmit as (
        e: unknown,
      ) => void
    )({ preventDefault() {} });
    await flush();
    const inspecting = h.controller.get(h.owner.agentId).request!;
    const inspected = operation(inspecting, true);
    h.pending.inspect.resolve({
      ...inspected,
      review: { ...inspected.review, mutation: "addDisabledHttpMcp" },
    });
    await flush();
    h.controller.confirm(h.owner, h.controller.get(h.owner.agentId).review!);
    await flush();
    const writing = h.controller.get(h.owner.agentId).request!;
    h.pending.confirm.resolve({
      ...written(writing),
      state: "running",
      phase: "checking",
      settled: false,
      outcome: null,
      observation: null,
    });
    await flush();
    const stale = h.inventory.get(h.owner.agentId).results.mcp!;
    expect(stale).not.toBe(h.result);
    expect(stale.stale).toBe(true);
    props = { ...props, result: stale, enabled: false };
    render();
    render();
    await flush();
    expect(h.port.cancel).not.toHaveBeenCalledWith({
      agentId: writing.agentId,
      requestId: writing.requestId,
    });
    expect(h.controller.get(h.owner.agentId).additionInput).toBeNull();
    expect(JSON.stringify(hooks.slots)).not.toContain("PROGRESS_CANARY");
    expect(h.controller.get(h.owner.agentId).unresolved).toBe(true);
    if (next === "close") {
      h.controller.retire(h.owner);
      await flush();
      expect(h.port.cancel).toHaveBeenCalledWith({
        agentId: writing.agentId,
        requestId: writing.requestId,
      });
      h.pending.cancel.resolve({
        agentId: writing.agentId,
        requestId: writing.requestId,
        cancelRequested: true,
        operation: {
          ...written(writing),
          state: "failed",
          code: "cancelled",
          outcome: "unknown",
          observation: null,
        },
      });
      await flush();
      expect(h.controller.get(h.owner.agentId).operation?.outcome).toBe(
        "unknown",
      );
      return;
    }
    h.controller.check(writing.agentId, writing.requestId);
    await flush();
    h.pending.status.resolve(written(writing));
    await flush();
    expect(h.controller.get(h.owner.agentId).operation?.outcome).toBe(
      "verified",
    );
  },
);
