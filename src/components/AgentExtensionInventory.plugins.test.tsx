import { Children, isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  }[],
  effects: [] as (() => void)[],
  capability: {} as Record<string, unknown>,
  capabilities: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef(initial: unknown) {
    return (h.slots[h.cursor++] ??= { value: { current: initial } }).value;
  },
  useMemo(fn: () => unknown, deps: readonly unknown[]) {
    const i = h.cursor++;
    const old = h.slots[i];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps?.[n])))
      h.slots[i] = { value: fn(), deps };
    return h.slots[i].value;
  },
  useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
    const i = h.cursor++;
    const old = h.slots[i];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps?.[n]))) {
      const slot = { deps, cleanup: old?.cleanup };
      h.slots[i] = slot;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("../runtime/extension_inventory", () => ({
  extensionCapabilities: h.capabilities,
  inventoryPort: { read: vi.fn(), status: vi.fn(), cancel: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
import { AgentExtensionInventory } from "./AgentExtensionInventory";
import { flush } from "../runtime/extension_inventory.test-support";

type Element = { type: unknown; props: Record<string, unknown> };
const selection = {};
function nodes(node: ReactNode): Element[] {
  const out: Element[] = [];
  Children.forEach(node, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      out.push(child, ...nodes(child.props.children as ReactNode));
  });
  return out;
}
// Controlled hook commits exercise the production component. No browser DOM,
// native IPC, real command or Agent configuration is used by this test.
function render(): Element[] {
  h.cursor = 0;
  const tree = nodes(
    AgentExtensionInventory({ agentId: "controlled", selection, active: true }),
  );
  const effects = h.effects.splice(0);
  if (effects.length) {
    effects.forEach((effect) => effect());
    return render();
  }
  return tree;
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.cursor = 0;
  h.capability = {
    selectionId: "11111111-1111-1111-1111-111111111111",
    mcpInventory: { availability: "unavailable", reason: "notReviewed" },
    skillsInventory: { availability: "unavailable", reason: "notReviewed" },
    skillEnablement: { availability: "unavailable", reason: "notReviewed" },
    pluginManagement: {
      availability: "available",
      source: "officialCli",
      reason: null,
      support: "unverified",
    },
  };
  h.capabilities.mockReset().mockImplementation(async () => h.capability);
});
afterEach(() => h.slots.forEach((slot) => slot.cleanup?.()));

it("offers the common skill-package category only from the explicit backend query capability", async () => {
  render();
  await flush();
  expect(
    render().some(
      (node) => node.type === "option" && node.props.value === "plugins",
    ),
  ).toBe(true);
  expect(h.capabilities).toHaveBeenCalledOnce();
});

it("does not invent package management for a report without its capability", async () => {
  delete h.capability.pluginManagement;
  render();
  await flush();
  expect(
    render().some(
      (node) => node.type === "option" && node.props.value === "plugins",
    ),
  ).toBe(false);
});
