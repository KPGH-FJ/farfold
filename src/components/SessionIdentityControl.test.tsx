import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  refs: [] as { current: unknown }[],
  cursor: 0,
  cleanups: [] as (() => void)[],
  status: undefined as undefined | ((event: { payload: unknown }) => void),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) =>
    h.refs[h.cursor++] ?? (h.refs[h.cursor - 1] = { current: value }),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
  useLayoutEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) h.cleanups.push(cleanup);
  },
}));
import { SessionIdentityControl } from "./SessionIdentityControl";
import {
  freshThreadState,
  threads,
  type ThreadState,
} from "../runtime/sessions";
import { CONNECTION_ACCOUNT_STRINGS } from "../runtime/connection_account_strings";

const S = CONNECTION_ACCOUNT_STRINGS.currentIdentity;
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  const result: Node[] = [];
  Children.forEach(value, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
function draw(thread: ThreadState, active = true) {
  h.cursor = 0;
  return SessionIdentityControl({ thread, active });
}
function click(thread: ThreadState) {
  const button = nodes(draw(thread)).find((node) => node.type === "button");
  expect(button).toBeDefined();
  (button!.props.onClick as () => void)();
  return button!;
}
function owner() {
  const value = freshThreadState("owner", "fixture", "/own", "native");
  value.connectionId = "connection";
  value.identityRead = { provenance: "reviewed-official-supplement" };
  vi.spyOn(threads, "thread").mockImplementation((key) =>
    key === value.key ? value : undefined,
  );
  return value;
}
const reply = () => ({
  connectionId: "connection",
  nativeSessionId: "native",
  cwd: "/own",
  identity: {
    email: "person@example.test",
    displayName: "Person",
    workspaceName: null,
    organizationName: null,
  },
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
beforeEach(() => {
  h.refs = [];
  h.cleanups = [];
  h.cursor = 0;
  h.status = undefined;
  h.invoke.mockReset().mockResolvedValue(reply());
  h.listen.mockReset().mockImplementation(async (name, callback) => {
    if (name === "agent:status") h.status = callback;
    return () => {};
  });
});
afterEach(() => {
  for (const cleanup of h.cleanups) cleanup();
  vi.restoreAllMocks();
});

it("does not read on render, uses one explicit action and preserves the existing queue and source", async () => {
  const thread = owner();
  thread.serviceContext = "kept-source";
  thread.queuePaused = "stopped";
  const queued = thread.queued;
  const initial = draw(thread);
  expect(renderToStaticMarkup(initial!)).toContain(S.read);
  expect(h.invoke).not.toHaveBeenCalled();
  click(thread);
  await flush();
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("session_identity_read", {
    agentId: "fixture",
    cwd: "/own",
    sessionId: "native",
    connectionId: "connection",
  });
  const markup = renderToStaticMarkup(draw(thread)!);
  expect(markup).toContain("person@example.test · Person");
  expect(markup).toContain("可能来自缓存");
  expect(markup).not.toContain(">账号登录<");
  expect(thread.serviceContext).toBe("kept-source");
  expect(thread.queued).toBe(queued);
  expect(thread.queuePaused).toBe("stopped");
});

it("keeps actual busy/unknown work disabled without an implicit prepare or query", () => {
  const thread = owner();
  thread.connectionOutcomeUnknown = true;
  const button = nodes(draw(thread)).find((node) => node.type === "button")!;
  expect(button.props.disabled).toBe(true);
  (button.props.onClick as () => void)();
  expect(h.invoke).not.toHaveBeenCalled();
  expect(thread.connectionOutcomeUnknown).toBe(true);
});

it("coalesces actual double clicks and discards a response after unmount with the same owner still registered", async () => {
  const thread = owner();
  let resolve!: (value: unknown) => void;
  h.invoke.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const button = click(thread);
  (button.props.onClick as () => void)();
  expect(h.invoke).toHaveBeenCalledTimes(1);
  for (const cleanup of h.cleanups.splice(0)) cleanup();
  resolve(reply());
  await flush();
  expect(thread.sessionIdentityRead).toBeUndefined();
  expect(thread.connectionOutcomeUnknown).toBe(false);
});

it("does not publish a late reply to a replacement conversation", async () => {
  const thread = owner();
  let resolve!: (value: unknown) => void;
  h.invoke.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  click(thread);
  const replacement = {
    ...thread,
    key: "new-owner",
    nativeSessionId: "new-native",
    sessionIdentityRead: undefined,
  };
  vi.mocked(threads.thread).mockReturnValue(replacement);
  resolve(reply());
  await flush();
  expect(replacement.sessionIdentityRead).toBeUndefined();
  expect(thread.sessionIdentityRead).toBeUndefined();
});

it("clears only the affected identity when its account report changes, not a sibling's status", async () => {
  const thread = owner();
  click(thread);
  await flush();
  const reported = thread.sessionIdentityRead;
  h.status!({
    payload: {
      agentId: "fixture",
      cwd: "/own",
      connectionId: "sibling",
      state: "ready",
      account: { kind: "none" },
    },
  });
  expect(thread.sessionIdentityRead).toBe(reported);
  h.status!({
    payload: {
      agentId: "fixture",
      cwd: "/own",
      connectionId: "connection",
      state: "ready",
      account: { kind: "none" },
    },
  });
  expect(thread.sessionIdentityRead).toBeUndefined();
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("shows empty/failed reads as not-provided or a safe error, never raw diagnostics or logged out", async () => {
  const thread = owner();
  h.invoke.mockResolvedValue({ ...reply(), identity: null });
  click(thread);
  await flush();
  expect(renderToStaticMarkup(draw(thread)!)).toContain(S.notProvided);
  h.invoke.mockRejectedValue({
    code: "timeout",
    message: "sensitive-credential",
  });
  click(thread);
  await flush();
  const markup = renderToStaticMarkup(draw(thread)!);
  expect(markup).toContain(S.errors.timeout);
  expect(markup).not.toContain("sensitive-credential");
  expect(markup).not.toContain("未登录");
  expect(thread.connectionOutcomeUnknown).toBe(false);
});

it("withdraws an unsupported supplementary read while retaining the safe result and existing auth state", async () => {
  const thread = owner();
  h.invoke.mockRejectedValue({ code: "unavailable", message: "safe" });
  click(thread);
  await flush();
  const markup = renderToStaticMarkup(draw(thread)!);
  expect(markup).toContain(S.errors.unavailable);
  expect(
    nodes(draw(thread)).filter((node) => node.type === "button"),
  ).toHaveLength(0);
  expect(thread.configError).toBeNull();
});

it("does not let a stale rendered button read an owner that changed on the same object", () => {
  const thread = owner();
  const button = nodes(draw(thread)).find((node) => node.type === "button")!;
  thread.connectionId = "replacement-connection";
  thread.nativeSessionId = "replacement-native";
  (button.props.onClick as () => void)();
  expect(h.invoke).not.toHaveBeenCalled();
});

it("does not let the old view cleanup erase a newer slot after the same object was rebound", () => {
  const thread = owner();
  draw(thread);
  const cleanup = h.cleanups.pop()!;
  thread.connectionId = "replacement-connection";
  thread.nativeSessionId = "replacement-native";
  const newer = { phase: "reported" as const, identity: null };
  thread.sessionIdentityRead = newer;
  cleanup();
  expect(thread.sessionIdentityRead).toBe(newer);
});
