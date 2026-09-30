import { beforeEach, expect, it, vi } from "vitest";
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
  links: [] as PreparationLink[],
  open: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.open }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  // Start with the already returned links; only the external-page promise is
  // under test. Hooks retain one mounted component across target changes.
  useEffect: () => {},
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
import { AgentRegistration } from "./AgentRegistration";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";

type Element = ReactElement<Record<string, unknown>>;
function render(
  agentId = "first",
  methodId = "login",
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
  visit(AgentAccountLinks({ agentId, methodId, ...extra }));
  return nodes;
}
function openLink() {
  const button = render().find(
    (node) =>
      node.type === "button" &&
      Children.toArray(node.props.children as ReactNode).includes(
        "Official page",
      ),
  )!;
  (button.props.onClick as () => void)();
}
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.open.mockReset();
  h.links = [
    {
      label: "Official page",
      url: "https://example.com/docs",
      kind: "documentation",
    },
  ];
});

it.each([
  ["other-agent", "login"],
  ["first", "other-method"],
])(
  "ignores a documentation failure after the target changes to %s/%s",
  async (agent, method) => {
    let reject!: (reason: unknown) => void;
    h.open.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    openLink();
    render(agent, method);
    reject(new Error("Old page could not open"));
    await Promise.resolve();
    await Promise.resolve();
    expect(
      render(agent, method).some((node) => node.props.role === "alert"),
    ).toBe(false);
    expect(h.open).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
  },
);

it("still shows an external-page failure for the current target", async () => {
  h.open.mockRejectedValue(new Error("Current page could not open"));
  openLink();
  await Promise.resolve();
  await Promise.resolve();
  expect(render().some((node) => node.props.role === "alert")).toBe(true);
});

it("retains the verified registration page across temporary hiding without opening or logging in", () => {
  h.links = [
    {
      kind: "account",
      label: "Official account",
      url: "https://example.com/account",
    },
  ];
  const registration = {
    methodId: "login",
    url: "https://example.com/account",
    page: "returned" as const,
  };
  const onRegistrationChange = vi.fn(),
    onContinueLogin = vi.fn();
  const extra = { registration, onRegistrationChange, onContinueLogin };
  expect(
    render("first", "login", extra).find(
      (node) => node.type === AgentRegistration,
    )?.props.progress,
  ).toEqual(registration);
  expect(
    render("first", "login", { ...extra, active: false }).some(
      (node) => node.type === AgentRegistration,
    ),
  ).toBe(false);
  expect(
    render("first", "login", extra).find(
      (node) => node.type === AgentRegistration,
    )?.props.progress,
  ).toEqual(registration);
  expect(h.open).not.toHaveBeenCalled();
  expect(onRegistrationChange).not.toHaveBeenCalled();
  expect(onContinueLogin).not.toHaveBeenCalled();
  expect(
    render("first", "other-method", extra).some(
      (node) => node.type === AgentRegistration,
    ),
  ).toBe(false);
});

it("passes the actual pointer opener to the registration dialog for focus return", () => {
  h.links = [
    {
      kind: "account",
      label: "Official account",
      url: "https://example.com/account",
    },
  ];
  const opener = {} as HTMLButtonElement;
  const button = render().find(
    (node) => node.type === "button" && node.props.children === G.create,
  )!;
  (
    button.props.onClick as (event: {
      currentTarget: HTMLButtonElement;
    }) => void
  )({ currentTarget: opener });
  const dialog = render().find((node) => node.type === AgentRegistration)!;
  expect((dialog.props.returnFocusRef as { current: unknown }).current).toBe(
    opener,
  );
  expect(h.open).not.toHaveBeenCalled();
});
