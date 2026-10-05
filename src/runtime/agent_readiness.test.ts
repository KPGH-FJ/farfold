import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentCardModel } from "./agents";
import type { AgentSetupSelection } from "../components/AgentSetup";
import type { PreparationSnapshot } from "./agent_preparation";

const h = vi.hoisted(() => ({
  cleanup: [] as (() => void)[],
  redraw: vi.fn(),
  completed: true,
  selection: undefined as AgentSetupSelection | undefined,
  preparation: undefined as PreparationSnapshot | undefined,
  pendingRead: vi.fn(),
  thread: vi.fn(),
  open: vi.fn(),
  send: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [0, h.redraw],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) h.cleanup.push(cleanup);
  },
  useSyncExternalStore: (
    subscribe: (listener: () => void) => () => void,
    read: () => unknown,
  ) => {
    h.cleanup.push(subscribe(h.redraw));
    return read();
  },
}));
vi.mock("./setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => h.completed,
    confirmedSelection: () => h.selection,
  },
}));
vi.mock("./agent_preparation", () => ({
  usePreparationChanges: () => 0,
  pendingPreparationRead: h.pendingRead,
  preparationFor: () => ({ getSnapshot: () => h.preparation }),
}));
vi.mock("./sessions", () => ({
  threads: { thread: h.thread, open: h.open, send: h.send },
}));

import { useConversationAgentReadiness } from "./agent_readiness";
import {
  authenticationActivity,
  observeAuthentication,
} from "./authentication";

const card = {
  id: "readiness-agent",
  name: "Example",
  status: "connected",
  source: "registry",
  firstBatchVisible: true,
} as AgentCardModel;
const service = { id: "service", model: "model", revision: "revision" };
const actualContext = "actual-returned-service-context";
const authChecks: { cwd: string; source?: string }[] = [];
function requireAuthentication(cwd: string, source?: string) {
  authChecks.push({ cwd, source });
  observeAuthentication(card.id, cwd, "AUTH_REQUIRED", source, "request");
}
function unmount() {
  for (const cleanup of h.cleanup.splice(0)) cleanup();
}
function ready() {
  unmount();
  return useConversationAgentReadiness([card])(card.id);
}
function confirmedService() {
  h.selection = { service: { ...service }, config: { model: service.model } };
  h.preparation = {
    phase: "untested",
    input: {
      agentId: card.id,
      agentName: card.name,
      cwd: "/prepared-folder",
      program: "program",
      service: { ...service },
    },
    threadKey: "prepared-thread",
    config: {},
    prompt: "",
    reply: "",
    error: null,
  };
  h.thread.mockReturnValue({ serviceContext: actualContext });
}
beforeEach(() => {
  h.redraw.mockClear();
  h.completed = true;
  h.selection = { service: null, config: {} };
  h.preparation = {
    phase: "untested",
    input: null,
    threadKey: null,
    config: {},
    prompt: "",
    reply: "",
    error: null,
  };
  h.pendingRead.mockReset().mockReturnValue(false);
  h.thread.mockReset();
  h.open.mockReset();
  h.send.mockReset();
});
afterEach(() => {
  unmount();
  for (const { cwd, source } of authChecks.splice(0))
    observeAuthentication(card.id, cwd, undefined, source, "request");
  expect(h.open).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
});

it("uses confirmed preparation before a working folder exists without requiring a test request", () => {
  expect(ready()).toBe(true);
  expect(h.pendingRead).toHaveBeenLastCalledWith({
    agentId: card.id,
    cwd: null,
    service: null,
  });
  h.completed = false;
  expect(ready()).toBe(false);
  h.completed = true;
  h.selection = undefined;
  expect(ready()).toBe(false);
});

it("keeps saved preparation selectable while disconnected without opening a connection", () => {
  const offline = { ...card, status: "installed" as const };
  expect(useConversationAgentReadiness([offline])(card.id)).toBe(true);
  requireAuthentication("/prepared-folder");
  expect(useConversationAgentReadiness([offline])(card.id)).toBe(false);
});

it("checks the actual service context returned by matching preparation and preserves unrelated sources", () => {
  confirmedService();
  requireAuthentication("/other-folder");
  expect(ready()).toBe(true);
  requireAuthentication("/prepared-folder", actualContext);
  expect(ready()).toBe(false);
  expect(h.thread).toHaveBeenCalledWith("prepared-thread");
  observeAuthentication(
    card.id,
    "/prepared-folder",
    undefined,
    actualContext,
    "request",
  );
  expect(ready()).toBe(true);
});

it.each(["id", "model", "revision"] as const)(
  "does not use an old preparation context when the confirmed service %s has changed",
  (field) => {
    confirmedService();
    h.selection!.service![field] = `different-${field}`;
    requireAuthentication("/prepared-folder", actualContext);
    expect(ready()).toBe(true);
    expect(h.thread).not.toHaveBeenCalled();
    requireAuthentication("/new-folder", JSON.stringify(h.selection!.service));
    expect(ready()).toBe(false);
  },
);

it("subscribes to account waiting, unknown and completed states and removes its listener on unmount", async () => {
  expect(ready()).toBe(true);
  h.redraw.mockClear();
  const activity = authenticationActivity(card.id);
  activity.begin(
    { agentId: card.id, cwd: "/prepared-folder" },
    {
      kind: "authentication",
      methodId: "official",
      title: "登录",
      completion: "exit_code",
    },
    "readiness-account-action",
  );
  expect(h.redraw).toHaveBeenCalled();
  let markUnknown!: () => void;
  let complete!: () => void;
  const operation = activity.protocol({
    run: (unknown) => {
      markUnknown = unknown;
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
    cancel: async () => {},
    reconnect: async () => {},
  });
  expect(activity.getSnapshot()?.phase).toBe("waiting");
  expect(ready()).toBe(false);
  h.redraw.mockClear();
  markUnknown();
  expect(h.redraw).toHaveBeenCalled();
  expect(activity.getSnapshot()?.phase).toBe("unknown");
  expect(ready()).toBe(false);
  h.redraw.mockClear();
  complete();
  await operation;
  expect(h.redraw).toHaveBeenCalled();
  expect(activity.getSnapshot()?.phase).toBe("completed");
  expect(ready()).toBe(true);
  unmount();
  h.redraw.mockClear();
  await activity.recheck(async () => {});
  expect(h.redraw).not.toHaveBeenCalled();
});

it("keeps an otherwise prepared Agent listed during ordinary running work or a pending approval", () => {
  confirmedService();
  h.thread.mockReturnValue({
    serviceContext: actualContext,
    running: true,
    submitting: true,
    pendingPermissions: [{ requestId: "permission" }],
  });
  expect(ready()).toBe(true);
  h.pendingRead.mockReturnValue(true);
  expect(ready()).toBe(false);
});
