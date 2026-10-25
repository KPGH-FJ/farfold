import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import { freshThreadState } from "./session_projection";
import { WorkspaceAccessStatusController } from "./workspace_access_status";
import type { ThreadState } from "./session_types";

function fixture(identity: ThreadState["identity"] = "established") {
  const owner = freshThreadState("owned", "fixture", "/owned", "native");
  owner.identity = identity;
  owner.connectionId = "connection";
  owner.workspaceAccess = {
    statusQuery: true,
    provenance: "reviewed-official-supplement",
  };
  let current: ThreadState | undefined = owner;
  const control = new WorkspaceAccessStatusController(owner, () => current);
  return {
    owner,
    control,
    replace: (value?: ThreadState) => (current = value),
  };
}
const reply = () => ({
  connectionId: "connection",
  nativeSessionId: "native",
  cwd: "/owned",
  status: "trusted",
  details: null,
});
function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((done) => (resolve = done));
  return { promise, resolve };
}
beforeEach(() => {
  h.invoke.mockReset();
});

it.each(["draft", "established"] as const)(
  "reads once only after explicit action for a real %s owner, without requiring model confirmation",
  async (identity) => {
    const { control, owner } = fixture(identity);
    expect(owner.configCheck).toBeNull();
    expect(control.isCurrent()).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
    h.invoke.mockResolvedValue(reply());
    expect(await control.read()).toBe(true);
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
      "session_workspace_access_status",
      {
        agentId: "fixture",
        cwd: "/owned",
        sessionId: "native",
        connectionId: "connection",
      },
    );
    expect(control.getSnapshot()).toMatchObject({
      phase: "ready",
      result: { status: "trusted", details: null },
    });
  },
);
it("does not create a native owner or infer support for an empty/unprepared draft", async () => {
  const { control, owner } = fixture("draft");
  owner.nativeSessionId = "";
  expect(await control.read()).toBe(false);
  const empty = new WorkspaceAccessStatusController(null, () => undefined);
  expect(await empty.read()).toBe(false);
  expect(h.invoke).not.toHaveBeenCalled();
});
it.each([
  "running",
  "connectionOutcomeUnknown",
  "stopUnconfirmed",
  "configuring",
  "connectionLost",
] as const)(
  "does not query while %s, change the queue, or reconnect",
  async (field) => {
    const { owner, control } = fixture();
    owner[field] = true;
    const before = owner.queued;
    expect(await control.read()).toBe(false);
    expect(owner.queued).toBe(before);
    expect(h.invoke).not.toHaveBeenCalled();
  },
);
it("does not infer support from ordinary configuration or an unknown provenance", async () => {
  const { owner, control } = fixture();
  owner.workspaceAccess = null;
  expect(await control.read()).toBe(false);
  owner.workspaceAccess = {
    statusQuery: true,
    provenance: "not-reviewed",
  } as never;
  expect(await control.read()).toBe(false);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("coalesces a pending double click without a second request", async () => {
  const { control } = fixture();
  const pending = deferred();
  h.invoke.mockReturnValue(pending.promise);
  const first = control.read();
  expect(await control.read()).toBe(false);
  expect(h.invoke).toHaveBeenCalledTimes(1);
  pending.resolve(reply());
  expect(await first).toBe(true);
});
it.each([
  "agentId",
  "cwd",
  "nativeSessionId",
  "connectionId",
  "serviceContext",
  "key",
] as const)(
  "drops a late result after the same object changes %s",
  async (field) => {
    const { control, owner } = fixture();
    const pending = deferred();
    h.invoke.mockReturnValue(pending.promise);
    const read = control.read();
    owner[field] = "replacement";
    pending.resolve(reply());
    expect(await read).toBe(false);
    expect(control.getSnapshot()).toEqual({ phase: "idle" });
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);
it("drops a replacement object and never paints its old owner result", async () => {
  const { control, owner, replace } = fixture();
  const pending = deferred();
  h.invoke.mockReturnValue(pending.promise);
  const read = control.read();
  replace({ ...owner });
  pending.resolve(reply());
  expect(await read).toBe(false);
  expect(control.getSnapshot().phase).toBe("idle");
});
it("drops a result if this connection withdraws its capability while reading", async () => {
  const { control, owner } = fixture();
  const pending = deferred();
  h.invoke.mockReturnValue(pending.promise);
  const read = control.read();
  owner.workspaceAccess = null;
  pending.resolve(reply());
  expect(await read).toBe(false);
  expect(control.getSnapshot()).toEqual({ phase: "idle" });
});
it("keeps dismiss/unmount local and drops a later result without cancel or retry", async () => {
  const { control } = fixture();
  const pending = deferred();
  h.invoke.mockReturnValue(pending.promise);
  const read = control.read();
  control.dispose();
  expect(control.isCurrent()).toBe(false);
  pending.resolve(reply());
  expect(await read).toBe(false);
  expect(control.getSnapshot()).toEqual({ phase: "idle" });
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
it("rejects a result when work becomes unknown during the read", async () => {
  const { control, owner } = fixture();
  const pending = deferred();
  h.invoke.mockReturnValue(pending.promise);
  const read = control.read();
  owner.connectionOutcomeUnknown = true;
  pending.resolve(reply());
  expect(await read).toBe(false);
  expect(control.getSnapshot()).toEqual({ phase: "error", code: "busy" });
});
it.each([
  { connectionId: "foreign" },
  { nativeSessionId: "foreign" },
  { cwd: "/foreign" },
  { status: "unknown" },
  { status: ["trusted"] },
  { details: { cwd: "/foreign", repoRoot: null, repoScopeVerified: false } },
  {
    details: {
      cwd: "/owned",
      repoRoot: "/unverified",
      repoScopeVerified: false,
    },
  },
])(
  "does not report a malformed or foreign result as trusted: %j",
  async (patch) => {
    const { control } = fixture();
    h.invoke.mockResolvedValue({ ...reply(), ...patch });
    expect(await control.read()).toBe(false);
    expect(control.getSnapshot()).toEqual({
      phase: "error",
      code: "invalidResponse",
    });
  },
);
it.each([null, []])(
  "keeps missing decisions separate from an explicit empty list: %j",
  async (decisions) => {
    const { control } = fixture();
    h.invoke.mockResolvedValue({
      ...reply(),
      status: "session",
      details: {
        cwd: "/owned",
        repoRoot: "/owned",
        repoScopeVerified: true,
        offeredDecisions: decisions,
      },
      arbitrary: { secret: "must-not-be-retained" },
    });
    expect(await control.read()).toBe(true);
    expect(control.getSnapshot()).toMatchObject({
      phase: "ready",
      result: { status: "session", details: { offeredDecisions: decisions } },
    });
    expect(JSON.stringify(control.getSnapshot())).not.toContain(
      "must-not-be-retained",
    );
  },
);
it.each([
  "timeout",
  "invalidResponse",
  "queryFailed",
  "constructor",
  "__proto__",
])(
  "projects only a fixed error code for %s and never retries",
  async (code) => {
    const { control } = fixture();
    h.invoke.mockRejectedValue({ code, message: "PRIVATE_ERROR_TEXT" });
    expect(await control.read()).toBe(false);
    expect(control.getSnapshot()).toEqual({
      phase: "error",
      code: ["constructor", "__proto__"].includes(code) ? "queryFailed" : code,
    });
    expect(JSON.stringify(control.getSnapshot())).not.toContain(
      "PRIVATE_ERROR_TEXT",
    );
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);
it("disables further reads for this owner when the official method is unavailable", async () => {
  const { control } = fixture();
  h.invoke.mockRejectedValue({ code: "unavailable" });
  expect(await control.read()).toBe(false);
  control.dismiss();
  expect(await control.read()).toBe(false);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
