import { vi } from "vitest";
import { freshThreadState } from "./session_projection";
import { SessionToolChangeController } from "./session_tool_change_controller";
import { SessionToolChangeGuards } from "./session_tool_change_guards";
import type { SessionToolChangePort } from "./session_tool_change";
import type {
  SessionToolChangeOperation,
  SessionToolChangeRequest,
} from "./session_tool_change_types";
import { capability, deferred } from "./session_tools.test-support";

export const changeInput = {
  kind: "addHttp" as const,
  name: "owned-http",
  url: "https://mcp.example.test/stream?scope=exact",
};
export const managedItem = {
  itemRef: "opaque-item-1",
  name: "owned-http",
  canRemove: true,
};
export function changeOperation(
  request: SessionToolChangeRequest,
  patch: Partial<SessionToolChangeOperation> = {},
): SessionToolChangeOperation {
  return {
    kind: "addHttp",
    operationId: request.operationId,
    agentId: request.agentId,
    cwd: request.cwd,
    nativeSessionId: request.sessionId,
    connectionId: request.connectionId,
    state: "pending",
    settled: false,
    mutationSent: false,
    conversationSaved:
      patch.kind !== "inspect" && (patch.mutationSent ?? false),
    persistence: "unreported",
    activity: "unreported",
    items: [],
    ...patch,
  };
}
export const changed = (request: SessionToolChangeRequest) =>
  changeOperation(request, {
    state: "ready",
    settled: true,
    mutationSent: true,
    persistence: "confirmed",
    activity: "toolsReported",
    items: [managedItem],
  });
export const inspected = (
  request: SessionToolChangeRequest,
  items = [managedItem],
) =>
  changeOperation(request, {
    kind: "inspect",
    state: "ready",
    settled: true,
    items,
  });
export function changeFixture() {
  const owner = freshThreadState("owned", "fixture", "/owned", "native");
  owner.connectionId = "connection";
  owner.sessionToolInventory = { ...capability, management: true };
  let current: typeof owner | undefined = owner,
    sequence = 0;
  const start = deferred(),
    status = deferred(),
    items = deferred();
  const port = {
    start: vi.fn<SessionToolChangePort["start"]>(() => start.promise),
    status: vi.fn<SessionToolChangePort["status"]>(() => status.promise),
    items: vi.fn<SessionToolChangePort["items"]>(() => items.promise),
  };
  const protection = new SessionToolChangeGuards({
    current: () => current,
    emit: vi.fn(),
  });
  const controller = new SessionToolChangeController(
    owner,
    () => current,
    port,
    {
      claim: protection.claim.bind(protection),
      settle: protection.settle.bind(protection),
      has: protection.has.bind(protection),
      subscribe: protection.subscribe,
      unknown: protection.markUnknown.bind(protection),
      unsent: protection.releaseUnsent.bind(protection),
      saved: protection.saved.bind(protection),
    },
    100,
    () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++sequence).padStart(12, "0")}`,
  );
  return {
    owner,
    controller,
    port,
    start,
    status,
    items,
    protection,
    request: () => port.start.mock.calls.at(-1)![0],
    replace: (value?: typeof owner) => {
      current = value;
    },
  };
}
