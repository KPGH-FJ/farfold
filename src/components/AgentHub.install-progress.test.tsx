import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const hooks = vi.hoisted(() => ({
  values: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  cursor: 0,
  invoke: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (hooks.values[hooks.cursor++] ??= {
      value:
        typeof initial === "function" ? (initial as () => unknown)() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value =
          typeof next === "function"
            ? (next as (previous: unknown) => unknown)(slot.value)
            : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (hooks.values[hooks.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (hooks.values[hooks.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      hooks.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: hooks.invoke,
  Channel: class {},
}));
import { AgentHub, type AgentHubProps } from "./AgentHub";
import { AgentSetup } from "./AgentSetup";
import { AgentDetails } from "./AgentDetails";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { ACCESS_STRINGS as S } from "../runtime/access_strings";
import { STRINGS } from "../runtime/strings";
import { setupStorage } from "../runtime/setup_storage";

type Element = ReactElement<Record<string, unknown>>;
const card: AgentCardModel = {
  id: "fixture-installing",
  name: "Installing Agent",
  description: "Fixture",
  status: "discovered",
  version: null,
  authMethods: [],
  discoveredPath: "/fixture/program",
  registryVersion: null,
  source: null,
  installable: true,
  registerable: false,
  custom: false,
  handshake: null,
};
let agents: AgentsState;
let props: AgentHubProps;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
function text(tree: ReactNode): string {
  return Children.toArray(tree)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join("");
}
function render() {
  for (let pass = 0; pass < 8; pass++) {
    hooks.cursor = 0;
    const result = nodes(AgentHub(props));
    if (!hooks.effects.length) return result;
    for (const effect of hooks.effects.splice(0)) effect();
  }
  throw new Error("Unexpected render loop");
}
function article(id = card.id) {
  return render().find((node) => node.type === "article" && node.key === id)!;
}
function primary(id = card.id) {
  return nodes(article(id)).find(
    (node) =>
      node.type === "button" &&
      String(node.props.className).includes("agent-hub-start"),
  )!;
}
function status(id = card.id) {
  return text(
    nodes(article(id)).find(
      (node) => node.props.className === "agent-hub-card-state",
    )?.props.children as ReactNode,
  );
}
beforeEach(async () => {
  hooks.values.length = 0;
  hooks.effects.length = 0;
  hooks.cursor = 0;
  vi.stubGlobal("window", new EventTarget());
  hooks.invoke.mockReset().mockResolvedValue(null);
  await setupStorage.load();
  await setupStorage.forget(card.id);
  hooks.invoke.mockClear();
  agents = {
    cards: [{ ...card }, { ...card, id: "other-agent", name: "Other Agent" }],
    connectedCards: [],
    loading: false,
    loadError: null,
    busy: { [card.id]: "install" },
    scanning: false,
    installProgress: {
      [card.id]: { stage: "install", bytes: null, total: null },
    },
    errors: {},
    install: vi.fn(),
    cancelInstall: vi.fn(),
    selectProgram: vi.fn(),
    selectInstallation: vi.fn(),
    refresh: vi.fn(),
    rescan: vi.fn(),
    connect: vi.fn(),
    reconnect: vi.fn(),
    remove: vi.fn(),
    addCustom: vi.fn(),
  };
  props = { agents, onReturn: vi.fn(), onStart: vi.fn(), onOpenApi: vi.fn() };
});
afterEach(async () => {
  await setupStorage.flush();
  for (const slot of hooks.values) slot.cleanup?.();
  hooks.effects.length = 0;
  vi.unstubAllGlobals();
});

it("opens the requested directory view once and restores a prior directory before its default", () => {
  agents.busy = {};
  agents.cards[0].status = "installed";
  props.initialView = "added";
  const heading = () =>
    text(
      render().find((node) => node.type === "h1")?.props.children as ReactNode,
    );
  expect(heading()).toBe("管理已添加的 Agent");
  expect(render().filter((node) => node.type === "article")).toHaveLength(1);
  const discover = render().find(
    (node) => node.type === "button" && node.key === "discover",
  )!;
  (discover.props.onClick as () => void)();
  expect(heading()).toBe("找到适合这项工作的 Agent");
  expect(render().filter((node) => node.type === "article")).toHaveLength(2);

  props.requestRevision = 1;
  expect(heading()).toBe("管理已添加的 Agent");
  props.restoredState = {
    selected: null,
    detail: null,
    intent: "use",
    view: "discover",
    query: "Other Agent",
    source: "stale source filter",
    availability: "unavailable",
  };
  props.requestRevision = 2;
  expect(heading()).toBe("找到适合这项工作的 Agent");
  expect(
    render()
      .filter((node) => node.type === "article")
      .map((node) => node.key),
  ).toEqual(["other-agent"]);
  expect(agents.connect).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("opens details from the card description and keeps rediscovery in the toolbar", () => {
  const description = nodes(article()).find(
    (node) => node.props.className === "agent-hub-card-description",
  )!;
  const opener = { focus: vi.fn() } as unknown as HTMLButtonElement;
  (description.props.onClick as (event: unknown) => void)({
    currentTarget: opener,
  });
  expect(
    render().find((node) => node.type === AgentDetails)!.props.returnFocusRef,
  ).toMatchObject({ current: opener });
  expect(
    (
      render().find((node) => node.type === AgentDetails)!.props
        .card as AgentCardModel
    ).id,
  ).toBe(card.id);
  expect(render().some((node) => node.type === AgentSetup)).toBe(false);
  const toolbar = render().find(
    (node) => node.props.className === "agent-hub-toolbar",
  )!;
  const scan = nodes(toolbar).find((node) =>
    String(node.props.className).includes("agent-hub-rescan"),
  )!;
  (scan.props.onClick as () => void)();
  expect(agents.rescan).toHaveBeenCalledTimes(1);
  expect(agents.connect).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
});

it("keeps the existing installation visible after leaving setup and reopens it without another action", () => {
  (primary().props.onClick as () => void)();
  let setup = render().find((node) => node.type === AgentSetup)!;
  expect(setup.props.card).toBe(agents.cards[0]);
  (setup.props.onClose as () => void)();
  expect(render().some((node) => node.type === AgentSetup)).toBe(false);
  expect(status()).toContain(STRINGS.install.stages.install);
  expect(status()).not.toContain(S.installedLocally);
  expect(text(primary().props.children as ReactNode)).toContain("查看进度");
  (primary().props.onClick as () => void)();
  setup = render().find((node) => node.type === AgentSetup)!;
  expect(setup.props.agents).toBe(agents);
  expect(setup.props.card).toBe(agents.cards[0]);
  expect(agents.install).not.toHaveBeenCalled();
  expect(agents.connect).not.toHaveBeenCalled();
  expect(props.onStart).not.toHaveBeenCalled();
  expect(
    hooks.invoke.mock.calls.every(([name]) => name === "settings_set"),
  ).toBe(true);
});

it.each(["install", "connect"] as const)(
  "resumes the same unfinished choices from the settings entry during %s",
  (busy) => {
    agents.busy[card.id] = null;
    agents.cards[0].status = "installed";
    (primary().props.onClick as () => void)();
    let setup = render().find((node) => node.type === AgentSetup)!;
    const useProgress = {
      step: 2,
      choice: "api",
      selection: {
        service: { id: "use-service", model: "use-model", revision: "r1" },
        config: { effort: "high" },
      },
      authMethodId: "use-login",
    };
    (setup.props.onProgress as (value: unknown) => void)(useProgress);
    (setup.props.onClose as () => void)();
    const manage = nodes(article()).find(
      (node) => node.props["aria-label"] === `${S.manage} · ${card.name}`,
    )!;
    (manage.props.onClick as () => void)();
    setup = render().find((node) => node.type === AgentSetup)!;
    expect(setup.props.intent).toBe("use");
    expect(setup.props.progress).toEqual(useProgress);
    const manageProgress = {
      ...useProgress,
      step: 0,
      authMethodId: "manage-login",
      selection: {
        service: {
          id: "manage-service",
          model: "manage-model",
          revision: "r2",
        },
        config: { effort: "ultra" },
      },
    };
    (setup.props.onProgress as (value: unknown) => void)(manageProgress);
    agents.busy[card.id] = busy;
    (setup.props.onClose as () => void)();
    (primary().props.onClick as () => void)();
    setup = render().find((node) => node.type === AgentSetup)!;
    expect(setup.props.intent).toBe("use");
    expect(setup.props.progress).toEqual(manageProgress);
    expect(agents.install).not.toHaveBeenCalled();
    expect(agents.connect).not.toHaveBeenCalled();
    (setup.props.onClose as () => void)();
    agents.busy[card.id] = null;
    (primary().props.onClick as () => void)();
    expect(
      render().find((node) => node.type === AgentSetup)?.props.progress,
    ).toEqual(manageProgress);
  },
);

it("locates an in-progress operation at step zero while retaining the use entry's source and model", () => {
  agents.busy[card.id] = null;
  (primary().props.onClick as () => void)();
  let setup = render().find((node) => node.type === AgentSetup)!;
  const progress = {
    step: 2,
    choice: "existing",
    selection: { service: null, config: { model: "chosen", effort: "ultra" } },
    authMethodId: "chosen-login",
  };
  (setup.props.onProgress as (value: unknown) => void)(progress);
  (setup.props.onClose as () => void)();
  agents.busy[card.id] = "install";
  (primary().props.onClick as () => void)();
  setup = render().find((node) => node.type === AgentSetup)!;
  expect(setup.props.progress).toEqual({ ...progress, step: 0 });
  expect(hooks.invoke).not.toHaveBeenCalled();
});

it.each(["ready", "stopped", undefined])(
  "the program page shows an active connection rather than leftover installation stage %s or installation cancellation",
  (stage) => {
    agents.busy[card.id] = "connect";
    agents.installProgress = stage
      ? { [card.id]: { stage, bytes: null, total: null } }
      : {};
    hooks.cursor = 0;
    const tree = nodes(
      AgentSetup({
        card: agents.cards[0],
        agents,
        progress: { step: 0, choice: "existing" },
        onProgress: vi.fn(),
        onClose: vi.fn(),
        onStart: vi.fn(),
        onOpenApi: vi.fn(),
      }),
    );
    const progress = tree.find(
      (node) => node.props.className === "agent-setup-progress",
    )!;
    expect(progress).toBeDefined();
    expect(text(progress.props.children as ReactNode)).toBe(
      STRINGS.agents.connecting,
    );
    expect(nodes(progress).some((node) => node.type === "button")).toBe(false);
    expect(agents.cancelInstall).not.toHaveBeenCalled();
  },
);

it.each([undefined, "future-stage", "stopped", "ready"])(
  "shows a truthful installation fallback when stage is %s",
  (stage) => {
    agents.installProgress = stage
      ? { [card.id]: { stage, bytes: null, total: null } }
      : {};
    expect(status()).toContain(STRINGS.agents.installing);
    expect(text(primary().props.children as ReactNode)).toContain("查看进度");
  },
);

it("shows the later connecting stage without mistaking connection for completed preparation", () => {
  agents.busy[card.id] = "connect";
  expect(status()).toContain(STRINGS.agents.connecting);
  expect(status()).not.toContain(STRINGS.install.stages.install);
  agents.busy[card.id] = null;
  agents.cards[0].status = "connected";
  expect(status()).toContain(S.setupIncomplete);
  expect(status()).not.toContain(STRINGS.agents.connecting);
  expect(text(primary().props.children as ReactNode)).toContain(
    S.continueSetup,
  );
});

it("keeps a failed Agent's message visible after leaving, without leaking it or progress to another Agent", () => {
  agents.busy[card.id] = null;
  agents.installProgress[card.id].stage = "stopped";
  agents.errors[card.id] = STRINGS.install.failed;
  expect(text(article().props.children as ReactNode)).toContain(
    STRINGS.install.failed,
  );
  expect(status()).toContain(S.installedLocally);
  expect(text(primary().props.children as ReactNode)).toContain(S.prepare);
  expect(
    text(article("other-agent").props.children as ReactNode),
  ).not.toContain(STRINGS.install.failed);
  expect(status("other-agent")).toContain(S.installedLocally);
  agents.busy[card.id] = "install";
  agents.installProgress[card.id].stage = "download";
  expect(status("other-agent")).not.toContain(STRINGS.install.stages.download);
});

it("shows received download bytes without a total, updates the amount and keeps each Agent's progress separate", () => {
  agents.busy["other-agent"] = "install";
  agents.installProgress["other-agent"] = {
    stage: "download",
    bytes: 1024,
    total: 2048,
  };
  agents.installProgress[card.id] = {
    stage: "download",
    bytes: 1572864,
    total: null,
  };
  expect(status()).toContain("已下载 1.5 MiB");
  expect(status()).not.toMatch(/%|剩余|\/s/);
  expect(status("other-agent")).toContain("1 KiB / 2 KiB");
  expect(status("other-agent")).not.toContain("MiB");
  agents.installProgress[card.id] = {
    stage: "download",
    bytes: 2097152,
    total: 8388608,
  };
  expect(status()).toContain("2 MiB / 8 MiB");
  expect(status()).not.toContain("1.5 MiB");
  agents.installProgress[card.id].stage = "verify";
  expect(status()).toContain(STRINGS.install.stages.verify);
  expect(status()).not.toContain("MiB");
  agents.installProgress[card.id].stage = "cancelling";
  expect(status()).toContain(STRINGS.install.stages.cancelling);
  expect(status()).not.toContain("MiB");
  expect(status("other-agent")).toContain("1 KiB / 2 KiB");
  expect(agents.install).not.toHaveBeenCalled();
});

it("keeps download size and cancellation together on the program preparation page", () => {
  agents.installProgress[card.id] = {
    stage: "download",
    bytes: 2097152,
    total: null,
  };
  hooks.cursor = 0;
  const tree = nodes(
    AgentSetup({
      card: agents.cards[0],
      agents,
      progress: { step: 0, choice: "existing" },
      onProgress: vi.fn(),
      onClose: vi.fn(),
      onStart: vi.fn(),
      onOpenApi: vi.fn(),
    }),
  );
  const progress = tree.find(
    (node) => node.props.className === "agent-setup-progress",
  )!;
  expect(text(progress.props.children as ReactNode)).toContain("已下载 2 MiB");
  const cancel = nodes(progress).find((node) => node.type === "button")!;
  (cancel.props.onClick as () => void)();
  expect(agents.cancelInstall).toHaveBeenCalledExactlyOnceWith(card.id);
});
