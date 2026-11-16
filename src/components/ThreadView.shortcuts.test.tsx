import { afterEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";

const h = vi.hoisted(() => ({ effects: [] as (() => unknown)[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [initial, () => {}],
  useMemo: (read: () => unknown) => read(),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  useEffect: (effect: () => unknown) => h.effects.push(effect),
}));
// These tests invoke ThreadView with a minimal hook harness; browser permissions
// have their own controller/component tests and are absent from these scenarios.
vi.mock("../runtime/browser_sharing", async (original) => {
  const actual = await original<typeof import("../runtime/browser_sharing")>();
  const noop = async () => {};
  const empty: import("../runtime/browser_sharing").BrowserSharingModel = {
    info: null,
    pendingRequest: null,
    operation: null,
    error: "",
    notice: "",
    ready: false,
    queryState: "no_session",
    refresh: noop,
    connect: noop,
    allow: noop,
    stop: noop,
    respond: noop,
  };
  return { ...actual, useBrowserSharing: () => empty };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));

import { ThreadView } from "./ThreadView";
import { threads } from "../runtime/sessions";
import { freshThreadState } from "../runtime/session_projection";

afterEach(() => {
  h.effects.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("does not approve the covered conversation from a body-targeted shortcut while its main area is inert", () => {
  const listeners: ((event: KeyboardEvent) => void)[] = [];
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("window", {
    addEventListener: (
      kind: string,
      listener: (event: KeyboardEvent) => void,
    ) => {
      if (kind === "keydown") listeners.push(listener);
    },
    removeEventListener: () => {},
  });
  const thread = freshThreadState(
    "a:/p:covered-approval",
    "a",
    "/p",
    "covered-approval",
  );
  thread.pendingPermissions = [
    {
      requestId: "request",
      status: "pending",
      error: null,
      toolCallId: null,
      title: "Command",
      kind: "execute",
      locations: [],
      decision: null,
      options: [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "remember", name: "Remember", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  ];
  let inert = true;
  const transcript = {
    scrollTop: 0,
    scrollHeight: 0,
    closest: (selector: string) =>
      selector === "[inert]" && inert ? {} : null,
  };
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      if (child.props.className === "transcript")
        (child.props.ref as { current: unknown }).current = transcript;
      visit(child.props.children as ReactNode);
    });
  visit(
    ThreadView({
      thread,
      active: true,
      agents: [],
      onGoSettings: () => {},
      onOpened: () => {},
    }),
  );
  const decide = vi
    .spyOn(threads, "decidePermission")
    .mockImplementation(() => {});
  for (const effect of h.effects.splice(0)) effect();
  const preventDefault = vi.fn();
  for (const event of [
    { key: "Enter" },
    { key: "Enter", metaKey: true },
    { key: "Backspace" },
  ]) {
    for (const listener of listeners)
      listener({
        ...event,
        target: { closest: () => null },
        preventDefault,
      } as unknown as KeyboardEvent);
  }
  expect(decide).not.toHaveBeenCalled();
  expect(preventDefault).not.toHaveBeenCalled();
  inert = false;
  thread.stopping = true;
  for (const listener of listeners)
    listener({
      key: "Enter",
      metaKey: true,
      target: { closest: () => null },
      preventDefault,
    } as unknown as KeyboardEvent);
  expect(decide).not.toHaveBeenCalled();
  thread.stopping = false;
  thread.stopUnconfirmed = true;
  for (const listener of listeners)
    listener({
      key: "Enter",
      metaKey: true,
      target: { closest: () => null },
      preventDefault,
    } as unknown as KeyboardEvent);
  expect(decide).not.toHaveBeenCalled();
  thread.stopUnconfirmed = false;
  // A bare Enter never approves; the platform primary modifier is required.
  for (const listener of listeners)
    listener({
      key: "Enter",
      target: { closest: () => null },
      preventDefault,
    } as unknown as KeyboardEvent);
  expect(decide).not.toHaveBeenCalled();
  for (const listener of listeners)
    listener({
      key: "Enter",
      metaKey: true,
      target: { closest: () => null },
      preventDefault,
    } as unknown as KeyboardEvent);
  expect(decide).toHaveBeenCalledWith(
    thread.key,
    "request",
    "once",
    expect.any(String),
    true,
    false,
  );
});
