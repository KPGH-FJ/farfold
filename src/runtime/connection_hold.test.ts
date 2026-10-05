import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentConnectionStatus } from "./agents";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  effect: undefined as (() => void) | undefined,
  deps: undefined as unknown[] | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    if (!h.deps || deps.some((value, i) => !Object.is(value, h.deps?.[i]))) {
      h.effect?.();
      h.effect = effect() || undefined;
      h.deps = deps;
    }
  },
}));
import { useConnectionHold } from "./connection_hold";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function status(
  cwd = "/work",
  serviceContext?: string,
  state = "ready",
): AgentConnectionStatus {
  return {
    agentId: "fixture",
    cwd,
    serviceContext,
    state,
    agentName: null,
    agentVersion: null,
    authMethods: [],
  };
}
let emit: (value: AgentConnectionStatus) => void;
let off: () => void;
const holds = (retain: boolean) =>
  h.invoke.mock.calls
    .filter(
      ([name, args]) =>
        name === "agent_connection_hold" && args.retain === retain,
    )
    .map(([, args]) => args);

beforeEach(() => {
  h.invoke.mockReset();
  h.listen.mockReset();
  h.effect = undefined;
  h.deps = undefined;
  off = vi.fn();
  h.listen.mockImplementation(async (_name, callback) => {
    emit = (payload) => callback({ payload });
    return off;
  });
  h.invoke.mockImplementation(async (name) =>
    name === "agent_status" ? [] : true,
  );
});
afterEach(async () => {
  h.effect?.();
  h.effect = undefined;
  await settle();
});

it("subscribes before reading and holds only the exact ready source", async () => {
  const registration = deferred<() => void>();
  h.listen.mockReturnValue(registration.promise);
  h.invoke.mockImplementation(async (name) =>
    name === "agent_status"
      ? [
          status(),
          status("/work", "api"),
          status("/other"),
          status("/work", undefined, "closed"),
        ]
      : true,
  );
  useConnectionHold({ agentId: "fixture", cwd: "/work" });
  expect(h.invoke).not.toHaveBeenCalled();
  registration.resolve(off);
  await settle();
  expect(holds(true)).toEqual([
    {
      agentId: "fixture",
      cwd: "/work",
      owner: expect.any(String),
      retain: true,
    },
  ]);
  expect(
    h.invoke.mock.calls.every(([name]) =>
      ["agent_status", "agent_connection_hold"].includes(name),
    ),
  ).toBe(true);
});

it("keeps a newer close event ahead of a stale initial ready snapshot", async () => {
  const snapshot = deferred<AgentConnectionStatus[]>();
  h.invoke.mockImplementation((name) =>
    name === "agent_status" ? snapshot.promise : Promise.resolve(true),
  );
  useConnectionHold({ agentId: "fixture", cwd: "/work" });
  await settle();
  emit(status("/work", undefined, "closed"));
  snapshot.resolve([status()]);
  await settle();
  expect(holds(true)).toHaveLength(0);
  emit(status());
  await settle();
  expect(holds(true)).toHaveLength(1);
});

it("holds all ready preparation connections and reacquires a rebuilt address", async () => {
  h.invoke.mockImplementation(async (name) =>
    name === "agent_status" ? [status(), status("/work", "api")] : true,
  );
  useConnectionHold({ agentId: "fixture" });
  await settle();
  expect(holds(true)).toHaveLength(2);
  emit(status("/work", undefined, "closed"));
  emit(status());
  await settle();
  expect(holds(true)).toHaveLength(3);
  expect(new Set(holds(true).map((value) => value.owner)).size).toBe(1);
  useConnectionHold(null);
  expect(holds(false)).toHaveLength(2);
});

it("releases a late acquisition with its own token after a target change", async () => {
  const acquisition = deferred<boolean>();
  h.invoke.mockImplementation((name, args) => {
    if (name === "agent_status")
      return Promise.resolve([status("/old"), status("/new")]);
    if (args.retain && args.cwd === "/old") return acquisition.promise;
    return Promise.resolve(true);
  });
  useConnectionHold({ agentId: "fixture", cwd: "/old" });
  await settle();
  const oldOwner = holds(true)[0].owner;
  useConnectionHold({ agentId: "fixture", cwd: "/new" });
  await settle();
  const newOwner = holds(true)[1].owner;
  expect(oldOwner).not.toBe(newOwner);
  expect(holds(false)).toEqual([
    expect.objectContaining({ cwd: "/old", owner: oldOwner }),
  ]);
  acquisition.resolve(true);
  await settle();
  expect(holds(false)).toHaveLength(2);
  expect(
    holds(false).every(
      (value) => value.owner === oldOwner && value.cwd === "/old",
    ),
  ).toBe(true);
});

it("unsubscribes a late registration without reading or retaining after unmount", async () => {
  const registration = deferred<() => void>();
  h.listen.mockReturnValue(registration.promise);
  useConnectionHold({ agentId: "fixture" });
  useConnectionHold(null);
  registration.resolve(off);
  await settle();
  expect(off).toHaveBeenCalledOnce();
  expect(h.invoke).not.toHaveBeenCalled();
});

it("ignores a late snapshot and events after cleanup", async () => {
  const snapshot = deferred<AgentConnectionStatus[]>();
  h.invoke.mockReturnValue(snapshot.promise);
  useConnectionHold({ agentId: "fixture" });
  await settle();
  useConnectionHold(null);
  snapshot.resolve([status()]);
  emit(status());
  await settle();
  expect(holds(true)).toHaveLength(0);
  expect(off).toHaveBeenCalledOnce();
});

it("does not replace ownership on an equivalent rerender or act for a null target", async () => {
  useConnectionHold(null);
  expect(h.listen).not.toHaveBeenCalled();
  useConnectionHold({
    agentId: "fixture",
    cwd: "/work",
    serviceContext: "api",
  });
  await settle();
  emit(status());
  emit(status("/work", "api"));
  emit({ ...status("/work", "api"), agentId: "other" });
  await settle();
  expect(holds(true)).toHaveLength(1);
  useConnectionHold({
    agentId: "fixture",
    cwd: "/work",
    serviceContext: "api",
  });
  expect(h.listen).toHaveBeenCalledOnce();
  expect(holds(false)).toHaveLength(0);
});

it("retains only the displayed conversation process when siblings share its address", async () => {
  const sibling = {
    ...status(),
    connectionId: "sibling",
    purpose: "conversation" as const,
  };
  const displayed = {
    ...status(),
    connectionId: "displayed",
    purpose: "conversation" as const,
  };
  const preparation = {
    ...status(),
    connectionId: "preparing",
    purpose: "preparation" as const,
  };
  h.invoke.mockImplementation(async (name) =>
    name === "agent_status" ? [sibling, displayed, preparation] : true,
  );
  useConnectionHold({
    agentId: "fixture",
    cwd: "/work",
    connectionId: "displayed",
  });
  await settle();
  expect(holds(true)).toHaveLength(1);
  expect(holds(true)[0].connectionId).toBe("displayed");
  emit({ ...displayed, connectionId: "rebuilt" });
  emit(sibling);
  await settle();
  expect(holds(true)).toHaveLength(1);
  useConnectionHold(null);
  expect(holds(false)).toHaveLength(1);
  expect(holds(false)[0].connectionId).toBe("displayed");
});

it("an Agent settings page never holds another conversation process", async () => {
  h.invoke.mockImplementation(async (name) =>
    name === "agent_status"
      ? [
          { ...status(), connectionId: "preparing", purpose: "preparation" },
          { ...status(), connectionId: "working", purpose: "conversation" },
        ]
      : true,
  );
  useConnectionHold({ agentId: "fixture" });
  await settle();
  expect(holds(true)).toHaveLength(1);
  expect(holds(true)[0].connectionId).toBe("preparing");
});
