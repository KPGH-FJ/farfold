import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type ComponentProps,
} from "react";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  invoke: vi.fn(),
  open: vi.fn(),
}));
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import {
  ProgramManager,
  type Installation,
  type ProgramInventory,
} from "./ProgramManager";
import { agentSetupProgram } from "./AgentSetupProgram";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import { ACCESS_STRINGS } from "../runtime/access_strings";
import { R5_PROGRAM_STRINGS as R } from "../runtime/r5_program_strings";

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
function button(
  label: string,
  extra: Partial<ComponentProps<typeof ProgramManager>> = {},
) {
  return render(extra).find(
    (node) => node.type === "button" && node.props.children === label,
  )!;
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

it("shows the current program first and puts other installations behind one management disclosure", () => {
  const nodes = render();
  const header = nodes.find(
    (node) => node.props.className === "program-manager-heading s-head-row",
  )!;
  expect(
    elements(header.props.children as ReactNode).some(
      (node) => node.type === "h3" && node.props.children === R.currentProgram,
    ),
  ).toBe(true);
  expect(
    elements(header.props.children as ReactNode).some(
      (node) => node.type === "button" && node.props.children === S.retry,
    ),
  ).toBe(true);
  const current = nodes.find(
    (node) => node.props.className === "program-current",
  )!;
  expect(
    elements(current.props.children as ReactNode)
      .filter((node) => node.props.className === "program-row")
      .map((node) => node.key),
  ).toEqual(["external"]);
  const management = nodes.find(
    (node) => node.props.className === "program-installation-management",
  )!;
  expect(management.type).toBe("details");
  expect(management.props.open).not.toBe(true);
  const rows = elements(management.props.children as ReactNode).filter(
    (node) => node.props.className === "program-row",
  );
  expect(rows.map((node) => node.key)).toEqual(["component", "candidate"]);
  expect(rows.map((node) => node.props["data-selected"])).toEqual([
    true,
    false,
  ]);
  expect(
    nodes.some(
      (node) =>
        node.props.children === S.disconnected ||
        node.props.children === S.programReady,
    ),
  ).toBe(false);
  expect(
    nodes.some(
      (node) => node.type === "button" && node.props.children === S.uninstall,
    ),
  ).toBe(false);
  expect(choose("candidate")?.props.className).toBe("btn btn-primary");
  expect(choose("external")).toBeUndefined();
  expect(choose("component")).toBeUndefined();
  expect(select).not.toHaveBeenCalled();
});

it("keeps version, external ownership, and location together in closed installation details", () => {
  const nodes = elements(row("external").props.children as ReactNode);
  const details = nodes.find(
    (node) =>
      node.type === "details" && node.props.className === "program-path",
  )!;
  expect(details.props.open).not.toBe(true);
  const detailNodes = elements(details.props.children as ReactNode);
  expect(
    detailNodes.some((node) => node.props.children === R.installationDetails),
  ).toBe(true);
  expect(detailNodes.some((node) => node.props.children === S.external)).toBe(
    true,
  );
  expect(
    detailNodes.some((node) =>
      Children.toArray(node.props.children as ReactNode).includes("0.80.5"),
    ),
  ).toBe(true);
  expect(
    detailNodes.some((node) => node.props.children === "/programs/external"),
  ).toBe(true);
  expect(choose("external")).toBeUndefined();
  expect(h.invoke).not.toHaveBeenCalled();
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

it("shows downloaded bytes for this installation and retains its original cancellation target", () => {
  card.status = "installed";
  agents.busy[card.id] = "install";
  agents.cancelInstall = vi.fn();
  agents.installProgress = {
    [card.id]: { stage: "download", bytes: 3145728, total: null },
    unrelated: { stage: "download", bytes: 1024, total: 4096 },
  };
  const progress = () => render().find((node) => node.props.role === "status")!;
  expect(Children.toArray(progress().props.children as ReactNode)).toContain(
    "下载中… 已下载 3 MiB",
  );
  agents.installProgress[card.id] = {
    stage: "download",
    bytes: 4194304,
    total: 8388608,
  };
  expect(Children.toArray(progress().props.children as ReactNode)).toContain(
    "下载中… 4 MiB / 8 MiB",
  );
  const cancel = elements(progress().props.children as ReactNode).find(
    (node) => node.type === "button",
  )!;
  (cancel.props.onClick as () => void)();
  expect(agents.cancelInstall).toHaveBeenCalledExactlyOnceWith(card.id);
  agents.installProgress[card.id].stage = "extract";
  expect(Children.toArray(progress().props.children as ReactNode)).toContain(
    STRINGS.install.stages.extract,
  );
  expect(
    Children.toArray(progress().props.children as ReactNode),
  ).not.toContain("下载中… 4 MiB / 8 MiB");
  expect(select).not.toHaveBeenCalled();
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

it.each([
  { state: "being refreshed", loading: true, error: null },
  {
    state: "unconfirmed after a failed refresh",
    loading: false,
    error: "清单读取失败",
  },
])(
  "retains old records but blocks changes while the list is $state",
  async ({ loading, error }) => {
    card.status = "installed";
    const uninstall = elements(
      row("candidate").props.children as ReactNode,
    ).find(
      (node) => node.type === "button" && node.props.children === S.uninstall,
    )!;
    (uninstall.props.onClick as () => void)();
    inventory.loading = loading;
    inventory.error = error;
    const onInstall = vi.fn(async () => true);
    const controls = [
      choose("candidate")!,
      button(S.uninstallConfirm),
      button(S.componentUpdate, { onInstall }),
      button(STRINGS.install.chooseProgram),
    ];
    for (const control of controls) {
      expect(control.props.disabled).toBe(true);
      (control.props.onClick as () => void)();
    }
    await settled();
    expect(inventory.items).toHaveLength(3);
    expect(choose("external")).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
    expect(onInstall).not.toHaveBeenCalled();

    inventory.loading = false;
    inventory.error = null;
    expect(choose("candidate")!.props.disabled).toBe(false);
    expect(button(S.componentUpdate, { onInstall }).props.disabled).toBe(false);
  },
);

it("preserves the selected program and the explicit confirmation when selection returns false", async () => {
  card.status = "installed";
  const uninstall = elements(row("candidate").props.children as ReactNode).find(
    (node) => node.type === "button" && node.props.children === S.uninstall,
  )!;
  (uninstall.props.onClick as () => void)();
  expect(button(S.uninstallConfirm)).toBeDefined();
  select.mockImplementationOnce(async () => {
    agents.errors[card.id] = "候选程序检查未完成，原选择已保留";
    return false;
  });
  (choose("candidate")!.props.onClick as () => void)();
  await settled();
  expect(choose("external")).toBeUndefined();
  expect(choose("candidate")!.props.disabled).toBe(false);
  expect(button(S.uninstallConfirm)).toBeDefined();
  expect(agents.refresh).not.toHaveBeenCalled();
  expect(
    render().some((node) => node.props.children === agents.errors[card.id]),
  ).toBe(true);
});

it("checks the current program once and keeps a failed connection factual", async () => {
  card.status = "installed";
  const onConnect = vi.fn(async () => {
    throw new Error("连接检查未完成");
  });
  const connect = (disabled = false) =>
    button(ACCESS_STRINGS.connect, {
      onConnect,
      connectDisabled: disabled,
      showHeading: false,
    });
  expect(
    render({ onConnect }).filter(
      (node) => node.props.children === ACCESS_STRINGS.connect,
    ),
  ).toHaveLength(1);
  (connect(true).props.onClick as () => void)();
  expect(onConnect).not.toHaveBeenCalled();
  (connect().props.onClick as () => void)();
  await settled();
  expect(onConnect).toHaveBeenCalledOnce();
  expect(card.status).toBe("installed");
  expect(
    render({ onConnect }).some(
      (node) => node.props.children === "连接检查未完成",
    ),
  ).toBe(true);
  expect(connect().props.disabled).toBe(false);
  expect(select).not.toHaveBeenCalled();
});

it("retains disconnect confirmation for false or failed results and unlocks only refreshed facts", async () => {
  const onDisconnect = vi.fn(async () => false);
  const extra = { onDisconnect };
  (button(R.disconnectForManagement, extra).props.onClick as () => void)();
  (button(STRINGS.agents.disconnect, extra).props.onClick as () => void)();
  await settled();
  expect(button(R.keepConnection, extra)).toBeDefined();
  expect(choose("candidate")!.props.disabled).toBe(true);

  onDisconnect.mockRejectedValueOnce(new Error("尚未确认断开"));
  (button(STRINGS.agents.disconnect, extra).props.onClick as () => void)();
  await settled();
  expect(button(R.keepConnection, extra)).toBeDefined();
  expect(
    render(extra).some((node) => node.props.children === "尚未确认断开"),
  ).toBe(true);
  expect(choose("candidate")!.props.disabled).toBe(true);

  onDisconnect.mockResolvedValueOnce(true);
  (button(STRINGS.agents.disconnect, extra).props.onClick as () => void)();
  await settled();
  expect(button(R.keepConnection, extra)).toBeUndefined();
  expect(choose("candidate")!.props.disabled).toBe(true);
  card.status = "installed";
  inventory.loading = true;
  expect(choose("candidate")!.props.disabled).toBe(true);
  inventory.loading = false;
  expect(choose("candidate")!.props.disabled).toBe(false);
  expect(select).not.toHaveBeenCalled();
});

it("keeps a pending uninstall confirmation from deleting a newly selected installation", () => {
  card.status = "installed";
  const uninstall = elements(row("candidate").props.children as ReactNode).find(
    (node) => node.type === "button" && node.props.children === S.uninstall,
  )!;
  (uninstall.props.onClick as () => void)();
  expect(button(S.uninstallConfirm).props.disabled).toBe(false);
  selectedId = "candidate";
  refreshItems();
  const confirm = button(S.uninstallConfirm);
  expect(confirm.props.disabled).toBe(true);
  (confirm.props.onClick as () => void)();
  expect(h.invoke).not.toHaveBeenCalled();
  expect(choose("candidate")).toBeUndefined();
});

it("keeps a guarded disconnect available when the installation inventory cannot be read", async () => {
  inventory.items = [];
  inventory.error = "清单读取失败";
  const onDisconnect = vi.fn(async () => false);
  const blocked = { onDisconnect, disconnectDisabled: true };
  expect(button(R.disconnectForManagement, blocked).props.disabled).toBe(true);
  (button(R.disconnectForManagement, blocked).props.onClick as () => void)();
  expect(button(STRINGS.agents.disconnect, blocked)).toBeUndefined();
  const extra = { onDisconnect };
  (button(R.disconnectForManagement, extra).props.onClick as () => void)();
  expect(onDisconnect).not.toHaveBeenCalled();
  (button(STRINGS.agents.disconnect, extra).props.onClick as () => void)();
  await settled();
  expect(onDisconnect).toHaveBeenCalledOnce();
  expect(button(R.keepConnection, extra)).toBeDefined();
  expect(select).not.toHaveBeenCalled();
});

it.each([true, false])(
  "blocks an installed Agent with missing required programs even when the inventory has a current record (%s)",
  async (hasCurrent) => {
    card.status = "installed";
    if (!hasCurrent) inventory.items = [];
    const onConnect = vi.fn(async () => {});
    const onInstall = vi.fn(async () => true);
    const extra = { prerequisitesReady: false, onConnect, onInstall };
    const nodes = render(extra);
    const pending = nodes.find(
      (node) => node.props.children === R.preparationRequired,
    )!;
    expect(pending.props.className).toBe("program-not-selected");
    expect(nodes.some((node) => node.props.children === S.prepared)).toBe(
      false,
    );
    const connect = button(ACCESS_STRINGS.connect, extra);
    expect(connect.props.disabled).toBe(true);
    expect(connect.props.className).toBe("btn btn-ghost");
    (connect.props.onClick as () => void)();
    expect(onConnect).not.toHaveBeenCalled();
    expect(button(S.retry, extra).props.disabled).toBe(false);
    (button(S.retry, extra).props.onClick as () => void)();
    expect(inventory.refresh).toHaveBeenCalledOnce();
    expect(button(S.componentUpdate, extra).props.disabled).toBe(false);
    (button(S.componentUpdate, extra).props.onClick as () => void)();
    expect(onInstall).toHaveBeenCalledOnce();
    const prepared = { ...extra, prerequisitesReady: true };
    expect(button(ACCESS_STRINGS.connect, prepared).props.disabled).toBe(false);
    (button(ACCESS_STRINGS.connect, prepared).props.onClick as () => void)();
    await settled();
    expect(onConnect).toHaveBeenCalledOnce();
  },
);

it("does not mislabel a confirmed connection when a prerequisite needs preparation", () => {
  const onDisconnect = vi.fn(async () => true);
  const extra = { prerequisitesReady: false, onDisconnect };
  const nodes = render(extra);
  expect(nodes.some((node) => node.props.children === S.connected)).toBe(true);
  expect(
    nodes.some((node) => node.props.children === R.preparationRequired),
  ).toBe(false);
  expect(button(R.disconnectForManagement, extra).props.disabled).toBe(false);
  expect(onDisconnect).not.toHaveBeenCalled();
});

it.each([true, false])(
  "passes missing use readiness through setup without disabling installation management (registered=%s)",
  (registered) => {
    card.status = registered ? "installed" : "discovered";
    card.registerable = !registered;
    const onConnect = vi.fn(async () => {});
    const tree = agentSetupProgram({
      card,
      agents,
      inventory,
      installation: {
        ready: true,
        read: () => undefined,
        onInfoChange: () => {},
        fieldProps: {
          loaded: true,
          options: undefined,
          input: undefined,
          invalidSaved: undefined,
          onChange: () => {},
          onValidityChange: () => {},
        },
      },
      setupStep: 0,
      connected: false,
      registered,
      needsProgramInstall: false,
      prerequisitesReady: false,
      installPrerequisitesReady: true,
      busy: false,
      authBusy: false,
      operationPending: false,
      progress: null,
      intent: "manage",
      removeConfirm: false,
      onRemoveConfirm: () => {},
      onConnect,
      onDisconnect: async () => true,
      onClose: () => {},
      importControl: null,
    });
    const manager = elements(tree).find(
      (node) => node.type === ProgramManager,
    )!;
    expect(manager.props.prerequisitesReady).toBe(false);
    expect(manager.props.connectDisabled).toBe(true);
    expect(manager.props.installDisabled).toBe(false);
    const guard = elements(tree).find((node) => node.type === "fieldset")!;
    expect(guard.props.disabled).toBe(false);
    if (!registered) {
      const connect = elements(tree).find(
        (node) =>
          node.type === "button" &&
          node.props.children === ACCESS_STRINGS.connect,
      )!;
      expect(connect.props.disabled).toBe(true);
      expect(connect.props.className).toBe("btn btn-ghost");
      (connect.props.onClick as () => void)();
      expect(onConnect).not.toHaveBeenCalled();
    }
  },
);
