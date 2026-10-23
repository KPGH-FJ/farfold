import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { freshThreadState } from "./session_projection";

const h = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.open }));
import { OpeningInquiryOwner } from "./opening_inquiries";

const permission = {
  kind: "permissionRequest",
  requestId: "permission-opening-owned",
  owner: {
    connectionId: "same-connection",
    sessionId: "loading-session",
    requestId: "permission-opening-owned",
  },
  toolCall: {
    toolCallId: "read-current",
    title: "Read selected file",
    kind: "read",
    rawInput: { path: "/controlled/file" },
  },
  options: [
    { optionId: "yes", name: "Allow once", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ],
  request: { sessionId: "loading-session", opaque: { retained: true } },
};
const owners: OpeningInquiryOwner[] = [];
function owner() {
  const value = new OpeningInquiryOwner("a", "/controlled", () => {});
  owners.push(value);
  value.addInterest();
  return value;
}
beforeEach(() => {
  h.invoke.mockResolvedValue({ status: "submitted" });
});
afterEach(() => {
  owners.splice(0).forEach((value) => value.retire());
  h.invoke.mockReset();
  h.open.mockReset();
  vi.useRealTimers();
});

it("keeps the existing question path and exposes a real opening permission before load completes", () => {
  const value = owner();
  expect(
    value.receive({
      kind: "elicitation",
      requestId: "form",
      message: "Question",
    }),
  ).toBe(true);
  expect(value.snapshot().requests).toHaveLength(1);
  expect(value.receive(permission)).toBe(true);
  expect(value.snapshot().permissions).toHaveLength(1);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("clones original request data and consumes duplicate or exact expiry without borrowing a later tool", () => {
  const value = owner();
  const event = structuredClone(permission);
  value.receive(event);
  const original = value.snapshot().permissions[0];
  event.toolCall.rawInput.path = "/later-input";
  event.request.opaque.retained = false;
  value.receive(event);
  expect(value.snapshot().permissions).toEqual([original]);
  expect(original.toolCallSnapshot?.rawInput).toEqual({
    path: "/controlled/file",
  });
  expect(original.requestSnapshot).toEqual(permission.request);
  expect(
    value.receive({ kind: "interactionExpired", requestId: "different" }),
  ).toBe(false);
  expect(
    value.receive({
      kind: "interactionExpired",
      requestId: permission.requestId,
    }),
  ).toBe(true);
  expect(value.snapshot().permissions).toEqual([]);
  expect(value.receive(permission)).toBe(true);
  expect(value.snapshot().permissions).toEqual([]);
  value.decidePermission(permission.requestId, "yes");
  expect(h.invoke).not.toHaveBeenCalled();
});

it("requires an exact published owner and cancels read-only preparation without an approval", () => {
  const value = owner();
  expect(
    value.receive({
      ...permission,
      owner: { ...permission.owner, requestId: "other" },
    }),
  ).toBe(false);
  expect(value.snapshot().permissions).toEqual([]);
  const readOnly = new OpeningInquiryOwner(
    "a",
    "/controlled",
    () => {},
    "cancel",
  );
  owners.push(readOnly);
  readOnly.addInterest();
  expect(readOnly.receive(permission)).toBe(true);
  expect(readOnly.snapshot().permissions).toEqual([]);
  expect(h.invoke).toHaveBeenCalledWith("session_permission_respond", {
    requestId: permission.requestId,
    requestOwner: permission.owner,
    sessionId: "loading-session",
    optionId: null,
  });
});

it("only sends an explicit original option once and preserves uncertain outcomes without retry", async () => {
  vi.useFakeTimers();
  h.invoke.mockRejectedValue(new Error("unknown IPC delivery"));
  const value = owner();
  value.receive(permission);
  value.decidePermission(permission.requestId, "missing");
  expect(h.invoke).not.toHaveBeenCalled();
  value.decidePermission(permission.requestId, "yes");
  value.decidePermission(permission.requestId, "yes");
  await vi.runAllTimersAsync();
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(h.invoke.mock.calls[0][1]).toEqual({
    requestId: permission.requestId,
    requestOwner: permission.owner,
    sessionId: "loading-session",
    optionId: "yes",
  });
  expect(value.snapshot().permissions[0]).toMatchObject({
    status: "uncertain",
    decision: null,
  });
  value.decidePermission(permission.requestId, "yes");
  await vi.runAllTimersAsync();
  expect(h.invoke).toHaveBeenCalledTimes(1);
  value.retire();
  value.retire();
  expect(h.invoke.mock.calls.map(([, args]) => args.optionId)).toEqual([
    "yes",
    null,
  ]);
});

it("keeps the common remember undo window and does not submit an aborted caller's queued choice", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const value = new OpeningInquiryOwner("a", "/controlled", () => {});
  owners.push(value);
  value.addInterest(undefined, abort.signal);
  const remembered = {
    ...permission,
    options: [{ optionId: "remember", name: "Remember", kind: "allow_always" }],
  };
  value.receive(remembered);
  value.decidePermission(permission.requestId, "remember");
  await vi.advanceTimersByTimeAsync(4999);
  expect(h.invoke).not.toHaveBeenCalled();
  value.undoPermission(permission.requestId);
  await vi.advanceTimersByTimeAsync(1);
  expect(value.snapshot().permissions[0].decision).toBeNull();
  value.decidePermission(permission.requestId, "remember");
  abort.abort();
  value.addInterest();
  await vi.runAllTimersAsync();
  expect(h.invoke).not.toHaveBeenCalled();
  expect(value.snapshot().permissions[0].decision).toBeNull();
});

it("moves the same submitting request to the live view and applies only its actual late receipt", async () => {
  vi.useFakeTimers();
  let complete!: (reply: { status: string }) => void;
  h.invoke.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const value = owner();
  value.receive(permission);
  const request = value.snapshot().permissions[0];
  value.decidePermission(request.requestId, "yes");
  await vi.advanceTimersByTimeAsync(0);
  expect(request.status).toBe("submitting");
  const state = freshThreadState(
    "a:/controlled:loading-session",
    "a",
    "/controlled",
    "loading-session",
  );
  state.connectionId = permission.owner.connectionId;
  const changed = vi.fn();
  value.handoffPermissions(state, () => true, changed);
  value.finish();
  expect(state.pendingPermissions[0]).toBe(request);
  expect(value.snapshot().permissions).toEqual([]);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  complete({ status: "submitted" });
  await Promise.resolve();
  await Promise.resolve();
  expect(state.pendingPermissions).toEqual([]);
  expect(changed).toHaveBeenCalled();
});

it("a removed handed request cannot be revived by late submission or update another request", async () => {
  vi.useFakeTimers();
  let complete!: (reply: { status: string }) => void;
  h.invoke.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const value = owner();
  value.receive(permission);
  value.decidePermission(permission.requestId, "yes");
  await vi.advanceTimersByTimeAsync(0);
  const state = freshThreadState(
    "a:/controlled:loading-session",
    "a",
    "/controlled",
    "loading-session",
  );
  state.connectionId = permission.owner.connectionId;
  const changed = vi.fn();
  value.handoffPermissions(state, () => true, changed);
  value.finish();
  const original = state.pendingPermissions[0];
  const other = { ...original, requestId: "other", error: null };
  state.pendingPermissions = [other];
  complete({ status: "retryable" });
  await Promise.resolve();
  await Promise.resolve();
  expect(state.pendingPermissions).toEqual([other]);
  expect(changed).not.toHaveBeenCalled();
});

it("does not transfer a source connection's permission to an independent fork target", () => {
  const value = owner();
  value.receive(permission);
  const state = freshThreadState(
    "a:/controlled:child",
    "a",
    "/controlled",
    "child",
  );
  state.connectionId = "independent-child-connection";
  value.handoffPermissions(
    state,
    () => true,
    () => {},
  );
  value.finish();
  expect(state.pendingPermissions).toEqual([]);
  expect(h.invoke.mock.calls.map(([, args]) => args.optionId)).toEqual([null]);
  expect(h.invoke.mock.calls[0][1].requestOwner).toEqual(permission.owner);
});
