import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type ComponentProps,
} from "react";

const h = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
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
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import {
  ProgramManager,
  type Installation,
  type ProgramInventory,
} from "./ProgramManager";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";

type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode): Element[] {
  const nodes: Element[] = [];
  Children.forEach(tree, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    nodes.push(child, ...elements(child.props.children as ReactNode));
  });
  return nodes;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let card: AgentCardModel;
let agents: AgentsState;
let inventory: ProgramInventory;
let selectedId: string;
const select = vi.fn();
const S = STRINGS.access;
function record(id: string, version: string, managed: boolean): Installation {
  return {
    id,
    source: managed ? "registry" : "external",
    path: `/programs/${id}`,
    version,
    managedRoot: managed ? `/programs/${id}` : null,
    programOnly: true,
    selected: id === selectedId,
    inUse: false,
    canUninstall: managed && id !== selectedId,
  };
}
function refreshItems() {
  inventory.items = [
    {
      ...record("component", "0.0.34", true),
      programOnly: false,
      selected: true,
    },
    record("external", "0.80.5", false),
    record("candidate", "0.81.0", true),
  ];
}
function render(extra: Partial<ComponentProps<typeof ProgramManager>> = {}) {
  h.cursor = 0;
  return elements(ProgramManager({ card, agents, inventory, ...extra }));
}
function row(id: string) {
  return render().find(
    (node) => node.props.className === "program-row" && node.key === id,
  )!;
}
function choose(id: string) {
  return elements(row(id).props.children as ReactNode).find(
    (node) => node.type === "button" && node.props.children === S.select,
  );
}
async function settled() {
  for (let i = 0; i < 8; i++) {
    render();
    await Promise.resolve();
  }
}
beforeEach(() => {
  h.slots = [];
  vi.clearAllMocks();
  selectedId = "external";
  card = {
    id: "versioned-program",
    name: "Example",
    description: "",
    status: "connected",
    version: "0.0.34",
    authMethods: [],
    discoveredPath: "/programs/external",
    registryVersion: null,
    source: "registry",
    installable: true,
    registerable: false,
    custom: false,
    handshake: null,
    programEnv: "PROGRAM_PATH",
    programPath: "/programs/external",
  };
  inventory = {
    items: [],
    loading: false,
    error: null,
    refresh: vi.fn(async () => refreshItems()),
  };
  refreshItems();
  select.mockImplementation(
    async (_agentId: string, installationId: string) => {
      selectedId = installationId;
      return true;
    },
  );
  agents = {
    busy: {},
    errors: {},
    installProgress: {},
    selectInstallation: select,
    refresh: vi.fn(async () => {}),
  } as unknown as AgentsState;
});

it("uses the shared reviewed installation action and respects its missing-input gate", async () => {
  card.status = "installed";
  const onInstall = vi.fn(async () => {});
  agents.install = vi.fn(async () => true);
  const update = (disabled: boolean) =>
    render({ onInstall, installDisabled: disabled }).find(
      (node) =>
        node.type === "button" && node.props.children === S.componentUpdate,
    )!;
  expect(update(true).props.disabled).toBe(true);
  (update(true).props.onClick as () => void)();
  expect(onInstall).not.toHaveBeenCalled();
  expect(agents.install).not.toHaveBeenCalled();
  expect(update(false).props.disabled).toBe(false);
  (update(false).props.onClick as () => void)();
  expect(onInstall).toHaveBeenCalledTimes(1);
  expect(agents.install).not.toHaveBeenCalled();
});

it("shows the new program separately and requires disconnect before explicit selection", () => {
  const candidate = row("candidate");
  expect(
    elements(candidate.props.children as ReactNode).some(
      (node) => node.props.children === "0.81.0",
    ),
  ).toBe(true);
  expect(
    elements(candidate.props.children as ReactNode).some(
      (node) => node.props.children === S.notSelected,
    ),
  ).toBe(true);
  expect(choose("candidate")?.props.disabled).toBe(true);
  expect(choose("external")).toBeUndefined();
  expect(select).not.toHaveBeenCalled();
});

it("keeps the original selected until checking completes and supports explicit selection back", async () => {
  card.status = "installed";
  const check = deferred();
  select.mockImplementationOnce(
    async (_agentId: string, installationId: string) => {
      await check.promise;
      selectedId = installationId;
      return true;
    },
  );
  (choose("candidate")!.props.onClick as () => void)();
  expect(select).toHaveBeenCalledExactlyOnceWith(card.id, "candidate");
  expect(choose("external")).toBeUndefined();
  expect(choose("candidate")?.props.disabled).toBe(true);
  check.resolve();
  await settled();
  expect(choose("candidate")).toBeUndefined();
  expect(choose("external")?.props.disabled).toBe(false);
  (choose("external")!.props.onClick as () => void)();
  await settled();
  expect(select).toHaveBeenLastCalledWith(card.id, "external");
  expect(choose("external")).toBeUndefined();
  expect(choose("candidate")?.props.disabled).toBe(false);
});

it("keeps both programs and the old selection when checking a candidate fails", async () => {
  card.status = "installed";
  select.mockRejectedValueOnce(new Error("候选程序检查未完成，原选择已保留"));
  (choose("candidate")!.props.onClick as () => void)();
  await settled();
  expect(
    render().some(
      (node) =>
        node.props.role === "alert" &&
        node.props.children === "候选程序检查未完成，原选择已保留",
    ),
  ).toBe(true);
  expect(choose("external")).toBeUndefined();
  expect(choose("candidate")?.props.disabled).toBe(false);
  expect(inventory.items).toHaveLength(3);
});
