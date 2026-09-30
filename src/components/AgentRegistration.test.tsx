import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AccountRegistrationProgress } from "../runtime/account_registration";
import type { PreparationLink } from "../runtime/preparation";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  cleanup: [] as (() => void)[],
  open: vi.fn(),
  login: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.open }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [
      h.slots[i],
      (value: unknown) => {
        h.slots[i] = value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = { current: initial };
    return h.slots[i];
  },
  useEffect: (fn: () => () => void) => {
    const i = h.cursor++;
    if (!(i in h.slots)) {
      h.slots[i] = true;
      h.cleanup.push(fn());
    }
  },
}));
import { AgentRegistration } from "./AgentRegistration";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";
type El = ReactElement<Record<string, unknown>>;
let progress: AccountRegistrationProgress;
function view(disabled = false, links?: PreparationLink[]): El[] {
  h.cursor = 0;
  const all: El[] = [];
  const visit = (tree: ReactNode) =>
    Children.forEach(tree, (node) => {
      if (isValidElement<Record<string, unknown>>(node)) {
        all.push(node);
        visit(node.props.children as ReactNode);
      }
    });
  visit(
    AgentRegistration({
      links: links ?? [
        {
          kind: "account",
          label: "Verified account",
          url: "https://account.example.com/",
        },
      ],
      progress,
      onProgress: (value) => {
        progress = value;
      },
      onClose: h.close,
      onLogin: h.login,
      loginDisabled: disabled,
      loginHint: "Finish related work",
    }),
  );
  return all;
}
function button(label: string, disabled = false) {
  return view(disabled).find(
    (n) =>
      n.type === "button" &&
      Children.toArray(n.props.children as ReactNode).includes(label),
  )!;
}
const click = (node: El) => (node.props.onClick as () => void)();
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.cleanup = [];
  h.open.mockReset().mockResolvedValue(undefined);
  h.login.mockReset();
  h.close.mockReset();
  progress = { methodId: "method", url: "", page: "choose" };
});

it("shows account preparation guidance without an imaginary account choice when only documentation is provided", () => {
  const nodes = view(false, [
    {
      kind: "documentation",
      label: "Official guide",
      url: "https://example.com/docs",
    },
  ]);
  expect(nodes.some((node) => node.props.title === G.accountInfo)).toBe(true);
  expect(nodes.some((node) => node.props.children === G.prepareAccount)).toBe(
    true,
  );
  expect(nodes.some((node) => node.props.children === G.chooseAccount)).toBe(
    false,
  );
  expect(nodes.some((node) => node.props.children === G.openAccount)).toBe(
    false,
  );
  expect(
    nodes.some(
      (node) =>
        node.type === "button" && node.props.children === G.continueLogin,
    ),
  ).toBe(true);
  expect(h.open).not.toHaveBeenCalled();
  expect(h.login).not.toHaveBeenCalled();
});
it("separates opening the verified account page, returning, and explicit login", async () => {
  view();
  expect(h.open).not.toHaveBeenCalled();
  expect(h.login).not.toHaveBeenCalled();
  click(button(G.openAccount));
  await settle();
  expect(h.open).toHaveBeenCalledExactlyOnceWith(
    "https://account.example.com/",
  );
  expect(progress.page).toBe("external");
  expect(h.login).not.toHaveBeenCalled();
  click(button(G.returned));
  expect(progress.page).toBe("returned");
  expect(h.login).not.toHaveBeenCalled();
  click(button(G.continueLogin));
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.login).toHaveBeenCalledOnce();
});
it("keeps a restored return page blocked until related work or source restrictions permit login", () => {
  progress = {
    methodId: "method",
    url: "https://account.example.com/",
    page: "returned",
  };
  expect(button(G.continueLogin, true).props.disabled).toBe(true);
  click(button(G.continueLogin, true));
  expect(h.open).not.toHaveBeenCalled();
  expect(h.login).not.toHaveBeenCalled();
  expect(h.close).not.toHaveBeenCalled();
});
it("does not revive a closed registration page when an external open finishes late", async () => {
  let resolve!: () => void;
  h.open.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  click(button(G.openAccount));
  click(button(G.backLogin));
  resolve();
  await settle();
  expect(progress.page).toBe("choose");
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.login).not.toHaveBeenCalled();
});
it("shows an open failure without marking return or starting login", async () => {
  h.open.mockRejectedValue(Error("open failed"));
  click(button(G.openAccount));
  await settle();
  expect(view().some((node) => node.props.role === "alert")).toBe(true);
  expect(progress.page).toBe("choose");
  expect(h.login).not.toHaveBeenCalled();
});

it("finishes reopening the official page before allowing return and never leaves login stuck busy", async () => {
  progress = {
    methodId: "method",
    url: "https://account.example.com/",
    page: "external",
  };
  let resolve!: () => void;
  h.open.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  click(button(G.retryOpen));
  const returned = button(G.returned);
  expect(returned.props.disabled).toBe(true);
  click(returned);
  expect(progress.page).toBe("external");
  resolve();
  await settle();
  expect(button(G.returned).props.disabled).toBe(false);
  click(button(G.returned));
  expect(progress.page).toBe("returned");
  expect(button(G.continueLogin).props.disabled).toBe(false);
  expect(h.login).not.toHaveBeenCalled();
  click(button(G.continueLogin));
  expect(h.login).toHaveBeenCalledOnce();
});
