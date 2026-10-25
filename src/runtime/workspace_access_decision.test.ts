import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import { threads, type ThreadState } from "./sessions";
import { draftPersistence } from "./drafts";
import { archiveActivity } from "./archive_activity";
import { WorkspaceAccessStatusController } from "./workspace_access_status";
import { WorkspaceAccessDecisionController } from "./workspace_access_decision";
import type { WorkspaceAccessScope } from "./workspace_access_types";
import { WORKSPACE_ACCESS as S } from "./workspace_access_strings";
import { STRINGS } from "./strings";

let sequence = 0;
const scope = (): WorkspaceAccessScope => ({
  cwd: "/owned",
  repoRoot: "/",
  repoScopeVerified: true,
  offeredDecisions: ["trust_cwd", "trust_repo", "decline"],
});
function seed() {
  const s = threads.markOpenFailed(
    `trust-${++sequence}`,
    "fixture",
    "/owned",
    "native",
    "fixture",
  );
  s.openError = null;
  s.connectionId = "connection";
  s.serviceContext = "selected-source";
  s.workspaceAccess = {
    statusQuery: true,
    decisionManagement: true,
    provenance: "reviewed-official-supplement",
  };
  s.configCheck = { status: "ready", issues: [], current: { choices: [] } };
  s.queuePaused = "stopped";
  return s;
}
const reply = () => ({
  connectionId: "connection",
  nativeSessionId: "native",
  cwd: "/owned",
  status: "trusted",
  details: scope(),
});
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function event(s: ThreadState, value: unknown) {
  (
    threads as unknown as {
      applyChannelEvent(key: string, value: unknown): void;
    }
  ).applyChannelEvent(s.key, value);
}
async function controls(s: ThreadState) {
  const status = new WorkspaceAccessStatusController(s, () =>
    threads.thread(s.key),
  );
  h.invoke.mockResolvedValueOnce(reply());
  expect(await status.read()).toBe(true);
  const decisions = new WorkspaceAccessDecisionController(
    s,
    status,
    (choice, expected) =>
      threads.decideWorkspaceAccess(s.key, choice, expected),
  );
  return { status, decisions };
}
beforeEach(() => {
  h.invoke.mockReset();
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

it("keeps the store-owned configuring guard until one actual write settles, without an implicit setter or queue continue", async () => {
  const s = seed();
  const oldCheck = s.configCheck;
  const queued = s.queued;
  const pending = deferred();
  h.invoke.mockReturnValue(pending.promise);
  const request = threads.decideWorkspaceAccess(s.key, "trust_cwd", scope());
  expect(s.configuring).toBe(true);
  await expect(
    threads.decideWorkspaceAccess(s.key, "trust_cwd", scope()),
  ).rejects.toMatchObject({ code: "busy", effect: "notDispatched" });
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    "session_workspace_access_decide",
    {
      agentId: "fixture",
      cwd: "/owned",
      sessionId: "native",
      connectionId: "connection",
      decision: "trust_cwd",
      expectedScope: scope(),
    },
  );
  pending.resolve(reply());
  await expect(request).resolves.toMatchObject({ status: "trusted" });
  expect(s.configuring).toBe(false);
  expect(s.configCheck).toBe(oldCheck);
  expect(s.queued).toBe(queued);
  expect(s.queuePaused).toBe("stopped");
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it.each([
  "running",
  "connectionOutcomeUnknown",
  "stopUnconfirmed",
  "connectionLost",
  "configuring",
] as const)("rejects %s before dispatch", async (field) => {
  const s = seed();
  s[field] = true;
  await expect(
    threads.decideWorkspaceAccess(s.key, "trust_cwd", scope()),
  ).rejects.toMatchObject({ code: "busy", effect: "notDispatched" });
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each([null, []])(
  "requires both actual decision capability and a finite reported offer: %j",
  async (offeredDecisions) => {
    const s = seed();
    await expect(
      threads.decideWorkspaceAccess(s.key, "trust_cwd", {
        ...scope(),
        offeredDecisions,
      }),
    ).rejects.toMatchObject({ code: "notOffered", effect: "notDispatched" });
    s.workspaceAccess = {
      statusQuery: true,
      provenance: "reviewed-official-supplement",
    };
    await expect(
      threads.decideWorkspaceAccess(s.key, "trust_cwd", scope()),
    ).rejects.toMatchObject({ code: "unavailable", effect: "notDispatched" });
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it("does not offer an unverified repository scope or treat an unknown action as decline", async () => {
  const s = seed();
  await expect(
    threads.decideWorkspaceAccess(s.key, "trust_repo", {
      ...scope(),
      repoRoot: null,
      repoScopeVerified: false,
    }),
  ).rejects.toMatchObject({ code: "scopeChanged" });
  await expect(
    threads.decideWorkspaceAccess(s.key, "cancel" as never, scope()),
  ).rejects.toMatchObject({ code: "notOffered" });
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each([
  "modelDrift",
  "blockedCheck",
  "confirmationRequired",
  "permissionUnknown",
] as const)(
  "keeps %s write protection while allowing the original explicit status read",
  async (guard) => {
    const s = seed();
    if (guard === "modelDrift") s.modelDrift = true;
    else if (guard === "permissionUnknown") s.permissionState = "unknown";
    else
      s.configCheck = {
        ...s.configCheck!,
        status: guard === "blockedCheck" ? "blocked" : "confirmation_required",
      };
    const { decisions } = await controls(s);
    expect(decisions.review("trust_cwd")).toBe(false);
    await expect(
      threads.decideWorkspaceAccess(s.key, "trust_cwd", scope()),
    ).rejects.toMatchObject({ code: "busy", effect: "notDispatched" });
    expect(s.configError).toBeNull();
    expect(s.connectionOutcomeUnknown).toBe(false);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke.mock.calls[0][0]).toBe("session_workspace_access_status");
  },
);

it("dismiss and navigation retire only display state while an already dispatched write remains store-owned", async () => {
  const s = seed();
  const { status, decisions } = await controls(s);
  expect(decisions.review("trust_cwd")).toBe(true);
  const pending = deferred();
  h.invoke.mockReturnValue(pending.promise);
  const confirm = decisions.confirm();
  expect(s.configuring).toBe(true);
  expect(await decisions.confirm()).toBe(false);
  decisions.dismiss();
  status.dismiss();
  decisions.dispose();
  status.dispose();
  expect(s.configuring).toBe(true);
  await expect(
    threads.decideWorkspaceAccess(s.key, "trust_cwd", scope()),
  ).rejects.toMatchObject({ code: "busy" });
  pending.resolve(reply());
  expect(await confirm).toBe(false);
  expect(s.configuring).toBe(false);
  expect(decisions.getSnapshot()).toEqual({ phase: "idle" });
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "session_workspace_access_decide",
    ),
  ).toHaveLength(1);
});

it.each([
  { code: "timeout", effect: "unconfirmed", message: "PRIVATE_ERROR" },
  { code: "timeout", message: "PRIVATE_ERROR" },
  { code: "unavailable", message: "PRIVATE_ERROR" },
  new Error("PRIVATE_ERROR"),
  { code: "constructor", effect: "notDispatched", message: "PRIVATE_ERROR" },
])(
  "keeps missing/uncertain delivery effects as configuration unknown, blocks real send, and never calls it a model request outcome: %j",
  async (error) => {
    const s = seed();
    const oldCheck = s.configCheck;
    const oldPermission = s.permissionState;
    h.invoke.mockRejectedValue(error);
    await expect(
      threads.decideWorkspaceAccess(s.key, "trust_cwd", scope()),
    ).rejects.toMatchObject({ effect: "unconfirmed" });
    expect(s.configError).toBe(S.decisionUnconfirmed);
    expect(s.configError).not.toContain("PRIVATE_ERROR");
    expect(s.configCheck).toBe(oldCheck);
    expect(s.permissionState).toBe(oldPermission);
    expect(s.connectionOutcomeUnknown).toBe(false);
    expect(s.workspaceAccess?.decisionManagement).toBe(true);
    expect(s.uncertainPrompt).toBeNull();
    expect(s.configuring).toBe(false);
    const status = new WorkspaceAccessStatusController(s, () => s);
    h.invoke.mockResolvedValue(reply());
    expect(await status.read()).toBe(true);
    status.dismiss();
    expect(s.configError).toBe(S.decisionUnconfirmed);
    await expect(
      threads.decideWorkspaceAccess(s.key, "trust_cwd", scope()),
    ).rejects.toMatchObject({ code: "busy", effect: "notDispatched" });
    await expect(
      threads.send(s.key, [{ type: "text", text: "owned fixture" }]),
    ).rejects.toThrow(STRINGS.repair.configFailed);
    expect(s.queuePaused).toBe("stopped");
    expect(s.queued).toEqual([]);
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      "session_workspace_access_decide",
      "session_workspace_access_status",
    ]);
  },
);

it("does not invent uncertainty for a known pre-dispatch rejection", async () => {
  const s = seed();
  h.invoke.mockRejectedValue({
    code: "scopeChanged",
    effect: "notDispatched",
    message: "PRIVATE_ERROR",
  });
  await expect(
    threads.decideWorkspaceAccess(s.key, "decline", scope()),
  ).rejects.toEqual({ code: "scopeChanged", effect: "notDispatched" });
  expect(s.configError).toBeNull();
  expect(s.configuring).toBe(false);
  expect(s.connectionOutcomeUnknown).toBe(false);
});

it("withdraws only decision capability on a complete typed unavailable error and keeps explicit status reads available", async () => {
  const s = seed();
  h.invoke.mockRejectedValueOnce({
    code: "unavailable",
    effect: "notDispatched",
    message: "fixed error",
  });
  await expect(
    threads.decideWorkspaceAccess(s.key, "trust_cwd", scope()),
  ).rejects.toEqual({ code: "unavailable", effect: "notDispatched" });
  expect(s.workspaceAccess).toEqual({
    statusQuery: true,
    provenance: "reviewed-official-supplement",
  });
  expect(s.configError).toBeNull();
  const { decisions } = await controls(s);
  expect(decisions.choices).toEqual([]);
  expect(decisions.review("trust_cwd")).toBe(false);
  await expect(
    threads.decideWorkspaceAccess(s.key, "trust_cwd", scope()),
  ).rejects.toMatchObject({ code: "unavailable", effect: "notDispatched" });
  expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
    "session_workspace_access_decide",
    "session_workspace_access_status",
  ]);
});

it("does not withdraw capability or release configuring on a replacement owner after a late typed unavailable error", async () => {
  const s = seed();
  const pending = deferred();
  h.invoke.mockReturnValueOnce(pending.promise);
  const request = threads.decideWorkspaceAccess(s.key, "trust_cwd", scope());
  const replacement = { ...s, workspaceAccess: { ...s.workspaceAccess! } };
  const original = threads.thread.bind(threads);
  vi.spyOn(threads, "thread").mockImplementation((key) =>
    key === s.key ? replacement : original(key),
  );
  pending.reject({
    code: "unavailable",
    effect: "notDispatched",
    message: "fixed error",
  });
  await expect(request).rejects.toEqual({
    code: "unavailable",
    effect: "notDispatched",
  });
  expect(replacement.workspaceAccess.decisionManagement).toBe(true);
  expect(replacement.configuring).toBe(true);
  expect(replacement.configError).toBeNull();
  expect(s.workspaceAccess?.decisionManagement).toBe(true);
  expect(s.configuring).toBe(false);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("preserves real pending configuration and permission events when the trust reply reports success", async () => {
  const s = seed();
  const pending = deferred();
  h.invoke.mockReturnValue(pending.promise);
  const request = threads.decideWorkspaceAccess(s.key, "trust_repo", scope());
  const check = {
    status: "blocked",
    issues: [
      {
        id: "model",
        category: "model",
        reason: "unknown",
        expected: "chosen",
        current: null,
      },
    ],
    current: { choices: [] },
  };
  event(s, { kind: "configCheck", check });
  event(s, {
    kind: "permissionState",
    permissionConfigId: "permission",
    permissionState: "unknown",
  });
  pending.resolve(reply());
  await request;
  expect(s.configCheck).toBe(check);
  expect(s.modelDrift).toBe(true);
  expect(s.permissionState).toBe("unknown");
  expect(s.queuePaused).not.toBeNull();
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it.each([
  "key",
  "agentId",
  "cwd",
  "nativeSessionId",
  "connectionId",
  "serviceContext",
] as const)(
  "does not apply a late reply or its local unknown error to a changed %s",
  async (field) => {
    const s = seed();
    const pending = deferred();
    h.invoke.mockReturnValue(pending.promise);
    const request = threads.decideWorkspaceAccess(s.key, "trust_cwd", scope());
    s[field] = "replacement";
    pending.resolve(reply());
    await expect(request).rejects.toMatchObject({
      code: "changed",
      effect: "unconfirmed",
    });
    expect(s.configError).toBeNull();
    expect(s.configuring).toBe(false);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);

it("requires a fresh explicit review after another status read and never sends a stale scope", async () => {
  const s = seed();
  const { status, decisions } = await controls(s);
  expect(decisions.review("trust_repo")).toBe(true);
  h.invoke.mockResolvedValue(reply());
  expect(await status.read()).toBe(true);
  expect(await decisions.confirm()).toBe(false);
  expect(decisions.getSnapshot()).toMatchObject({
    phase: "error",
    error: { code: "scopeChanged", effect: "notDispatched" },
  });
  expect(
    h.invoke.mock.calls.every(
      ([command]) => command === "session_workspace_access_status",
    ),
  ).toBe(true);
});

it("keeps review cancellation local and blocks a withdrawn capability before confirmation", async () => {
  const s = seed();
  const { decisions } = await controls(s);
  expect(decisions.review("decline")).toBe(true);
  decisions.dismiss();
  expect(await decisions.confirm()).toBe(false);
  expect(decisions.review("trust_cwd")).toBe(true);
  s.workspaceAccess = {
    statusQuery: true,
    provenance: "reviewed-official-supplement",
  };
  expect(await decisions.confirm()).toBe(false);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
