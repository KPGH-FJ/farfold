import { Children, isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginManagementPort } from "../runtime/plugin_management";
const h = vi.hoisted(() => ({
  cursor: 0,
  group: "catalog",
  frames: new Map<
    string,
    { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }[]
  >(),
  effects: [] as (() => void)[],
  port: {
    sources: vi.fn<PluginManagementPort["sources"]>(),
    inventory: vi.fn<PluginManagementPort["inventory"]>(),
    inspect: vi.fn<PluginManagementPort["inspect"]>(),
    confirm: vi.fn<PluginManagementPort["confirm"]>(),
    status: vi.fn<PluginManagementPort["status"]>(),
    cancel: vi.fn<PluginManagementPort["cancel"]>(),
    recheck: vi.fn<PluginManagementPort["recheck"]>(),
  },
}));
vi.mock("react", async (original) => {
  const slots = () => {
    if (!h.frames.has(h.group)) h.frames.set(h.group, []);
    return h.frames.get(h.group)!;
  };
  return {
    ...(await original<typeof import("react")>()),
    useState(initial: unknown) {
      const slot = (slots()[h.cursor++] ??= { value: initial });
      return [
        slot.value,
        (next: unknown) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
        },
      ];
    },
    useRef(initial: unknown) {
      return (slots()[h.cursor++] ??= { value: { current: initial } }).value;
    },
    useMemo(fn: () => unknown, deps: readonly unknown[]) {
      const i = h.cursor++,
        old = slots()[i];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps?.[n])))
        slots()[i] = { value: fn(), deps };
      return slots()[i].value;
    },
    useEffect(fn: () => void | (() => void), deps: readonly unknown[]) {
      const i = h.cursor++,
        old = slots()[i];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps?.[n]))) {
        const slot = { deps, cleanup: old?.cleanup };
        slots()[i] = slot;
        h.effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = fn() || undefined;
        });
      }
    },
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  };
});
vi.mock("../runtime/plugin_management_controller", async (original) => {
  const module =
    await original<typeof import("../runtime/plugin_management_controller")>();
  return {
    ...module,
    pluginManagement: new module.PluginManagementController(h.port, 1000),
  };
});
import { AgentExtensionPlugins } from "./AgentExtensionPlugins";
import { AgentExtensionPluginChange } from "./AgentExtensionPluginChange";
import { pluginManagement } from "../runtime/plugin_management_controller";
import { PLUGIN_MANAGEMENT_STRINGS as S } from "../runtime/plugin_management_strings";
import {
  pluginItem,
  pluginOperation,
  pluginTicket,
} from "../runtime/plugin_management.test-support";
import { deferred, flush } from "../runtime/extension_inventory.test-support";
import type {
  PluginItem,
  PluginOperation,
  PluginRequest,
} from "../runtime/plugin_management_types";

type Element = { type: unknown; props: Record<string, unknown> };
let n = 0,
  live: boolean;
let props: Parameters<typeof AgentExtensionPlugins>[0];
let item: PluginItem;
function nodes(node: ReactNode): Element[] {
  const out: Element[] = [];
  Children.forEach(node, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      out.push(child, ...nodes(child.props.children as ReactNode));
  });
  return out;
}
// Controlled hook commits, real production components and real controller.
// The transport is a bounded in-memory peer; no browser, native command or Agent.
function render(change = false): Element[] {
  h.group = change ? "change" : "catalog";
  h.cursor = 0;
  const tree = nodes(
    change
      ? AgentExtensionPluginChange({
          owner: props.owner,
          active: props.enabled,
        })
      : AgentExtensionPlugins(props),
  );
  const effects = h.effects.splice(0);
  if (effects.length) {
    effects.forEach((fn) => fn());
    return render(change);
  }
  return tree;
}
function button(label: string, change = false) {
  return render(change).find(
    (node) => node.type === "button" && node.props.children === label,
  );
}
function click(label: string, change = false) {
  const target = button(label, change);
  expect(target, label).toBeDefined();
  expect(target!.props.disabled).toBeFalsy();
  (target!.props.onClick as () => void)();
}
function select(label: string, value: string) {
  const target = render().find(
    (node) => node.type === "select" && node.props["aria-label"] === label,
  )!;
  expect(target.props.disabled).toBeFalsy();
  (target.props.onChange as (event: unknown) => void)({
    currentTarget: { value },
  });
  render();
}
const text = (change = false) =>
  render(change)
    .flatMap((node) =>
      Children.toArray(node.props.children as ReactNode).filter(
        (child) => typeof child === "string" || typeof child === "number",
      ),
    )
    .join(" ");
const request = () => pluginManagement.get(props.owner.agentId).request!;
async function query() {
  click(
    pluginManagement.get(props.owner.agentId).sourceResult
      ? S.queryAgain
      : S.query,
  );
  await flush();
  render();
  select(S.querySource, "0");
  click(S.querySelectedSource);
  await flush();
  render();
}
function choose() {
  select(S.package, String(item.id));
}
async function inspect() {
  choose();
  click(item.reportedInstalled ? S.reviewRemove : S.reviewInstall);
  await flush();
  render();
}
function written(request: PluginRequest): PluginOperation {
  return {
    ...pluginOperation(request, true),
    writeDispatched: true,
    writeAck: "ok",
    outcome: "verified",
    observation: {
      observedAtMs: Date.now(),
      reportedInstalled: request.install!,
      reportedEnabled: false,
      sessionApplicability: "unverified",
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  h.cursor = 0;
  h.frames.clear();
  h.effects = [];
  live = true;
  item = structuredClone(pluginItem);
  props = {
    owner: { agentId: `controlled-ui-${++n}`, token: {}, current: () => live },
    cwd: "/controlled/project",
    selectionId: pluginTicket,
    enabled: true,
    choosing: false,
    chooseDirectory: vi.fn(),
  };
  Object.values(h.port).forEach((fn) => fn.mockReset());
  h.port.sources.mockImplementation(async () => ({
    ...pluginOperation({ ...request(), action: "inventory" }, true),
    action: "sources",
    catalog: null,
    sources: {
      observedAtMs: Date.now(),
      scope: "officialSharedPluginConfiguration",
      source: "officialCli",
      complete: false,
      sessionApplicability: "unverified",
      items: [
        {
          id: 0,
          name: "controlled-source",
          kind: "unknown",
          query: { availability: "available", reason: null },
        },
        {
          id: 1,
          name: "ambiguous-source",
          kind: "local",
          query: { availability: "unavailable", reason: "ambiguousSource" },
        },
      ],
    },
  }));
  h.port.inventory.mockImplementation(async () => {
    const op = pluginOperation(request(), true);
    op.catalog!.items = [structuredClone(item)];
    return op;
  });
  h.port.inspect.mockImplementation(async () =>
    pluginOperation(request(), true),
  );
  h.port.confirm.mockImplementation(async () => written(request()));
  h.port.cancel.mockImplementation(async (key) => ({
    ...key,
    cancelRequested: true,
    operation: null,
  }));
});
afterEach(() => {
  h.frames.forEach((slots) => slots.forEach((slot) => slot.cleanup?.()));
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("does not auto-read or write, and makes source and package selection explicit", async () => {
  render();
  expect(h.port.inventory).not.toHaveBeenCalled();
  expect(h.port.inspect).not.toHaveBeenCalled();
  await query();
  expect(text()).toContain(S.partial);
  expect(text()).toContain(S.cwdScope);
  expect(button(S.reviewInstall)).toBeUndefined();
  choose();
  expect(button(S.reviewInstall)?.props.disabled).toBe(false);
  expect(text()).toContain(S.authentication.onUse);
  expect(h.port.inspect).not.toHaveBeenCalled();
  expect(h.port.confirm).not.toHaveBeenCalled();
});
it("source/package clicks only inspect the original opaque receipt; a separate click confirms once", async () => {
  await query();
  const inventory = request();
  await inspect();
  expect(h.port.inspect).toHaveBeenCalledWith({
    agentId: props.owner.agentId,
    requestId: request().requestId,
    inventoryRequestId: inventory.requestId,
    itemId: item.id,
    install: true,
  });
  expect(h.port.confirm).not.toHaveBeenCalled();
  expect(text(true)).toContain(S.scope);
  expect(text(true)).toContain(S.installNotice);
  expect(text(true)).toContain(S.applicability);
  const confirm = button(S.confirmInstall, true)!.props.onClick as () => void;
  confirm();
  confirm();
  await flush();
  expect(h.port.confirm).toHaveBeenCalledOnce();
  expect(text(true)).toContain(S.verified);
  expect(text(true)).toContain(S.disabled);
  expect(h.port.inventory).toHaveBeenCalledOnce();
});
it("does not turn a true installed observation accompanying an unknown write into success", async () => {
  h.port.confirm.mockImplementation(async () => ({
    ...written(request()),
    state: "failed",
    code: "writeUncertain",
    outcome: "unknown",
  }));
  await query();
  await inspect();
  click(S.confirmInstall, true);
  await flush();
  expect(text(true)).toContain(S.unknownResult);
  expect(text(true)).not.toContain(S.verified);
  expect(text(true)).toContain(item.name!);
  expect(text(true)).toContain(item.marketplaceName!);
  expect(text(true)).toContain(S.installed);
  expect(h.port.confirm).toHaveBeenCalledOnce();
});
it("uses the distinct remove review and leaves enabled/adoption separate after readback", async () => {
  item = {
    ...item,
    reportedInstalled: true,
    reportedEnabled: true,
    install: { availability: "unavailable", reason: "alreadyInstalled" },
    remove: { availability: "available", reason: null },
  };
  await query();
  await inspect();
  expect(text(true)).toContain(S.removeNotice);
  expect(button(S.confirmInstall, true)).toBeUndefined();
  click(S.confirmRemove, true);
  await flush();
  expect(text(true)).toContain(S.notInstalled);
  expect(text(true)).toContain(S.applicability);
  expect(h.port.confirm).toHaveBeenCalledOnce();
});
it("retains the old catalog on a failed refresh and does not unlock a stale target", async () => {
  await query();
  choose();
  const original = pluginManagement.get(props.owner.agentId).result!.catalog;
  h.port.inventory.mockImplementation(async () => ({
    ...pluginOperation(request()),
    state: "failed",
    phase: "complete",
    settled: true,
    code: "queryFailed",
  }));
  click(S.querySelectedSource);
  await flush();
  expect(pluginManagement.get(props.owner.agentId).result!.catalog).toBe(
    original,
  );
  expect(text()).toContain(S.stale);
  expect(button(S.reviewInstall)?.props.disabled).toBe(true);
  expect(h.port.inspect).not.toHaveBeenCalled();
});
it("changing selection or availability retires old inspect/confirm callbacks", async () => {
  await query();
  choose();
  const oldInspect = button(S.reviewInstall)!.props.onClick as () => void;
  select(S.package, "");
  oldInspect();
  await flush();
  expect(h.port.inspect).not.toHaveBeenCalled();
  choose();
  click(S.reviewInstall);
  await flush();
  const oldConfirm = button(S.confirmInstall, true)!.props
    .onClick as () => void;
  props = { ...props, enabled: false };
  render(true);
  oldConfirm();
  await flush();
  expect(h.port.confirm).not.toHaveBeenCalled();
});
it("an unavailable source is displayed with a fixed reason and cannot be inspected", async () => {
  item = {
    ...item,
    source: "remote",
    install: { availability: "unavailable", reason: "unsupportedSource" },
  };
  await query();
  choose();
  expect(text()).toContain(S.reasons.unsupportedSource);
  expect(button(S.reviewInstall)?.props.disabled).toBe(true);
  expect(h.port.inspect).not.toHaveBeenCalled();
});
it("closing during a dispatched operation requests cancel and preserves unknown ownership", async () => {
  const pending = deferred();
  h.port.confirm.mockImplementation(() => pending.promise);
  await query();
  await inspect();
  click(S.confirmInstall, true);
  await flush();
  live = false;
  h.frames.forEach((slots) => slots.forEach((slot) => slot.cleanup?.()));
  await flush();
  expect(h.port.cancel).toHaveBeenCalled();
  expect(pluginManagement.get(props.owner.agentId).unresolved).toBe(true);
  expect(pluginManagement.get(props.owner.agentId).result?.stale).toBe(true);
  expect(h.port.confirm).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "keeps the prior unknown write and its target visible across a new inventory (failed=%s)",
  async (failed) => {
    h.port.confirm.mockImplementation(async () => ({
      ...written(request()),
      state: "failed",
      code: "writeUncertain",
      outcome: "unknown",
    }));
    await query();
    await inspect();
    click(S.confirmInstall, true);
    await flush();
    const original = request(),
      oldName = item.name!,
      pending = deferred();
    item = { ...item, name: "newly-reported-package" };
    h.port.inventory.mockImplementation(() => pending.promise);
    click(S.querySelectedSource);
    await flush();
    expect(text(true)).toContain(oldName);
    expect(button(S.recheck, true)?.props.disabled).toBe(true);
    const refresh = pluginOperation(request(), true);
    refresh.catalog!.items = [structuredClone(item)];
    pending.resolve(
      failed
        ? { ...refresh, state: "failed", code: "queryFailed", catalog: null }
        : refresh,
    );
    await flush();
    expect(text(true)).toContain(oldName);
    expect(text(true)).toContain("此前修改结果仍未确认");
    expect(text(true)).not.toContain(S.verified);
    expect(button(S.confirmInstall, true)).toBeUndefined();
    h.port.recheck.mockImplementation(async () => ({
      ...pluginOperation(request(), true),
      outcome: "observed",
      observation: {
        observedAtMs: Date.now(),
        reportedInstalled: true,
        reportedEnabled: false,
        sessionApplicability: "unverified",
      },
    }));
    click(S.recheck, true);
    await flush();
    expect(h.port.recheck).toHaveBeenCalledWith({
      agentId: original.agentId,
      requestId: request().requestId,
      operationId: original.requestId,
    });
    expect(text(true)).toContain("此前修改结果仍未确认");
    expect(text(true)).toContain(S.observed);
    expect(h.port.confirm).toHaveBeenCalledOnce();
  },
);

it("keeps the original unknown target and readback when a new confirmation has no admitted operation", async () => {
  h.port.confirm.mockImplementation(async () => ({
    ...written(request()),
    state: "failed",
    code: "writeUncertain",
    outcome: "unknown",
  }));
  await query();
  await inspect();
  click(S.confirmInstall, true);
  await flush();
  const original = request();
  item = { ...item, name: "newly-reviewed-package" };
  await query();
  await inspect();
  h.port.confirm.mockRejectedValue({ code: "reviewExpired" });
  click(S.confirmInstall, true);
  await flush();
  expect(pluginManagement.get(props.owner.agentId).operation).toBeNull();
  expect(text(true)).toContain(original.target!.name!);
  expect(text(true)).toContain("此前修改结果仍未确认");
  expect(button(S.confirmInstall, true)).toBeUndefined();
  h.port.recheck.mockImplementation(async () => ({
    ...pluginOperation(request(), true),
    state: "failed",
    code: "writeUncertain",
    outcome: "unknown",
  }));
  click(S.recheck, true);
  await flush();
  expect(h.port.recheck).toHaveBeenCalledWith({
    agentId: original.agentId,
    requestId: request().requestId,
    operationId: original.requestId,
  });
  expect(request().target).toEqual(original.target);
  expect(h.port.confirm).toHaveBeenCalledTimes(2);
});

it("requires a separate explicit source query and opaque source selection before requesting package inventory", async () => {
  render();
  expect(h.port.sources).not.toHaveBeenCalled();
  expect(h.port.inventory).not.toHaveBeenCalled();
  click(S.query);
  await flush();
  const sourceRequest = request();
  expect(h.port.sources).toHaveBeenCalledOnce();
  expect(h.port.inventory).not.toHaveBeenCalled();
  expect(button("检查所选来源技能包")?.props.disabled).toBe(true);
  select("查询来源", "1");
  expect(button("检查所选来源技能包")?.props.disabled).toBe(true);
  expect(h.port.inventory).not.toHaveBeenCalled();
  select("查询来源", "0");
  expect(h.port.inventory).not.toHaveBeenCalled();
  click("检查所选来源技能包");
  await flush();
  expect(h.port.inventory).toHaveBeenCalledWith({
    agentId: props.owner.agentId,
    requestId: request().requestId,
    sourceRequestId: sourceRequest.requestId,
    sourceId: 0,
  });
  expect(text()).toContain(S.partial);
  expect(h.port.confirm).not.toHaveBeenCalled();
});

it("requires fresh source and package choices when a refreshed source reuses the same id and name", async () => {
  await query();
  choose();
  const prior = pluginManagement.get(props.owner.agentId).sourceResult!;
  const oldInspect = button(S.reviewInstall)!.props.onClick as () => void;
  click(S.queryAgain);
  await flush();
  expect(
    pluginManagement.get(props.owner.agentId).sourceResult!.catalog.items,
  ).toEqual(prior.catalog.items);
  expect(
    pluginManagement.get(props.owner.agentId).sourceResult!.request.requestId,
  ).not.toBe(prior.request.requestId);
  expect(button(S.querySelectedSource)?.props.disabled).toBe(true);
  expect(
    render().find((node) => node.props["aria-label"] === S.querySource)?.props
      .value,
  ).toBe("");
  expect(
    render().find((node) => node.props["aria-label"] === S.package)?.props
      .value,
  ).toBe("");
  expect(h.port.inventory).toHaveBeenCalledOnce();
  oldInspect();
  expect(h.port.inspect).not.toHaveBeenCalled();
  select(S.querySource, "0");
  expect(h.port.inventory).toHaveBeenCalledOnce();
  click(S.querySelectedSource);
  await flush();
  expect(h.port.inventory).toHaveBeenCalledTimes(2);
  expect(button(S.reviewInstall)).toBeUndefined();
});

it.each([false, true])(
  "keeps old catalog read-only and old unknown write paired while Sources is pending or fails (failed=%s)",
  async (failed) => {
    h.port.confirm.mockImplementation(async () => ({
      ...written(request()),
      state: "failed",
      code: "writeUncertain",
      outcome: "unknown",
    }));
    await query();
    await inspect();
    click(S.confirmInstall, true);
    await flush();
    const original = request(),
      catalog = pluginManagement.get(props.owner.agentId).result!.catalog;
    const pending = deferred();
    h.port.sources.mockImplementation(() => pending.promise);
    click(S.queryAgain);
    await flush();
    expect(pluginManagement.get(props.owner.agentId).result!.catalog).toBe(
      catalog,
    );
    expect(button(S.recheck, true)?.props.disabled).toBe(true);
    expect(
      render().find((node) => node.props["aria-label"] === S.querySource)?.props
        .disabled,
    ).toBe(true);
    expect(text(true)).toContain("此前修改结果仍未确认");
    pending.resolve(
      failed
        ? {
            ...pluginOperation(request()),
            state: "failed",
            phase: "complete",
            settled: true,
            code: "queryFailed",
          }
        : pluginOperation(request(), true),
    );
    await flush();
    expect(pluginManagement.get(props.owner.agentId).result!.catalog).toBe(
      catalog,
    );
    expect(button(S.querySelectedSource)?.props.disabled).toBe(true);
    expect(text(true)).toContain("此前修改结果仍未确认");
    expect(text(true)).not.toContain(S.verified);
    h.port.recheck.mockImplementation(async () => ({
      ...pluginOperation(request(), true),
      state: "failed",
      code: "writeUncertain",
      outcome: "unknown",
    }));
    click(S.recheck, true);
    await flush();
    expect(h.port.recheck).toHaveBeenCalledWith({
      agentId: original.agentId,
      requestId: request().requestId,
      operationId: original.requestId,
    });
    expect(request().target).toEqual(original.target);
    expect(h.port.confirm).toHaveBeenCalledOnce();
  },
);
