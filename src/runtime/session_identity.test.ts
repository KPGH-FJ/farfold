import { beforeEach, expect, it, vi } from "vitest";
import { applyOpeningResult } from "./session_open_state";
import { applySessionEvent } from "./session_event_projection";
import {
  freshThreadState,
  applyConnectionLost,
  applyUpdate,
} from "./session_projection";
import {
  readSessionIdentity,
  reportedSessionIdentity,
} from "./session_identity";
import { forgetSessionIdentity } from "./session_identity_types";
import { SessionConfiguration } from "./session_configuration";
import { invoke } from "@tauri-apps/api/core";
import type { ThreadState } from "./session_types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const target = {
  agentId: "fixture",
  cwd: "/owned",
  sessionId: "native",
  connectionId: "live",
};
const identity = {
  email: "person@example.test",
  displayName: "Person",
  workspaceName: null,
  organizationName: "Org",
};
const reply = () => ({
  connectionId: "live",
  nativeSessionId: "native",
  cwd: "/owned",
  identity: { ...identity },
});
const deferred = () => {
  let resolve!: (v: unknown) => void;
  let reject!: (v: unknown) => void;
  const promise = new Promise<unknown>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fixture() {
  const owner = freshThreadState("own", "fixture", "/owned", "native");
  owner.connectionId = "live";
  owner.identityRead = { provenance: "reviewed-official-supplement" };
  let current: ThreadState | undefined = owner;
  const query = vi
    .fn<(args: typeof target) => Promise<unknown>>()
    .mockResolvedValue(reply());
  const emit = vi.fn();
  return {
    owner,
    query,
    emit,
    current: (value: ThreadState | undefined) => {
      current = value;
    },
    read: () => readSessionIdentity(owner, () => current, emit, query),
  };
}
beforeEach(() => vi.clearAllMocks());

it("reads only the existing owner and leaves configuration, source, queue and send guards intact", async () => {
  const f = fixture();
  f.owner.service = { id: "selected", fingerprint: "revision" } as never;
  f.owner.serviceContext = "service-context";
  f.owner.queuePaused = "stopped";
  const queue = f.owner.queued;
  const source = f.owner.service;
  expect(f.query).not.toHaveBeenCalled();
  expect(await f.read()).toBe(true);
  expect(f.query).toHaveBeenCalledExactlyOnceWith(target);
  expect(f.owner.sessionIdentityRead).toEqual({ phase: "reported", identity });
  expect(f.owner.service).toBe(source);
  expect(f.owner.queued).toBe(queue);
  expect(f.owner.queuePaused).toBe("stopped");
  expect(f.owner.connectionOutcomeUnknown).toBe(false);
  expect(f.owner.configuring).toBe(false);
  expect(f.owner.configCheck).toBeNull();
});

it.each([
  "missing-support",
  "unknown-provenance",
  "missing-native",
  "foreign-current",
])("does not invent an owner or method for %s", async (change) => {
  const f = fixture();
  if (change === "missing-support") f.owner.identityRead = null;
  if (change === "unknown-provenance")
    f.owner.identityRead = { provenance: "future" } as never;
  if (change === "missing-native") f.owner.nativeSessionId = "";
  if (change === "foreign-current") f.current({ ...f.owner });
  expect(await f.read()).toBe(false);
  expect(f.query).not.toHaveBeenCalled();
});

it.each([
  "running",
  "configuring",
  "stopUnconfirmed",
  "connectionOutcomeUnknown",
  "sourceError",
] as const)("does not bypass existing %s protection", async (field) => {
  const f = fixture();
  f.owner[field] = true;
  expect(await f.read()).toBe(false);
  expect(f.query).not.toHaveBeenCalled();
});

it("keeps one pending request on double click", async () => {
  const f = fixture();
  const pending = deferred();
  f.query.mockReturnValue(pending.promise);
  const first = f.read();
  expect(await f.read()).toBe(false);
  expect(f.query).toHaveBeenCalledTimes(1);
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
  "cannot publish after the same owner object changes %s",
  async (field) => {
    const f = fixture();
    const pending = deferred();
    f.query.mockReturnValue(pending.promise);
    const request = f.read();
    f.owner[field] = "replacement";
    pending.resolve(reply());
    expect(await request).toBe(false);
    expect(f.owner.sessionIdentityRead).toBeUndefined();
  },
);

it("does not update a sibling session on the same process, or a replacement owner", async () => {
  const f = fixture();
  const pending = deferred();
  f.query.mockReturnValue(pending.promise);
  const request = f.read();
  const next = {
    ...f.owner,
    key: "other",
    nativeSessionId: "other",
    sessionIdentityRead: { phase: "loading" as const },
  };
  f.current(next);
  pending.resolve(reply());
  expect(await request).toBe(false);
  expect(next.sessionIdentityRead.phase).toBe("loading");
  expect(f.owner.sessionIdentityRead).toBeUndefined();
});

it.each(["event", "raw", "legacy-mode"])(
  "retires both display and pending result before accepted %s A→B→A updates",
  async (surface) => {
    const f = fixture();
    const pending = deferred();
    f.query.mockReturnValue(pending.promise);
    const request = f.read();
    f.owner.modesSeparate = true;
    for (const value of ["B", "A"]) {
      const options = [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: value,
          options: [{ value, name: value }],
        },
      ];
      const event =
        surface === "event"
          ? { kind: "configOptions", options }
          : {
              update:
                surface === "raw"
                  ? {
                      sessionUpdate: "config_option_update",
                      configOptions: options,
                    }
                  : {
                      sessionUpdate: "current_mode_update",
                      currentModeId: value,
                    },
            };
      if (surface === "raw")
        applyUpdate(f.owner, (event as { update: unknown }).update);
      else applySessionEvent(f.owner, event, true);
    }
    expect(f.owner.sessionIdentityRead).toBeUndefined();
    const newer = { phase: "reported" as const, identity: null };
    f.owner.sessionIdentityRead = newer;
    pending.resolve(reply());
    expect(await request).toBe(false);
    expect(f.owner.sessionIdentityRead).toBe(newer);
  },
);

it("clears a prior report on owner rebind, and leaves no read action in a preview without support", async () => {
  const f = fixture();
  await f.read();
  applyOpeningResult(
    f.owner,
    { agentId: "fixture", cwd: "/owned" },
    {
      cwd: "/owned",
      nativeSessionId: "replacement",
      connectionId: "new",
      configOptions: [],
      resumed: true,
      warnings: [],
    },
    null,
  );
  expect(f.owner.sessionIdentityRead).toBeUndefined();
  expect(f.owner.identityRead).toBeNull();
  expect(await f.read()).toBe(false);
  expect(f.query).toHaveBeenCalledTimes(1);
});

it("clears reported information on connection loss without settling or clearing an unknown prompt", async () => {
  const f = fixture();
  await f.read();
  f.owner.running = true;
  applyConnectionLost(f.owner);
  expect(f.owner.sessionIdentityRead).toBeUndefined();
  expect(f.owner.connectionOutcomeUnknown).toBe(true);
});

it.each(["serviceUnavailable", "deliveryUnavailable", "configCheck"])(
  "clears the report when the actual %s protection is received",
  async (kind) => {
    const f = fixture();
    await f.read();
    applySessionEvent(
      f.owner,
      { kind, check: { status: "blocked", current: {}, issues: [] } },
      true,
    );
    expect(f.owner.sessionIdentityRead).toBeUndefined();
  },
);

it("clears before and after an accepted legacy setter reply even without any option notification", async () => {
  const f = fixture();
  await f.read();
  f.owner.modesSeparate = true;
  f.owner.configOptions = [
    {
      id: "mode",
      name: "Mode",
      type: "select",
      currentValue: "ask",
      options: [{ name: "Work", value: "work" }],
    },
  ];
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const configuration = new SessionConfiguration({
    thread: () => f.owner,
    emit: vi.fn(),
    finish: vi.fn(),
    permissionRevision: () => 0,
  });
  const request = configuration.set(f.owner.key, "mode", "work");
  expect(f.owner.sessionIdentityRead).toBeUndefined();
  // Even a separately retained observation may not survive the accepted reply.
  f.owner.sessionIdentityRead = { phase: "reported", identity };
  resolve(null);
  await request;
  expect(f.owner.currentModeId).toBe("work");
  expect(f.owner.sessionIdentityRead).toBeUndefined();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("session_set_mode", {
    agentId: "fixture",
    cwd: "/owned",
    sessionId: "native",
    modeId: "work",
  });
});

it("projects only nullable display fields, never credentials, opaque IDs, plan or arbitrary extras", () => {
  const raw = reply();
  Object.assign(raw.identity, {
    id: "opaque",
    plan: "paid",
    accessToken: "secret",
    token: "secret",
    workspace: { id: "opaque", name: "private" },
  });
  const safe = reportedSessionIdentity(raw, target);
  expect(safe).toEqual({ identity });
  expect(JSON.stringify(safe)).not.toMatch(/secret|opaque|paid|private/);
});

it.each([
  { identity: {} },
  { identity: { ...identity, email: "invalid email" } },
  { identity: { ...identity, displayName: "x".repeat(257) } },
  { identity: { ...identity, organizationName: "bad\nname" } },
  { identity: { ...identity, workspaceName: { token: "secret" } } },
  { nativeSessionId: "foreign" },
  { identity, unknown: "x".repeat(17000) },
])(
  "rejects malformed/foreign/oversized IPC identity without showing raw values",
  (patch) => {
    expect(
      reportedSessionIdentity({ ...reply(), ...patch }, target),
    ).toBeNull();
  },
);

it("keeps an empty official identity unknown, rather than signed out or ready to send", async () => {
  const f = fixture();
  f.query.mockResolvedValue({ ...reply(), identity: null });
  f.owner.configError = "keep original guard";
  expect(await f.read()).toBe(true);
  expect(f.owner.sessionIdentityRead).toEqual({
    phase: "reported",
    identity: null,
  });
  expect(f.owner.configError).toBe("keep original guard");
});

it("does not treat a timeout/transport exception as logout, prompt uncertainty or automatic retry", async () => {
  const f = fixture();
  for (const error of [
    { code: "timeout", message: "secret" },
    new Error("secret"),
  ]) {
    f.query.mockRejectedValue(error);
    expect(await f.read()).toBe(false);
    expect(JSON.stringify(f.owner.sessionIdentityRead)).not.toContain("secret");
    expect(f.owner.identityRead).not.toBeNull();
    expect(f.owner.connectionOutcomeUnknown).toBe(false);
  }
  expect(f.query).toHaveBeenCalledTimes(2); // Two explicit calls, no loop inside a read.
});

it("withdraws only this owner's supplementary action on typed unavailable, preserving other state", async () => {
  const f = fixture();
  f.query.mockRejectedValue({
    code: "unavailable",
    message: "fixed safe text",
  });
  expect(await f.read()).toBe(false);
  expect(f.owner.identityRead).toBeNull();
  expect(f.owner.sessionIdentityRead).toEqual({
    phase: "error",
    code: "unavailable",
  });
  expect(await f.read()).toBe(false);
  expect(f.query).toHaveBeenCalledTimes(1);
});

it("retires an unmounted read without publishing or clearing the next operation", async () => {
  const f = fixture();
  const pending = deferred();
  f.query.mockReturnValue(pending.promise);
  const request = f.read();
  forgetSessionIdentity(f.owner);
  f.current(undefined);
  f.emit.mockClear();
  pending.resolve(reply());
  expect(await request).toBe(false);
  expect(f.owner.sessionIdentityRead).toBeUndefined();
  expect(f.emit).not.toHaveBeenCalled();
});
