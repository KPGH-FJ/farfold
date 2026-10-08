import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown }[],
  logout: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        slot.value =
          typeof next === "function"
            ? (next as (v: unknown) => unknown)(slot.value)
            : next;
      },
    ];
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage?: (chunk: unknown) => void;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../runtime/agents", () => ({
  agentLogout: h.logout,
}));
import { AgentRemoveDialog } from "./AgentRemoveDialog";
import type { Installation } from "./ProgramManager";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";

type Element = ReactElement<Record<string, unknown>>;
const card: AgentCardModel = {
  id: "a",
  name: "Agent A",
  description: "",
  status: "connected",
  version: "1.0.0",
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: "registry",
  installable: true,
  registerable: false,
  custom: false,
  handshake: null,
};
const managedInstall: Installation = {
  id: "m1",
  source: "registry",
  path: "/farfold/programs/one",
  version: "1.0.0",
  managedRoot: "/farfold/programs/one",
  programOnly: true,
  selected: false,
  inUse: false,
  canUninstall: true,
};
const externalInstall: Installation = {
  id: "x1",
  source: "external",
  path: "/opt/agent",
  version: "2.0.0",
  managedRoot: null,
  programOnly: true,
  selected: true,
  inUse: false,
  canUninstall: false,
};
const busyInstall: Installation = {
  id: "m2",
  source: "registry",
  path: "/farfold/programs/in-use",
  version: "0.9.0",
  managedRoot: "/farfold/programs/in-use",
  programOnly: true,
  selected: false,
  inUse: true,
  canUninstall: false,
};
let agents: AgentsState;
let props: ComponentProps<typeof AgentRemoveDialog>;
function render() {
  h.cursor = 0;
  const tree = AgentRemoveDialog(props);
  const elements: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return elements;
}
function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string"
        ? child
        : isValidElement<{ children: ReactNode }>(child)
          ? text(child.props.children)
          : "",
    )
    .join("");
}
function checkboxes() {
  return render().filter(
    (node) => node.type === "input" && node.props.type === "checkbox",
  );
}
beforeEach(() => {
  h.slots = [];
  h.logout.mockReset();
  agents = {
    busy: {},
    errors: {},
    remove: vi.fn(async () => ({ removed: true, keptInstallations: [] })),
  } as unknown as AgentsState;
  props = {
    card,
    agents,
    inventory: {
      items: [managedInstall, externalInstall, busyInstall],
    } as never,
    cwd: "/work",
    canLogout: true,
    blocked: false,
    onClose: vi.fn(),
    onRemoved: vi.fn(),
  };
});

it("lists only Farfold-managed installs individually and forwards the chosen ones", async () => {
  const nodes = render();
  const all = text(nodes.map((node) => node.props.children as ReactNode));
  expect(all).toContain("/farfold/programs/one");
  expect(all).not.toContain("/opt/agent");
  // An in-use managed install is listed as kept, never with a checkbox.
  expect(all).toContain("/farfold/programs/in-use");
  expect(all).toContain(STRINGS.access.inUse);
  expect(all).toContain(STRINGS.access.removeHistoryNote);
  expect(
    nodes.some(
      (node) =>
        node.type === "legend" &&
        node.props.children === STRINGS.access.removeUninstall,
    ),
  ).toBe(true);
  // Sign-out is offered because the live declaration supports it.
  expect(checkboxes()).toHaveLength(2);

  // Choose the managed install; leave sign-out unchecked.
  (checkboxes()[0].props.onChange as () => void)();
  const confirm = render().find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.access.confirmRemove,
  )!;
  (confirm.props.onClick as () => void)();
  await Promise.resolve();
  expect(agents.remove).toHaveBeenCalledExactlyOnceWith("a", {
    uninstall: ["m1"],
  });
  expect(h.logout).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(props.onRemoved).toHaveBeenCalledOnce());
});

it("hides sign-out without a supported declaration or live directory", () => {
  props.canLogout = false;
  expect(checkboxes()).toHaveLength(1);
  props.canLogout = true;
  props.cwd = null;
  expect(checkboxes()).toHaveLength(1);
});

it("signs out before removal and reports an unconfirmed exit instead of removing", async () => {
  h.logout.mockImplementation(async (_id: string, options: unknown) => {
    const { onOutput } = options as {
      onOutput: { onmessage?: (chunk: unknown) => void };
    };
    onOutput.onmessage?.({ authStatus: "unknown" });
  });
  // The sign-out checkbox is the second one (after the managed install).
  (checkboxes()[1].props.onChange as (e: unknown) => void)({
    target: { checked: true },
  });
  const confirm = render().find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.access.confirmRemove,
  )!;
  (confirm.props.onClick as () => void)();
  await vi.waitFor(() => expect(h.logout).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(
      render().some(
        (node) =>
          node.props.role === "alert" &&
          node.props.children === STRINGS.access.removeSignOutUnknown,
      ),
    ).toBe(true),
  );
  expect(agents.remove).not.toHaveBeenCalled();
  expect(props.onRemoved).not.toHaveBeenCalled();
});

it("locks every control while work is in flight", () => {
  props.blocked = true;
  const nodes = render();
  const confirm = nodes.find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.access.confirmRemove,
  )!;
  expect(confirm.props.disabled).toBe(true);
  (confirm.props.onClick as () => void)();
  expect(agents.remove).not.toHaveBeenCalled();
  expect(
    nodes.some((node) => node.props.children === STRINGS.access.removeBusy),
  ).toBe(true);
});

it("does not close on a partial backend outcome and lets the hub surface kept installs", async () => {
  agents.remove = vi.fn(async () => ({
    removed: false,
    keptInstallations: ["/farfold/programs/one（仍在使用）"],
  }));
  const confirm = render().find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.access.confirmRemove,
  )!;
  (confirm.props.onClick as () => void)();
  await vi.waitFor(() => expect(agents.remove).toHaveBeenCalledOnce());
  expect(props.onRemoved).not.toHaveBeenCalled();
});
