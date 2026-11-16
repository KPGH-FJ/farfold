import { afterEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

// Render the real component as elements, retaining its actual button closures.
// Only React hook hosting and the native ports are controlled; no DOM/App claim.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  useState: (value: unknown) => [value, () => {}],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: () => {},
}));

import { SkillChangeReview } from "../components/SkillChangeReview";
import { skillManagement } from "./skill_management_controller";
import { SKILL_MANAGEMENT_STRINGS as S } from "./skill_management_strings";
import {
  setup as skillSetup,
  operation as skillOperation,
} from "./skill_management.test-support";
import {
  setup as mcpSetup,
  operation as mcpOperation,
} from "./mcp_management.test-support";
import { ExtensionInventoryController } from "./extension_inventory_controller";
import type { InventoryPort } from "./extension_inventory";
import { deferred, flush } from "./extension_inventory.test-support";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Button = ReactElement<{
  children?: ReactNode;
  disabled?: boolean;
  onClick(): void;
}>;
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<{ children?: ReactNode }>(node)
    ? text(node.props.children)
    : "";
}
function button(node: ReactNode, labels: readonly string[]): Button {
  const found: Button[] = [];
  function walk(value: ReactNode) {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!isValidElement<{ children?: ReactNode }>(value)) return;
    if (value.type === "button" && labels.includes(text(value)))
      found.push(value as Button);
    walk(value.props.children);
  }
  walk(node);
  expect(found).toHaveLength(1);
  return found[0];
}
function click(value: Button) {
  expect(value.props.disabled).not.toBe(true);
  value.props.onClick();
}

async function management(kind: "skills" | "mcp") {
  if (kind === "skills") {
    const h = await skillSetup();
    return {
      ...h,
      controller: h.client,
      pending: {
        inspect: h.inspect,
        confirm: h.confirm,
        status: h.status,
        cancel: h.cancel,
      },
      ready: () =>
        skillOperation(h.client.get(h.owner.agentId).request!, "ready"),
    };
  }
  const h = await mcpSetup();
  return {
    ...h,
    ready: () => mcpOperation(h.controller.get(h.owner.agentId).request!, true),
  };
}

it.each([
  ["skills", "inspect"],
  ["skills", "confirm"],
  ["mcp", "inspect"],
  ["mcp", "confirm"],
] as const)(
  "restores only explicit status observation after cancelled %s %s and an older failed lookup",
  async (kind, phase) => {
    vi.useFakeTimers();
    const h = await management(kind);
    const id = h.owner.agentId;
    vi.spyOn(skillManagement, "get").mockImplementation(h.controller.get);
    vi.spyOn(skillManagement, "subscribe").mockImplementation(
      h.controller.subscribe,
    );
    vi.spyOn(skillManagement, "check").mockImplementation((...args) =>
      h.controller.check(...args),
    );
    vi.spyOn(skillManagement, "cancel").mockImplementation((...args) =>
      h.controller.cancel(...args),
    );
    const tree = () =>
      SkillChangeReview({ agentId: id, owner: h.owner, active: true });
    const status = () => button(tree(), [S.status, S.checking]);
    const cancel = () => button(tree(), [S.cancel]);
    expect(h.controller.inspect(h.target)).toBe(true);
    await flush();
    if (phase === "confirm") {
      h.pending.inspect.resolve(h.ready());
      await flush();
      expect(h.controller.confirm(h.owner, h.controller.get(id).review!)).toBe(
        true,
      );
      await flush();
    }
    h.pending[phase].reject({ code: "unavailable" });
    await flush();
    const request = h.controller.get(id).request!;
    expect(h.controller.get(id).unresolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    click(status());
    await flush();
    expect(status().props.disabled).toBe(true);
    click(cancel());
    await flush();
    const nullCancellation = {
      agentId: id,
      requestId: request.requestId,
      cancelRequested: true,
      operation: null,
    };
    h.pending.cancel.resolve(nullCancellation);
    await flush();
    h.pending.status.reject({ code: "unknownRequest" });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.controller.get(id)).toMatchObject({
      request,
      unresolved: true,
      cancelRequested: true,
      trackingReleased: false,
      error: "unavailable",
    });
    expect(status().props.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status().props.disabled).toBe(false);
    expect(h.port.status).toHaveBeenCalledTimes(1);

    const next = deferred();
    vi.mocked(h.port.status).mockReturnValueOnce(next.promise);
    click(status());
    await flush();
    expect(h.port.status).toHaveBeenLastCalledWith({
      agentId: id,
      requestId: request.requestId,
    });
    expect(h.port.status).toHaveBeenCalledTimes(2);
    next.reject({ code: "unknownRequest" });
    await flush();
    expect(h.controller.get(id)).toMatchObject({
      unresolved: true,
      trackingReleased: false,
      error: "unknownRequest",
    });
    const staleButton = status();
    click(cancel());
    await flush();
    expect(h.controller.get(id)).toMatchObject({
      unresolved: false,
      trackingReleased: true,
      error: "unknownRequest",
      review: null,
    });
    expect(h.port.inspect).toHaveBeenCalledTimes(1);
    expect(h.port.confirm).toHaveBeenCalledTimes(phase === "confirm" ? 1 : 0);
    expect(h.port.recheck).not.toHaveBeenCalled();
    h.close();
    staleButton.props.onClick();
    await flush();
    expect(h.port.status).toHaveBeenCalledTimes(2);
  },
);

it.each(["skills", "mcp"] as const)(
  "allows another exact %s inventory status check after null cancel without releasing uncertainty",
  async (kind) => {
    vi.useFakeTimers();
    const oldStatus = deferred();
    const cancelResult = deferred();
    const port: InventoryPort = {
      read: vi.fn(async () => {
        throw { code: "unavailable" };
      }),
      status: vi.fn(() => oldStatus.promise),
      cancel: vi.fn(() => cancelResult.promise),
    };
    const owner = {
      agentId: "inventory-fixture",
      token: {},
      current: () => true,
    };
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const controller = new ExtensionInventoryController(port, 100, () => id);
    expect(controller.begin(owner, "/controlled", id, kind)).toBe(true);
    await flush();
    const request = controller.get(owner.agentId).request!;
    controller.check(owner.agentId, id);
    await flush();
    expect(controller.get(owner.agentId).checking).toBe(true);
    controller.cancel(owner.agentId, id);
    await flush();
    cancelResult.resolve({
      agentId: owner.agentId,
      requestId: id,
      cancelRequested: true,
      operation: null,
    });
    await flush();
    oldStatus.reject({ code: "unknownRequest" });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.get(owner.agentId)).toMatchObject({
      request,
      unresolved: true,
      trackingReleased: false,
      cancellationRequested: true,
      error: "unavailable",
      checking: false,
    });
    const next = deferred();
    vi.mocked(port.status).mockReturnValueOnce(next.promise);
    controller.check(owner.agentId, id);
    await flush();
    expect(port.status).toHaveBeenCalledTimes(2);
    expect(port.status).toHaveBeenLastCalledWith(request);
    next.reject({ code: "unknownRequest" });
    await flush();
    expect(controller.get(owner.agentId).unresolved).toBe(true);
    controller.cancel(owner.agentId, id);
    await flush();
    expect(controller.get(owner.agentId)).toMatchObject({
      request,
      unresolved: false,
      trackingReleased: true,
      error: "unknownRequest",
      result: null,
    });
    expect(port.read).toHaveBeenCalledTimes(1);
  },
);

it.each(["management", "inventory"] as const)(
  "an older null cancellation cannot release a newer %s status observation",
  async (kind) => {
    vi.useFakeTimers();
    const h = await (async () => {
      if (kind === "management") {
        const x = await skillSetup();
        return {
          controller: x.client,
          owner: x.owner,
          start: () => x.client.inspect(x.target),
          first: x.inspect,
          oldStatus: x.status,
          cancelResult: x.cancel,
          port: x.port,
        };
      }
      const first = deferred(),
        oldStatus = deferred(),
        cancelResult = deferred();
      const port: InventoryPort = {
        read: vi.fn(() => first.promise),
        status: vi.fn(() => oldStatus.promise),
        cancel: vi.fn(() => cancelResult.promise),
      };
      const owner = { agentId: "older-null", token: {}, current: () => true };
      const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const controller = new ExtensionInventoryController(port, 100, () => id);
      return {
        controller,
        owner,
        start: () => controller.begin(owner, "/controlled", id, "skills"),
        first,
        oldStatus,
        cancelResult,
        port,
      };
    })();
    expect(h.start()).toBe(true);
    await flush();
    h.first.reject({ code: "unavailable" });
    await flush();
    const agent = h.owner.agentId;
    const request = h.controller.get(agent).request!;
    h.controller.check(agent, request.requestId);
    await flush();
    h.controller.cancel(agent, request.requestId);
    await flush();
    h.oldStatus.reject({ code: "unknownRequest" });
    await flush();
    await vi.advanceTimersByTimeAsync(101);
    expect(h.controller.get(agent).checking).toBe(false);
    const fresh = deferred();
    vi.mocked(h.port.status).mockReturnValueOnce(fresh.promise);
    h.controller.check(agent, request.requestId);
    await flush();
    expect(h.controller.get(agent).checking).toBe(true);

    h.cancelResult.resolve({
      agentId: agent,
      requestId: request.requestId,
      cancelRequested: true,
      operation: null,
    });
    await flush();

    expect(h.controller.get(agent)).toMatchObject({
      request,
      unresolved: true,
      trackingReleased: false,
      checking: true,
    });
    expect(h.port.status).toHaveBeenCalledTimes(2);
    fresh.reject({ code: "unknownRequest" });
    await flush();
    expect(h.controller.get(agent)).toMatchObject({
      unresolved: true,
      trackingReleased: false,
      checking: false,
      error: "unknownRequest",
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  ["skills", "inspect"],
  ["skills", "confirm"],
  ["mcp", "inspect"],
  ["mcp", "confirm"],
] as const)(
  "an older %s %s status timeout preserves risk but cannot enable the newer actual query button",
  async (kind, phase) => {
    vi.useFakeTimers();
    const h = await management(kind);
    const id = h.owner.agentId;
    const changed = vi.spyOn(h.target, "changed");
    vi.spyOn(skillManagement, "get").mockImplementation(h.controller.get);
    vi.spyOn(skillManagement, "subscribe").mockImplementation(
      h.controller.subscribe,
    );
    vi.spyOn(skillManagement, "check").mockImplementation((...args) =>
      h.controller.check(...args),
    );
    vi.spyOn(skillManagement, "cancel").mockImplementation((...args) =>
      h.controller.cancel(...args),
    );
    const tree = () =>
      SkillChangeReview({ agentId: id, owner: h.owner, active: true });
    const status = () => button(tree(), [S.status, S.checking]);
    expect(h.controller.inspect(h.target)).toBe(true);
    await flush();
    if (phase === "confirm") {
      h.pending.inspect.resolve(h.ready());
      await flush();
      expect(h.controller.confirm(h.owner, h.controller.get(id).review!)).toBe(
        true,
      );
      await flush();
    }
    h.pending[phase].reject({ code: "unavailable" });
    await flush();
    const request = h.controller.get(id).request!;
    click(status());
    await flush();
    await vi.advanceTimersByTimeAsync(25);
    click(button(tree(), [S.cancel]));
    await flush();
    h.pending.cancel.resolve({
      agentId: id,
      requestId: request.requestId,
      cancelRequested: true,
      operation: null,
    });
    await flush();
    expect(status().props.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    const fresh = deferred();
    vi.mocked(h.port.status).mockReturnValueOnce(fresh.promise);
    click(status());
    await flush();
    expect(status().props.disabled).toBe(true);
    const marksBeforeOldTimeout = changed.mock.calls.length;

    await vi.advanceTimersByTimeAsync(50);

    expect(changed).toHaveBeenCalledTimes(
      marksBeforeOldTimeout + (phase === "confirm" ? 1 : 0),
    );
    expect(status().props.disabled).toBe(true);
    expect(h.controller.get(id)).toMatchObject({
      unresolved: true,
      trackingReleased: false,
      checking: true,
      error: "unavailable",
    });
    expect(h.port.status).toHaveBeenCalledTimes(2);
    fresh.reject({ code: "unknownRequest" });
    await flush();
    h.pending.status.reject({ code: "unavailable" });
    await flush();
    expect(status().props.disabled).toBe(false);
    expect(h.controller.get(id)).toMatchObject({
      request,
      unresolved: true,
      trackingReleased: false,
      error: "unknownRequest",
    });
    expect(h.port.inspect).toHaveBeenCalledTimes(1);
    expect(h.port.confirm).toHaveBeenCalledTimes(phase === "confirm" ? 1 : 0);
    expect(h.port.recheck).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    h.close();
  },
);

it.each(["skills", "mcp"] as const)(
  "an older %s inventory timer cannot release a newer status observation",
  async (kind) => {
    vi.useFakeTimers();
    const oldStatus = deferred(),
      cancelled = deferred();
    const port: InventoryPort = {
      read: vi.fn(async () => {
        throw { code: "unavailable" };
      }),
      status: vi.fn(() => oldStatus.promise),
      cancel: vi.fn(() => cancelled.promise),
    };
    const owner = {
      agentId: "inventory-timer",
      token: {},
      current: () => true,
    };
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const c = new ExtensionInventoryController(port, 100, () => id);
    expect(c.begin(owner, "/controlled", id, kind)).toBe(true);
    await flush();
    const request = c.get(owner.agentId).request!;
    c.check(owner.agentId, id);
    await flush();
    await vi.advanceTimersByTimeAsync(25);
    c.cancel(owner.agentId, id);
    await flush();
    cancelled.resolve({
      agentId: owner.agentId,
      requestId: id,
      cancelRequested: true,
      operation: null,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(25);
    const fresh = deferred();
    vi.mocked(port.status).mockReturnValueOnce(fresh.promise);
    c.check(owner.agentId, id);
    await flush();

    await vi.advanceTimersByTimeAsync(50);

    expect(c.get(owner.agentId)).toMatchObject({
      request,
      unresolved: true,
      trackingReleased: false,
      checking: true,
      error: "unavailable",
    });
    expect(port.status).toHaveBeenCalledTimes(2);
    fresh.reject({ code: "unknownRequest" });
    await flush();
    oldStatus.reject({ code: "unavailable" });
    await flush();
    expect(c.get(owner.agentId)).toMatchObject({
      unresolved: true,
      trackingReleased: false,
      checking: false,
      error: "unknownRequest",
    });
    expect(port.read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);
