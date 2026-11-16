import { afterEach, expect, it, vi } from "vitest";
import {
  SessionToolRecoveryController,
  type ToolRecoveryPort,
} from "./session_tool_recovery_controller";
import {
  parseToolRecoveryInspection,
  parseToolRecoveryConfirmation,
} from "./session_tool_recovery_types";
import { freshThreadState } from "./session_projection";
import { retainRecoveryFailure } from "./session_recovery";
import { agentOpenError } from "./ui_error";
import { ERROR_STRINGS } from "./error_strings";
import { deferred, flush } from "./session_tools.test-support";
import type { ThreadState } from "./session_types";

const target = { agentId: "fixture", cwd: "/owned", sessionId: "native" };
const inspection = () => ({
  target,
  pending: true,
  operationId: "operation",
  action: "add",
  outcome: "applied",
  canConfirm: true,
  reviewId: "review",
  connectionId: "recovery-connection",
});
const confirmation = () => ({
  target,
  resolved: true,
  operationId: "operation",
  reviewId: "review",
  connectionId: "recovery-connection",
  requiresReopen: true,
});
function fixture() {
  const owner = freshThreadState(
    "recovery",
    target.agentId,
    target.cwd,
    target.sessionId,
  );
  owner.sessionToolRecoveryRequired = true;
  owner.connectionLost = true;
  owner.openError = ERROR_STRINGS.sessionToolChangePending;
  let current: ThreadState | undefined = owner;
  const read = deferred(),
    confirm = deferred();
  const port: ToolRecoveryPort = {
    inspect: vi.fn(() => read.promise),
    confirm: vi.fn(() => confirm.promise),
  };
  const resolved = vi.fn(() => true);
  const controller = new SessionToolRecoveryController(
    owner,
    () => current,
    resolved,
    port,
    100,
  );
  return {
    owner,
    read,
    confirm,
    port,
    resolved,
    controller,
    replace: (s?: ThreadState) => {
      current = s;
    },
  };
}
afterEach(() => vi.useRealTimers());

it("rechecks a failed open without loading or sending, then requires explicit exact confirmation", async () => {
  const h = fixture();
  expect(h.controller.confirm()).toBe(false);
  expect(h.controller.inspect()).toBe(true);
  expect(h.controller.inspect()).toBe(false);
  h.read.resolve(inspection());
  await flush();
  expect(h.controller.getSnapshot().phase).toBe("review");
  expect(h.resolved).not.toHaveBeenCalled();
  expect(h.controller.confirm()).toBe(true);
  expect(h.port.confirm).toHaveBeenCalledExactlyOnceWith(
    target,
    "review",
    "recovery-connection",
    "confirmResult",
  );
  h.confirm.resolve(confirmation());
  await flush();
  expect(h.resolved).toHaveBeenCalledExactlyOnceWith("operation");
  expect(h.controller.getSnapshot().phase).toBe("resolved");
});

it("reviews a complete changed configuration before explicitly accepting it, without declaring old work successful", async () => {
  const h = fixture();
  h.controller.inspect();
  h.read.resolve({
    ...inspection(),
    outcome: "changed",
    resolution: "acceptCurrent",
    configuration: {
      complete: true,
      items: [
        { name: "Developer", kind: "platform", address: null },
        { name: "Owned", kind: "http", address: "http://127.0.0.1:8910/mcp" },
      ],
    },
  });
  await flush();
  expect(h.controller.getSnapshot().phase).toBe("review");
  expect(h.resolved).not.toHaveBeenCalled();
  expect(h.controller.confirm()).toBe(true);
  expect(h.port.confirm).toHaveBeenCalledExactlyOnceWith(
    target,
    "review",
    "recovery-connection",
    "acceptCurrent",
  );
  h.confirm.resolve({ ...confirmation(), resolution: "acceptCurrent" });
  await flush();
  expect(h.controller.getSnapshot().phase).toBe("resolved");
  expect(h.owner.running).toBe(false);
  expect(h.owner.items).toEqual([]);
});

it.each(["operationId", "reviewId", "connectionId"])(
  "does not settle a confirmation for another %s",
  async (key) => {
    const h = fixture();
    h.controller.inspect();
    h.read.resolve(inspection());
    await flush();
    h.controller.confirm();
    h.confirm.resolve({ ...confirmation(), [key]: "different" });
    await flush();
    expect(h.controller.getSnapshot().error).toBe("invalidResponse");
    expect(h.resolved).not.toHaveBeenCalled();
  },
);

it("keeps missing pending records inconclusive, and never adopts incomplete external changes", async () => {
  for (const raw of [
    {
      target,
      pending: false,
      operationId: null,
      action: null,
      outcome: "none",
      canConfirm: false,
      reviewId: null,
      connectionId: null,
    },
    {
      ...inspection(),
      outcome: "changed",
      canConfirm: false,
      reviewId: null,
      connectionId: null,
    },
  ]) {
    const h = fixture();
    h.controller.inspect();
    h.read.resolve(raw);
    await flush();
    expect(h.controller.confirm()).toBe(false);
    expect(h.resolved).not.toHaveBeenCalled();
    expect(h.owner.sessionToolRecoveryRequired).toBe(true);
  }
});

it("a timeout or dismissed observer does not automatically duplicate the native check", async () => {
  vi.useFakeTimers();
  const h = fixture(),
    observer = vi.fn();
  const unsubscribe = h.controller.subscribe(observer);
  h.controller.inspect();
  unsubscribe();
  await vi.advanceTimersByTimeAsync(101);
  expect(h.controller.getSnapshot().error).toBe("timeout");
  expect(h.port.inspect).toHaveBeenCalledTimes(1);
  expect(h.controller.inspect()).toBe(true);
  expect(h.port.inspect).toHaveBeenCalledTimes(2);
  h.read.resolve(inspection());
  await flush();
  expect(h.controller.getSnapshot().phase).toBe("review");
  expect(h.controller.blocked).toBe(false);
});

it("a late failure cannot overwrite a newer check of the exact confirmation", async () => {
  vi.useFakeTimers();
  const h = fixture();
  const retry = deferred();
  h.controller.inspect();
  h.read.resolve(inspection());
  await flush();
  h.controller.confirm();
  await vi.advanceTimersByTimeAsync(101);
  vi.mocked(h.port.confirm).mockImplementationOnce(() => retry.promise);
  expect(h.controller.confirm()).toBe(true);
  h.confirm.reject("lost old callback");
  await flush();
  expect(h.controller.getSnapshot().phase).toBe("confirming");
  expect(h.controller.blocked).toBe(true);
  retry.resolve(confirmation());
  await flush();
  expect(h.resolved).toHaveBeenCalledExactlyOnceWith("operation");
  expect(h.controller.getSnapshot().phase).toBe("resolved");
});

it("discarded owners cannot apply late confirmations", async () => {
  const h = fixture();
  h.controller.inspect();
  h.read.resolve(inspection());
  await flush();
  h.controller.confirm();
  h.replace({ ...h.owner });
  h.confirm.resolve(confirmation());
  await flush();
  expect(h.resolved).not.toHaveBeenCalled();
});

it("rechecks a lost confirmation with the same review instead of losing its receipt", async () => {
  const h = fixture();
  h.controller.inspect();
  h.read.resolve(inspection());
  await flush();
  vi.mocked(h.port.confirm).mockRejectedValueOnce(
    "SESSION_TOOL_RECOVERY_PENDING",
  );
  h.controller.confirm();
  await flush();
  expect(h.controller.getSnapshot().confirmationUnresolved).toBe(true);
  expect(h.controller.inspect()).toBe(false);
  expect(h.controller.confirm()).toBe(true);
  h.confirm.resolve(confirmation());
  await flush();
  expect(h.resolved).toHaveBeenCalledExactlyOnceWith("operation");
  expect(vi.mocked(h.port.confirm).mock.calls).toEqual([
    [target, "review", "recovery-connection", "confirmResult"],
    [target, "review", "recovery-connection", "confirmResult"],
  ]);
});

it("an explicit native review rejection permits a fresh inspection", async () => {
  const h = fixture();
  h.controller.inspect();
  h.read.resolve(inspection());
  await flush();
  h.controller.confirm();
  h.confirm.reject("SESSION_TOOL_RECOVERY_REVIEW_CHANGED");
  await flush();
  expect(h.controller.getSnapshot().confirmationUnresolved).toBe(false);
  expect(h.controller.getSnapshot().inspection).toBeNull();
  expect(h.controller.inspect()).toBe(true);
  await flush();
  expect(h.resolved).not.toHaveBeenCalled();
});

it("validates target and outcome combinations and strips unexpected private fields", () => {
  expect(() =>
    parseToolRecoveryInspection(
      { ...inspection(), target: { ...target, sessionId: "other" } },
      target,
    ),
  ).toThrow();
  expect(() =>
    parseToolRecoveryInspection(
      { ...inspection(), outcome: "changed" },
      target,
    ),
  ).toThrow();
  const result = parseToolRecoveryInspection(
    { ...inspection(), privateUrl: "must-not-be-retained" },
    target,
  );
  expect(JSON.stringify(result)).not.toContain("must-not-be-retained");
  expect(() =>
    parseToolRecoveryConfirmation(
      { ...confirmation(), requiresReopen: false },
      result,
    ),
  ).toThrow();
});

it("marks only the exact application pending code and preserves original content", () => {
  const h = fixture();
  h.owner.sessionToolRecoveryRequired = false;
  h.owner.items.push({
    kind: "user",
    id: "message",
    text: "keep history",
    attachments: [],
    streaming: false,
    time: 1,
  });
  const items = h.owner.items;
  retainRecoveryFailure(h.owner, "SESSION_TOOL_CHANGE_PENDING");
  expect(h.owner.sessionToolRecoveryRequired).toBe(true);
  expect(h.owner.items).toBe(items);
  expect(h.owner.openError).toBe(ERROR_STRINGS.sessionToolChangePending);
  expect(
    agentOpenError("SESSION_TOOL_CHANGE_PENDING: private detail"),
  ).toBeUndefined();
  expect(
    agentOpenError({ message: "SESSION_TOOL_CHANGE_PENDING" }),
  ).toBeUndefined();
});
