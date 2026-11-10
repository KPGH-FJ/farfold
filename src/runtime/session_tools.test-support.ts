import { vi } from "vitest";
import { freshThreadState } from "./session_projection";
import { SessionToolsController } from "./session_tools_controller";
import type { SessionToolsRequest } from "./session_tools_types";
import type { SessionToolsPort } from "./session_tools";
export const capability = {
  source: "reviewedOfficialSupplement" as const,
  scope: "currentConversation" as const,
};
export const operationId = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";
export const target: SessionToolsRequest = {
  agentId: "fixture",
  cwd: "/owned",
  sessionId: "native",
  connectionId: "connection",
  operationId,
};
export function deferred() {
  let resolve!: (value: unknown) => void, reject!: (value: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
export const item = {
  name: "developer__inspect",
  description: "<b>Read-only description</b>",
  permission: "ask_before" as const,
  nameTruncated: false,
  descriptionTruncated: false,
};
export const report = (items: unknown[] = [item]) => ({
  observedAtMs: 1794051000000,
  completeness: "unreported",
  reportedItemCount: items.length,
  itemsTruncated: false,
  items,
});
export const pending = (r: SessionToolsRequest = target) => ({
  operationId: r.operationId,
  agentId: r.agentId,
  cwd: r.cwd,
  nativeSessionId: r.sessionId,
  connectionId: r.connectionId,
  ...(r.extensionName === undefined ? {} : { extensionName: r.extensionName }),
  state: "pending",
  settled: false,
  report: null,
  error: null,
});
export const ready = (
  r: SessionToolsRequest = target,
  items: unknown[] = [item],
) => ({ ...pending(r), state: "ready", settled: true, report: report(items) });
export const failed = (
  r: SessionToolsRequest = target,
  settled = true,
  code = "queryFailed",
) => ({
  ...pending(r),
  state: "failed",
  settled,
  error: { code, message: "PRIVATE_ERROR_MUST_NOT_BE_DISPLAYED" },
});
export function fixture() {
  const owner = freshThreadState("owned", "fixture", "/owned", "native");
  owner.connectionId = "connection";
  owner.sessionToolInventory = capability;
  let current: typeof owner | undefined = owner,
    n = 0;
  const read = deferred(),
    status = deferred();
  const port = {
    read: vi.fn<SessionToolsPort["read"]>(() => read.promise),
    status: vi.fn<SessionToolsPort["status"]>(() => status.promise),
  };
  const controller = new SessionToolsController(
    owner,
    () => current,
    port,
    100,
    () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++n).padStart(12, "0")}`,
  );
  return {
    owner,
    controller,
    port,
    read,
    status,
    replace: (value?: typeof owner) => (current = value),
    request: () => port.read.mock.calls.at(-1)![0] as SessionToolsRequest,
  };
}
