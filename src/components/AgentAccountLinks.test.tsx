import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { PreparationLink } from "../runtime/preparation";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  links: [] as PreparationLink[],
  open: vi.fn(async (_url: string) => {}),
  focus: [] as (() => void)[],
  visible: [] as (() => void)[],
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.open }));
vi.mock("../runtime/preparation", async (original) => ({
  ...(await original<typeof import("../runtime/preparation")>()),
  getAgentPreparation: vi.fn(async () => ({ links: h.links })),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
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
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = index === 0 ? h.links : initial;
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
}));
import { AgentAccountLinks } from "./AgentAccountLinks";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";

type Element = ReactElement<Record<string, unknown>>;
function render(
  agentId = "first",
  methodIds = ["login"],
  extra: Partial<ComponentProps<typeof AgentAccountLinks>> = {},
) {
  h.cursor = 0;
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(
    AgentAccountLinks({
      agentId,
      methodIds,
      agentName: "Example",
      ...extra,
    }),
  );
  for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
function buttonWith(nodes: Element[], label: string) {
  return nodes.find(
    (node) =>
      node.type === "button" &&
      Children.toArray(node.props.children as ReactNode).includes(label),
  );
}
async function opened() {
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.focus = [];
  h.visible = [];
  h.open.mockReset().mockResolvedValue(undefined);
  h.links = [
    {
      label: "Official page",
      url: "https://example.com/docs",
      kind: "documentation",
    },
  ];
  vi.stubGlobal("window", {
    addEventListener: (name: string, fn: () => void) => {
      if (name === "focus") h.focus.push(fn);
    },
    removeEventListener: () => {},
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (name: string, fn: () => void) => {
      if (name === "visibilitychange") h.visible.push(fn);
    },
    removeEventListener: () => {},
  });
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
  vi.unstubAllGlobals();
});

it("shows one account link as the official registration entry", () => {
  h.links = [
    { label: "Sign up", url: "https://example.com/signup", kind: "account" },
  ];
  const nodes = render();
  const entry = buttonWith(nodes, G.register)!;
  expect(entry).toBeDefined();
  (entry.props.onClick as () => void)();
  expect(h.open).toHaveBeenCalledExactlyOnceWith("https://example.com/signup");
});

it("lists account hostnames when several registration links exist", () => {
  h.links = [
    { label: "One", url: "https://one.example.com/signup", kind: "account" },
    { label: "Two", url: "https://two.example.com/join", kind: "account" },
  ];
  const nodes = render();
  expect(
    nodes.some(
      (node) =>
        node.type === "span" &&
        Children.toArray(node.props.children as ReactNode).includes(
          G.registerChoose,
        ),
    ),
  ).toBe(true);
  for (const host of ["one.example.com", "two.example.com"]) {
    const entry = buttonWith(nodes, host)!;
    expect(entry).toBeDefined();
  }
  (buttonWith(nodes, "two.example.com")!.props.onClick as () => void)();
  expect(h.open).toHaveBeenCalledExactlyOnceWith(
    "https://two.example.com/join",
  );
});

it("falls back to the Agent website when no account link is declared", () => {
  h.links = [];
  const nodes = render("first", ["login"], {
    websiteUrl: "https://agent.example/",
  });
  const entry = buttonWith(nodes, G.registerSite("Example"))!;
  expect(entry).toBeDefined();
  (entry.props.onClick as () => void)();
  expect(h.open).toHaveBeenCalledExactlyOnceWith("https://agent.example/");
});

it("shows plain channel guidance when no usable URL exists", () => {
  h.links = [];
  const nodes = render("first", ["login"], { websiteUrl: null });
  expect(
    nodes.some((node) => node.props.children === G.registerChannels("Example")),
  ).toBe(true);
  expect(nodes.some((node) => node.type === "button")).toBe(false);
});

it("keeps account links scoped to the requested methods and https URLs", async () => {
  h.links = [
    {
      label: "Other method",
      url: "https://example.com/other",
      kind: "account",
      methodIds: ["unrelated"],
    },
    {
      label: "Insecure",
      url: "http://insecure.example.com",
      kind: "account",
    },
    {
      label: "Sign up",
      url: "https://example.com/signup",
      kind: "account",
      methodIds: ["login"],
    },
  ];
  render();
  await opened();
  const nodes = render();
  expect(buttonWith(nodes, G.register)).toBeDefined();
  expect(buttonWith(nodes, "Insecure")).toBeUndefined();
  (buttonWith(nodes, G.register)!.props.onClick as () => void)();
  expect(h.open).toHaveBeenCalledExactlyOnceWith("https://example.com/signup");
});

it("shows documentation links as a small notes entry that does not arm the return check", async () => {
  const onReturn = vi.fn();
  const nodes = render("first", ["login"], { onReturn });
  const doc = buttonWith(nodes, G.docs)!;
  expect(doc).toBeDefined();
  (doc.props.onClick as () => void)();
  await opened();
  expect(h.open).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
  for (const listener of h.focus) listener();
  expect(onReturn).not.toHaveBeenCalled();
});

it("runs the return check exactly once after a registration page was opened", async () => {
  h.links = [
    { label: "Sign up", url: "https://example.com/signup", kind: "account" },
  ];
  const onReturn = vi.fn();
  const nodes = render("first", ["login"], { onReturn });
  for (const listener of h.focus) listener();
  expect(onReturn).not.toHaveBeenCalled();
  (buttonWith(nodes, G.register)!.props.onClick as () => void)();
  await opened();
  for (const listener of h.focus) listener();
  for (const listener of h.focus) listener();
  for (const listener of h.visible) listener();
  expect(onReturn).toHaveBeenCalledTimes(1);
});

it("ignores an external-page failure after the target changes", async () => {
  let reject!: (reason: unknown) => void;
  h.open.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const nodes = render();
  (buttonWith(nodes, G.docs)!.props.onClick as () => void)();
  render("first", ["other-method"]);
  reject(new Error("Old page could not open"));
  await opened();
  expect(
    render("first", ["other-method"]).some(
      (node) => node.props.role === "alert",
    ),
  ).toBe(false);
  expect(h.open).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
});

it("still shows an external-page failure for the current target", async () => {
  h.open.mockRejectedValue(new Error("Current page could not open"));
  const nodes = render();
  (buttonWith(nodes, G.docs)!.props.onClick as () => void)();
  await opened();
  expect(render().some((node) => node.props.role === "alert")).toBe(true);
});

it("disables all entries while the surrounding flow is busy", () => {
  h.links = [
    { label: "Sign up", url: "https://example.com/signup", kind: "account" },
    { label: "Docs", url: "https://example.com/docs", kind: "documentation" },
  ];
  const nodes = render("first", ["login"], { disabled: true });
  for (const label of [G.register, G.docs])
    expect(buttonWith(nodes, label)!.props.disabled).toBe(true);
  (buttonWith(nodes, G.register)!.props.onClick as () => void)();
  expect(h.open).not.toHaveBeenCalled();
});
