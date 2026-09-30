import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  invoke: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots))
      h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[index],
      (value: unknown) => {
        h.slots[index] =
          typeof value === "function" ? value(h.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = { current: initial };
    return h.slots[index];
  },
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const index = h.cursor++;
    const previous = h.effects[index];
    if (
      !previous ||
      !deps ||
      deps.some((value, i) => !Object.is(value, previous.deps?.[i]))
    ) {
      const next = { deps } as typeof previous;
      h.effects[index] = next;
      h.pending.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { AgentPrerequisites } from "./AgentPrerequisites";
import type { PreparationInfo } from "../runtime/preparation";
import { PREPARATION_STRINGS as S } from "../runtime/preparation_strings";
import { STRINGS } from "../runtime/strings";

type Element = ReactElement<Record<string, unknown>>;
function elements(tree: ReactNode) {
  const result: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      result.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function preparation(uvReady = false, pythonReady = false): PreparationInfo {
  return {
    dependencies: [
      {
        id: "uv",
        name: "uv",
        status: uvReady ? "ready" : "missing",
        sourceUrl: "https://docs.astral.sh/uv/",
        installable: true,
        managedLocation: "/owned/tools/uv",
        checkCommand: "uv --version",
        requiredForInstall: true,
        requiredForUse: false,
      },
      {
        id: "python",
        name: "Python",
        status: pythonReady ? "ready" : "missing",
        sourceUrl: "https://docs.astral.sh/uv/guides/install-python/",
        installable: uvReady,
        managedLocation: "/owned/python",
        checkCommand: "python --version",
        requiredForInstall: true,
        requiredForUse: false,
      },
    ],
    links: [],
  };
}
let props: Parameters<typeof AgentPrerequisites>[0];
let current: PreparationInfo;
const ready = vi.fn();
const installReady = vi.fn();
const busy = vi.fn();
const before = vi.fn(async () => {});
const installed = vi.fn(async () => {});
function render() {
  h.cursor = 0;
  const nodes = elements(AgentPrerequisites(props));
  for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
async function settled() {
  let nodes: Element[] = [];
  for (let round = 0; round < 8; round++) {
    nodes = render();
    await Promise.resolve();
  }
  return nodes;
}
function button(nodes: Element[], label: string) {
  return nodes.find(
    (node) => node.type === "button" && node.props.children === label,
  )!;
}
function installer(nodes: Element[], name: string) {
  const row = nodes.find(
    (node) =>
      node.props.className === "agent-setup-program" &&
      elements(node.props.children as ReactNode).some(
        (child) => child.type === "strong" && child.props.children === name,
      ),
  )!;
  return elements(row.props.children as ReactNode).find(
    (node) =>
      node.type === "button" && node.props.className === "btn btn-primary",
  );
}
function click(node: Element) {
  (node.props.onClick as () => void)();
}
function alerts(nodes: Element[]) {
  return nodes
    .filter((node) => node.props.role === "alert")
    .map((node) => node.props.children);
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  vi.clearAllMocks();
  current = preparation();
  h.invoke.mockImplementation(async (command: string) =>
    command === "agent_preparation" ? current : undefined,
  );
  props = {
    agentId: "registry:distribution-sample",
    refreshKey: "unregistered",
    onChange: ready,
    onBusyChange: busy,
    onBeforeInstall: before,
    onInstalled: installed,
    onInstallReadyChange: installReady,
  };
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
});

it("prepares declared tools sequentially before an Agent is registered", async () => {
  const uv = deferred<PreparationInfo>();
  const python = deferred<PreparationInfo>();
  let channel!: { onmessage: (progress: unknown) => void };
  h.invoke.mockImplementation((command: string, args) => {
    if (command !== "agent_dependency_install") return Promise.resolve(current);
    channel = args.onProgress;
    return args.dependencyId === "uv" ? uv.promise : python.promise;
  });
  const initial = await settled();
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(installReady).toHaveBeenLastCalledWith(false);
  expect(installer(initial, "Python")).toBeUndefined();
  const start = installer(initial, "uv")!;
  click(start);
  click(start);
  let nodes = await settled();
  expect(before).not.toHaveBeenCalled();
  expect(installer(nodes, "uv")?.props.disabled).toBe(true);
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "agent_dependency_install"),
  ).toHaveLength(1);
  channel.onmessage({ stage: "download" });
  nodes = await settled();
  expect(
    nodes.some(
      (node) => node.props.children === STRINGS.install.stages.download,
    ),
  ).toBe(true);
  channel.onmessage({ stage: "check" });
  nodes = await settled();
  expect(
    nodes.some((node) => node.props.children === S.installStages.check),
  ).toBe(true);
  expect(
    nodes.some((node) => node.props.children === STRINGS.install.stages.check),
  ).toBe(false);
  uv.resolve(preparation(true));
  nodes = await settled();
  expect(installed).toHaveBeenCalledOnce();
  expect(installReady).toHaveBeenLastCalledWith(false);
  expect(installer(nodes, "uv")).toBeUndefined();
  click(installer(nodes, "Python")!);
  await settled();
  python.resolve(preparation(true, true));
  nodes = await settled();
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(installReady).toHaveBeenLastCalledWith(true);
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(installed).toHaveBeenCalledTimes(2);
  expect(installer(nodes, "Python")).toBeUndefined();
  expect(
    h.invoke.mock.calls.some(
      ([cmd]) =>
        cmd === "agent_install" ||
        cmd === "agent_connect" ||
        cmd === "session_prompt",
    ),
  ).toBe(false);
});

it("keeps cancellation pending until the owned install settles, then allows retry", async () => {
  current = preparation(true);
  const request = deferred<PreparationInfo>();
  h.invoke.mockImplementation((command: string) =>
    command === "agent_dependency_install"
      ? request.promise
      : Promise.resolve(command === "agent_preparation" ? current : undefined),
  );
  click(installer(await settled(), "Python")!);
  let nodes = await settled();
  click(button(nodes, S.cancel));
  nodes = await settled();
  expect(button(nodes, S.cancelling).props.disabled).toBe(true);
  expect(installer(nodes, "Python")?.props.disabled).toBe(true);
  expect(busy).toHaveBeenLastCalledWith(true);
  request.reject(new Error("安装已取消，原设置保持不变"));
  nodes = await settled();
  expect(alerts(nodes)).toContain("安装已取消，原设置保持不变");
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(installer(nodes, "Python")?.props.disabled).toBe(false);
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(installReady).toHaveBeenLastCalledWith(false);

  h.invoke.mockImplementation(async (command: string) =>
    command === "agent_dependency_install" ? preparation(true, true) : current,
  );
  click(installer(nodes, "Python")!);
  expect(alerts(await settled())).toEqual([]);
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(installReady).toHaveBeenLastCalledWith(true);
});

it("keeps a failed dependency lookup visible and rereads only after explicit retry", async () => {
  h.invoke.mockRejectedValueOnce(new Error("准备信息读取失败，请重试"));
  expect(alerts(await settled())).toContain("准备信息读取失败，请重试");
  expect(alerts(await settled())).toContain("准备信息读取失败，请重试");
  expect(h.invoke).toHaveBeenCalledOnce();
  click(button(render(), S.retry));
  expect(installer(await settled(), "uv")).toBeDefined();
  expect(installReady).toHaveBeenLastCalledWith(false);
});

it("retains an installer failure without revoking existing use readiness and permits a new attempt", async () => {
  h.invoke.mockImplementation(async (command: string) => {
    if (command === "agent_dependency_install")
      throw new Error("所需程序下载不完整，请重试");
    return current;
  });
  click(installer(await settled(), "uv")!);
  let nodes = await settled();
  expect(alerts(nodes)).toContain("所需程序下载不完整，请重试");
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(installReady).toHaveBeenLastCalledWith(false);
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(installed).not.toHaveBeenCalled();
  h.invoke.mockImplementation(async () => preparation(true));
  click(installer(nodes, "uv")!);
  nodes = await settled();
  expect(alerts(nodes)).toEqual([]);
  expect(installer(nodes, "Python")?.props.disabled).toBe(false);
  expect(before).not.toHaveBeenCalled();
});

it("preserves legacy use dependencies without inventing an installation prerequisite", async () => {
  const dependency = preparation().dependencies[0];
  delete dependency.requiredForUse;
  delete dependency.requiredForInstall;
  current = { dependencies: [dependency], links: [] };
  await settled();
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(installReady).toHaveBeenLastCalledWith(true);
});

it("keeps an active install owned across a program refresh and checks its final state", async () => {
  const request = deferred<PreparationInfo>();
  h.invoke.mockImplementation((command: string) =>
    command === "agent_dependency_install"
      ? request.promise
      : Promise.resolve(current),
  );
  click(installer(await settled(), "uv")!);
  await settled();
  props.refreshKey = "catalog-refreshed";
  let nodes = await settled();
  expect(installer(nodes, "uv")?.props.disabled).toBe(true);
  expect(button(nodes, S.cancel)).toBeDefined();
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "agent_preparation"),
  ).toHaveLength(1);
  current = preparation(true);
  request.resolve(current);
  nodes = await settled();
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(installer(nodes, "uv")).toBeUndefined();
  expect(installer(nodes, "Python")?.props.disabled).toBe(false);
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "agent_preparation"),
  ).toHaveLength(2);
});

it("does not dispatch an install cancelled while its current-work check is pending", async () => {
  current = {
    dependencies: [
      {
        ...preparation().dependencies[0],
        id: "companion",
        name: "Companion",
        requiredForUse: true,
        requiredForInstall: false,
      },
    ],
    links: [],
  };
  const permission = deferred<void>();
  before.mockImplementationOnce(() => permission.promise);
  click(installer(await settled(), "Companion")!);
  expect(before).toHaveBeenCalledOnce();
  click(button(await settled(), S.cancel));
  expect(button(await settled(), S.cancelling).props.disabled).toBe(true);
  permission.resolve();
  const nodes = await settled();
  expect(installer(nodes, "Companion")?.props.disabled).toBe(false);
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(
    h.invoke.mock.calls.some(([cmd]) => cmd === "agent_dependency_install"),
  ).toBe(false);
  expect(installed).not.toHaveBeenCalled();
});

it("cancels the old target and ignores its late result when another entry replaces it", async () => {
  const request = deferred<PreparationInfo>();
  h.invoke.mockImplementation((command: string) =>
    command === "agent_dependency_install"
      ? request.promise
      : Promise.resolve(current),
  );
  click(installer(await settled(), "uv")!);
  await settled();
  const oldAgent = props.agentId;
  current = preparation(true, true);
  props.agentId = "registry:other-distribution";
  await settled();
  expect(
    h.invoke.mock.calls.some(
      ([cmd, args]) =>
        cmd === "agent_dependency_cancel" &&
        args.agentId === oldAgent &&
        !!args.requestId,
    ),
  ).toBe(true);
  request.resolve(preparation());
  const nodes = await settled();
  expect(installer(nodes, "uv")).toBeUndefined();
  expect(installer(nodes, "Python")).toBeUndefined();
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(installReady).toHaveBeenLastCalledWith(true);
  expect(installed).not.toHaveBeenCalled();
});

function versionedProgram(
  state: "satisfied" | "unsatisfied" | "unknown" = "unsatisfied",
): PreparationInfo {
  return {
    dependencies: [
      {
        ...preparation().dependencies[0],
        id: "program",
        name: "Example program",
        status: "ready",
        requiredForUse: true,
        requiredForInstall: false,
        programVersion: state === "unknown" ? null : "0.80.5",
        componentVersion: "0.0.34",
        versionRequirement: {
          componentVersion: "0.0.34",
          range: ">=0.81.0",
          sourceUrl: "https://example.test/component/release/requirements",
          state,
        },
        canInstallCandidate: true,
      },
    ],
    links: [],
  };
}
const paragraphs = (nodes: Element[]) =>
  nodes
    .filter((node) => node.type === "p")
    .flatMap((node) => Children.toArray(node.props.children as ReactNode))
    .join("");

it.each(["satisfied", "unsatisfied", "unknown"] as const)(
  "shows the declared %s version diagnostic without blocking an executable program",
  async (state) => {
    current = versionedProgram(state);
    const nodes = await settled();
    const text = paragraphs(nodes);
    expect(text).toContain(S.programVersion);
    expect(text).toContain(state === "unknown" ? S.unknownVersion : "0.80.5");
    expect(text).toContain(S.componentVersion);
    expect(text).toContain("0.0.34");
    expect(text).toContain(">=0.81.0");
    expect(text).toContain(S.versionStates[state]);
    expect(button(nodes, S.requirementSource)).toBeDefined();
    expect(ready).toHaveBeenLastCalledWith(true);
    expect(installReady).toHaveBeenLastCalledWith(true);
    expect(
      h.invoke.mock.calls.some(([cmd]) => cmd !== "agent_preparation"),
    ).toBe(false);
    click(button(nodes, S.retry));
    await settled();
    expect(h.invoke).toHaveBeenLastCalledWith("agent_preparation", {
      agentId: props.agentId,
      refresh: true,
    });
  },
);

it("prepares an unselected candidate while retaining current use and installs only once", async () => {
  current = versionedProgram();
  const request = deferred<PreparationInfo>();
  let channel!: { onmessage: (progress: unknown) => void };
  h.invoke.mockImplementation((command: string, args) => {
    if (command === "agent_dependency_install") {
      channel = args.onProgress;
      return request.promise;
    }
    return Promise.resolve(current);
  });
  const initial = await settled();
  expect(button(initial, S.install)).toBeUndefined();
  const candidate = button(initial, S.installCandidate);
  expect(candidate).toBeDefined();
  click(candidate);
  click(candidate);
  await settled();
  expect(before).not.toHaveBeenCalled();
  expect(ready).toHaveBeenLastCalledWith(true);
  expect(
    h.invoke.mock.calls.filter(([cmd]) => cmd === "agent_dependency_install"),
  ).toHaveLength(1);
  expect(h.invoke).toHaveBeenLastCalledWith(
    "agent_dependency_install",
    expect.objectContaining({
      mode: "prepare_candidate",
      dependencyId: "program",
    }),
  );
  channel.onmessage({ stage: "ready" });
  expect(
    (await settled()).some(
      (node) => node.props.children === S.candidateInstalled,
    ),
  ).toBe(true);
  request.resolve(current);
  const nodes = await settled();
  expect(paragraphs(nodes)).toContain(S.candidateInstalled);
  expect(paragraphs(nodes)).toContain("0.80.5");
  expect(installed).toHaveBeenCalledOnce();
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(
    h.invoke.mock.calls.some(([cmd]) =>
      [
        "agent_disconnect",
        "agent_installation_select",
        "session_open",
        "session_prompt",
      ].includes(cmd),
    ),
  ).toBe(false);
});

it("keeps candidate cancellation owned through the result and allows a retry without changing the selected program", async () => {
  current = versionedProgram();
  const request = deferred<PreparationInfo>();
  h.invoke.mockImplementation((command: string) =>
    command === "agent_dependency_install"
      ? request.promise
      : Promise.resolve(current),
  );
  click(button(await settled(), S.installCandidate));
  click(button(await settled(), S.cancel));
  let nodes = await settled();
  expect(button(nodes, S.cancelling).props.disabled).toBe(true);
  expect(busy).toHaveBeenLastCalledWith(true);
  request.reject(new Error("候选安装已取消，原选择已保留"));
  nodes = await settled();
  expect(alerts(nodes)).toContain("候选安装已取消，原选择已保留");
  expect(paragraphs(nodes)).toContain("0.80.5");
  expect(paragraphs(nodes)).not.toContain(S.candidateInstalled);
  expect(installed).not.toHaveBeenCalled();
  expect(button(nodes, S.installCandidate).props.disabled).toBe(false);
  h.invoke.mockImplementation(async () => current);
  click(button(nodes, S.installCandidate));
  nodes = await settled();
  expect(alerts(nodes)).toEqual([]);
  expect(paragraphs(nodes)).toContain(S.candidateInstalled);
  expect(before).not.toHaveBeenCalled();
});

it("retains a successfully installed candidate if refreshing its program list fails", async () => {
  current = versionedProgram();
  h.invoke.mockImplementation(async () => current);
  installed.mockRejectedValueOnce(new Error("list-refresh-fixture"));
  click(button(await settled(), S.installCandidate));
  const nodes = await settled();
  expect(paragraphs(nodes)).toContain(S.candidateInstalled);
  expect(alerts(nodes)).toContain(S.refreshProgramsFailed);
  expect(ready).toHaveBeenLastCalledWith(true);
});

it("does not invent a version rule or an installation action for an undeclared program", async () => {
  current = versionedProgram("unknown");
  const dependency = current.dependencies[0];
  dependency.versionRequirement = null;
  dependency.componentVersion = null;
  dependency.canInstallCandidate = false;
  const nodes = await settled();
  expect(paragraphs(nodes)).not.toContain(S.officialRequirement);
  expect(button(nodes, S.installCandidate)).toBeUndefined();
  expect(button(nodes, S.install)).toBeUndefined();
  expect(ready).toHaveBeenLastCalledWith(true);
});
