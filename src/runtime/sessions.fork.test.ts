import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), sequence: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type OpenResult, type ThreadState } from "./sessions";
import { composerDrafts, draftPersistence } from "./drafts";
import { hasActiveFork, receiveForkActivity } from "./session_fork_activity";
import { canDrain } from "./queue";
import { configChangeBusy } from "./protected_config";
import { sessionForkControl } from "./session_fork_ui";
import { openingInquiries } from "./opening_inquiries";

const access = threads as unknown as {
  applyChannelEvent(key: string, event: unknown, live?: boolean): void;
};
function seed(): ThreadState {
  const id = `fork-parent-${++h.sequence}`;
  const parent = threads.markOpenFailed(`a:/p:${id}`, "a", "/p", id, "fixture");
  parent.openError = null;
  parent.identity = "established";
  parent.connectionId = `connection-${id}`;
  parent.sessionOperations = { forkCurrentContext: true };
  parent.configCheck = { status: "ready", issues: [], current: {} };
  parent.items = [
    {
      kind: "agent",
      id: "parent-only",
      text: "Parent visible projection",
      streaming: false,
      time: 1,
    },
  ];
  return parent;
}
function beginChild(args: Record<string, any>) {
  const opened = response(args).session;
  args.channel.onmessage({
    kind: "sessionOpening",
    openToken: args.openToken,
    cwd: opened.cwd,
    sessionId: opened.nativeSessionId,
    connectionId: opened.connectionId,
  });
}
function ready(args: Record<string, any>, overrides: Partial<OpenResult> = {}) {
  beginChild(args);
  args.channel.onmessage({
    sessionId: `child-${args.parentSessionId}`,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Actual independent load replay" },
    },
  });
  args.channel.onmessage({
    kind: "session_history_complete",
    openToken: args.openToken,
  });
  return response(args, overrides);
}
function response(
  args: Record<string, any>,
  overrides: Partial<OpenResult> = {},
) {
  return {
    status: "ready",
    operationId: args.operationId,
    parentConnectionId: args.connectionId,
    parentSessionId: args.parentSessionId,
    cwd: args.cwd,
    childSessionId: `child-${args.parentSessionId}`,
    indexed: true,
    sourceReleased: true,
    session: {
      nativeSessionId: `child-${args.parentSessionId}`,
      connectionId: `independent-${args.parentSessionId}`,
      cwd: args.cwd,
      resumed: true,
      configOptions: [],
      configCheck: { status: "ready", issues: [], current: {} },
      warnings: [],
      service: null,
      permissionConfigId: "permission",
      permissionState: "ready",
      ...overrides,
    },
  };
}
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  h.invoke.mockImplementation(
    async (command: string, args: Record<string, any>) => {
      if (command === "session_fork_current") return ready(args);
      return command === "settings_get" ? null : [];
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  h.invoke.mockReset();
});

it("loads actual child history once, preserving the entire parent input and projection", async () => {
  const parent = seed();
  parent.queued = [[{ type: "text", text: "Keep queue" }]];
  parent.queuePaused = "stopped";
  composerDrafts.update(`session:${parent.key}`, (draft) => ({
    ...draft,
    text: "Keep draft",
  }));
  const before = structuredClone({
    items: parent.items,
    queued: parent.queued,
    pause: parent.queuePaused,
  });
  const result = await threads.forkCurrent(parent.key);
  expect(result?.nativeSessionId).toBe(`child-${parent.nativeSessionId}`);
  expect(result?.connectionId).not.toBe(parent.connectionId);
  expect(
    result?.items
      .filter((item) => item.kind === "agent")
      .map((item) => item.text),
  ).toEqual(["Actual independent load replay"]);
  expect(result?.queued).toEqual([]);
  expect(result?.permissionState).toBe("required");
  expect(result?.identity).toBe("established");
  expect(result?.items.some((item) => "time" in item && item.time !== 0)).toBe(
    false,
  );
  expect({
    items: parent.items,
    queued: parent.queued,
    pause: parent.queuePaused,
  }).toEqual(before);
  expect(composerDrafts.read(`session:${parent.key}`).text).toBe("Keep draft");
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "session_fork_current",
    ),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.some(
      ([command]) => command === "session_open" || command === "session_prompt",
    ),
  ).toBe(false);
  const opened = vi.fn();
  sessionForkControl(parent, opened)?.openChild?.();
  expect(opened).toHaveBeenCalledWith(result?.key);
});

it.each([
  ["running", true],
  ["submitting", true],
  ["configuring", true],
  ["reconnecting", true],
  ["stopping", true],
  ["stopUnconfirmed", true],
  ["connectionLost", true],
  ["connectionOutcomeUnknown", true],
  ["modelDrift", true],
  ["workEnabled", false],
] as const)("rejects %s before any copy request", async (key, value) => {
  const parent = seed();
  parent[key] = value;
  expect(await threads.forkCurrent(parent.key)).toBeUndefined();
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_fork_current"),
  ).toBe(false);
});

it("blocks configuration, queued dispatch, archive and close while one request is outstanding", async () => {
  const parent = seed();
  let finish!: (result: unknown) => void;
  h.invoke.mockImplementation((command: string, args: Record<string, any>) =>
    command === "session_fork_current"
      ? new Promise((resolve) => {
          finish = () => resolve(ready(args));
        })
      : Promise.resolve(command === "settings_get" ? null : []),
  );
  const request = threads.forkCurrent(parent.key);
  expect(threads.forkCurrent(parent.key)).toBe(request);
  parent.queued = [[{ type: "text", text: "not sent" }]];
  expect(hasActiveFork(parent)).toBe(true);
  expect(configChangeBusy(parent)).toBe(true);
  expect(canDrain(parent)).toBe(false);
  expect(threads.archiveBlockReason(parent.key)).toBeTruthy();
  await expect(threads.close(parent.key)).rejects.toThrow();
  expect(threads.thread(parent.key)).toBe(parent);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  finish(undefined);
  await request;
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "session_fork_current",
    ),
  ).toHaveLength(1);
});

it("preserves the user's queue pause when continue is requested during a copy", async () => {
  const parent = seed();
  parent.queued = [
    [{ type: "text", text: "Keep paused until explicit continuation" }],
  ];
  parent.queuePaused = "stopped";
  let finish!: () => void;
  h.invoke.mockImplementation((command: string, args: Record<string, any>) =>
    command === "session_fork_current"
      ? new Promise((resolve) => {
          finish = () => resolve(ready(args));
        })
      : Promise.resolve(command === "settings_get" ? null : []),
  );
  const request = threads.forkCurrent(parent.key);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const queued = structuredClone(parent.queued);
  await threads.continueQueue(parent.key);
  const pauseWhileCopying = parent.queuePaused;
  finish();
  await request;
  expect(pauseWhileCopying).toBe("stopped");
  expect(parent.queuePaused).toBe("stopped");
  expect(parent.queued).toEqual(queued);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("rechecks saved input and configuration after the persistence wait", async () => {
  const parent = seed();
  let flush!: () => void;
  vi.mocked(draftPersistence.flush).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        flush = resolve;
      }),
  );
  const request = threads.forkCurrent(parent.key);
  parent.configOptions = [
    {
      id: "model",
      name: "changed",
      type: "select",
      currentValue: "changed",
      options: [],
    },
  ];
  flush();
  await request;
  expect(parent.forkOperation?.status).toBe("rejected");
  expect(hasActiveFork(parent)).toBe(false);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_fork_current"),
  ).toBe(false);
});

it("retains an unknown dispatch without retrying or allowing a late ordinary ending to clear it", async () => {
  const parent = seed();
  h.invoke.mockImplementation(async (command: string) => {
    if (command === "session_fork_current") throw new Error("lost reply");
    return command === "settings_get" ? null : [];
  });
  await threads.forkCurrent(parent.key);
  access.applyChannelEvent(parent.key, {
    kind: "turnEnd",
    stopReason: "end_turn",
  });
  expect(parent.forkOperation?.status).toBe("unknown");
  expect(hasActiveFork(parent)).toBe(true);
  await threads.forkCurrent(parent.key);
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "session_fork_current",
    ),
  ).toHaveLength(1);
});

it.each(["source_load_failed", "source_close_failed", "index_failed"])(
  "keeps the known child and owner protection on %s",
  async (reason) => {
    const parent = seed();
    h.invoke.mockImplementation(
      async (command: string, args: Record<string, any>) =>
        command === "session_fork_current"
          ? {
              ...ready(args),
              status: "created_unavailable",
              sourceReleased: false,
              indexed: reason !== "index_failed",
              session: null,
              reason,
            }
          : command === "settings_get"
            ? null
            : [],
    );
    expect(await threads.forkCurrent(parent.key)).toBeUndefined();
    expect(parent.forkOperation?.childSessionId).toBe(
      `child-${parent.nativeSessionId}`,
    );
    expect(hasActiveFork(parent)).toBe(true);
    const control = sessionForkControl(parent, vi.fn());
    expect(control?.phase).toBe("created-unavailable");
    expect(control?.openChild).toBeUndefined();
    expect(control?.continue).toBeUndefined();
  },
);

it.each([
  { connectionId: "foreign" },
  { resumed: false },
  { cwd: "/elsewhere" },
  { nativeSessionId: "wrong-child" },
  { service: { id: "another", model: "x", fingerprint: "x" } },
] as Partial<OpenResult>[])(
  "does not adopt an inconsistent child receipt: %j",
  async (patch) => {
    const parent = seed();
    if (patch.connectionId) patch = { connectionId: parent.connectionId };
    h.invoke.mockImplementation(
      async (command: string, args: Record<string, any>) =>
        command === "session_fork_current"
          ? ready(args, patch)
          : command === "settings_get"
            ? null
            : [],
    );
    expect(await threads.forkCurrent(parent.key)).toBeUndefined();
    expect(parent.forkOperation?.status).toBe("created_unavailable");
    expect(parent.forkOperation?.childKey).toBeUndefined();
  },
);

it("matches late fork activity to the exact operation and owner, never a new selected conversation", async () => {
  const parent = seed();
  h.invoke.mockImplementation(async (command: string) => {
    if (command === "session_fork_current") throw new Error("lost");
    return command === "settings_get" ? null : [];
  });
  await threads.forkCurrent(parent.key);
  const op = parent.forkOperation!;
  const receipt = {
    kind: "forkActivity",
    connectionId: parent.connectionId,
    sessionId: parent.nativeSessionId,
    operationId: op.operationId,
    state: "finished",
    sourceReleased: true,
    childSessionId: "late-child",
    indexed: true,
  };
  for (const patch of [
    { operationId: "old" },
    { connectionId: "other" },
    { sessionId: "other" },
    { childSessionId: parent.nativeSessionId },
  ])
    expect(receiveForkActivity(parent, { ...receipt, ...patch })).toBe(false);
  expect(hasActiveFork(parent)).toBe(true);
  expect(receiveForkActivity(parent, receipt)).toBe(true);
  expect(op.childSessionId).toBe("late-child");
  expect(op.indexed).toBe(true);
  expect(op.status).toBe("unknown");
  // Closing only the source does not finish the destination opening.
  expect(hasActiveFork(parent)).toBe(true);
  expect(sessionForkControl(parent, vi.fn())?.openChild).toBeUndefined();
});

it("keeps a late opening inquiry actionable after the first RPC reports unknown", async () => {
  const parent = seed();
  let args!: Record<string, any>;
  h.invoke.mockImplementation(
    async (command: string, value: Record<string, any>) => {
      if (command !== "session_fork_current")
        return command === "settings_get" ? null : [];
      args = value;
      return {
        status: "unknown",
        operationId: args.operationId,
        parentConnectionId: args.connectionId,
        parentSessionId: args.parentSessionId,
        cwd: args.cwd,
        childSessionId: `child-${args.parentSessionId}`,
        indexed: true,
        sourceReleased: false,
      };
    },
  );
  await threads.forkCurrent(parent.key);
  const requestId = `late-${parent.nativeSessionId}`;
  args.channel.onmessage({
    kind: "forkSourceEvent",
    operationId: args.operationId,
    childSessionId: `child-${args.parentSessionId}`,
    event: {
      kind: "elicitation",
      requestId,
      message: "Choose",
      owner: {
        sessionId: `child-${args.parentSessionId}`,
        connectionId: args.connectionId,
        requestId: 7,
      },
    },
  });
  expect(
    h.invoke.mock.calls.some(
      ([command]) => command === "session_elicitation_respond",
    ),
  ).toBe(false);
  expect(
    openingInquiries
      .getSnapshot()
      .some((view) =>
        view.requests.some((request) => request.requestId === requestId),
      ),
  ).toBe(true);
});

it("adopts a late final result using the same channel and matching replay without a second fork", async () => {
  const parent = seed();
  let args!: Record<string, any>;
  h.invoke.mockImplementation(
    async (command: string, value: Record<string, any>) => {
      if (command !== "session_fork_current")
        return command === "settings_get" ? null : [];
      args = value;
      return {
        status: "unknown",
        operationId: args.operationId,
        parentConnectionId: args.connectionId,
        parentSessionId: args.parentSessionId,
        cwd: args.cwd,
        indexed: false,
        sourceReleased: false,
      };
    },
  );
  await threads.forkCurrent(parent.key);
  args.channel.onmessage({
    kind: "forkResult",
    operationId: args.operationId,
    result: ready(args),
    settled: true,
  });
  await vi.waitFor(() => expect(parent.forkOperation?.status).toBe("ready"));
  const child = threads.thread(parent.forkOperation!.childKey!);
  expect(
    child?.items.some(
      (item) =>
        item.kind === "agent" && item.text === "Actual independent load replay",
    ),
  ).toBe(true);
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "session_fork_current",
    ),
  ).toHaveLength(1);
});

it("does not count wrapped source replay as readable independent history", async () => {
  const parent = seed();
  h.invoke.mockImplementation(
    async (command: string, args: Record<string, any>) => {
      if (command !== "session_fork_current")
        return command === "settings_get" ? null : [];
      args.channel.onmessage({
        kind: "forkSourceEvent",
        operationId: args.operationId,
        childSessionId: `child-${args.parentSessionId}`,
        event: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Intermediate only" },
          },
        },
      });
      beginChild(args);
      args.channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      return response(args);
    },
  );
  expect(await threads.forkCurrent(parent.key)).toBeUndefined();
  expect(parent.forkOperation?.status).toBe("created_unavailable");
  expect(
    parent.items.some(
      (item) => item.kind === "agent" && item.text.includes("Intermediate"),
    ),
  ).toBe(false);
});

it("requires the matching channel marker even if the ready RPC arrives first", async () => {
  const parent = seed();
  let args!: Record<string, any>;
  h.invoke.mockImplementation(
    async (command: string, value: Record<string, any>) => {
      if (command !== "session_fork_current")
        return command === "settings_get" ? null : [];
      args = value;
      beginChild(args);
      args.channel.onmessage({
        sessionId: `child-${args.parentSessionId}`,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Replay" },
        },
      });
      return response(args);
    },
  );
  const request = threads.forkCurrent(parent.key);
  await vi.waitFor(() => expect(args).toBeDefined());
  args.channel.onmessage({
    kind: "session_history_complete",
    openToken: "old-open-token",
  });
  expect(parent.forkOperation?.childKey).toBeUndefined();
  args.channel.onmessage({
    kind: "session_history_complete",
    openToken: args.openToken,
  });
  expect((await request)?.nativeSessionId).toBe(
    `child-${parent.nativeSessionId}`,
  );
});

it("needs a new explicit confirmation with a new owner before another known-safe copy", async () => {
  const parent = seed();
  const open = vi.fn();
  const first = sessionForkControl(parent, open)!;
  await threads.forkCurrent(parent.key);
  const completed = sessionForkControl(parent, open)!;
  expect(completed.owner).toBe(first.owner);
  expect(completed.phase).toBe("ready");
  completed.prepareNew?.();
  const next = sessionForkControl(parent, open)!;
  expect(next.phase).toBe("idle");
  expect(next.owner).not.toBe(completed.owner);
  expect(first.isCurrent()).toBe(false);
  first.start();
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "session_fork_current",
    ),
  ).toHaveLength(1);
  expect(open).not.toHaveBeenCalled();
});

it("keeps a non-readable or interrupted replay from becoming a ready child", async () => {
  const parent = seed();
  h.invoke.mockImplementation(
    async (command: string, args: Record<string, any>) => {
      if (command !== "session_fork_current")
        return command === "settings_get" ? null : [];
      const result = ready(args);
      args.channel.onmessage({ kind: "connectionLost" });
      return result;
    },
  );
  expect(await threads.forkCurrent(parent.key)).toBeUndefined();
  expect(parent.forkOperation?.childKey).toBeUndefined();
  expect(parent.forkOperation?.childSessionId).toBeDefined();
});

it("does not let a late old RPC erase a newly confirmed copy operation", async () => {
  const parent = seed();
  const calls: {
    args: Record<string, any>;
    resolve: (value: unknown) => void;
  }[] = [];
  h.invoke.mockImplementation((command: string, args: Record<string, any>) =>
    command === "session_fork_current"
      ? new Promise((resolve) => {
          calls.push({ args, resolve });
        })
      : Promise.resolve(command === "settings_get" ? null : []),
  );
  const first = threads.forkCurrent(parent.key);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  const completed = ready(calls[0].args);
  calls[0].args.channel.onmessage({
    kind: "forkResult",
    operationId: calls[0].args.operationId,
    result: completed,
    settled: true,
  });
  await vi.waitFor(() => expect(parent.forkOperation?.status).toBe("ready"));
  sessionForkControl(parent, vi.fn())?.prepareNew?.();
  expect(parent.forkOperation).toBeUndefined();
  const second = threads.forkCurrent(parent.key);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  calls[0].resolve(completed);
  await first;
  expect(threads.forkCurrent(parent.key)).toBe(second);
  calls[1].resolve({
    ...response(calls[1].args),
    status: "rejected",
    childSessionId: null,
    session: null,
    indexed: false,
  });
  await second;
  expect(parent.forkOperation?.operationId).toBe(calls[1].args.operationId);
  expect(parent.forkOperation?.status).toBe("rejected");
});

it("retains unknown copy identity but allows parent recovery only after its actual owner ends", async () => {
  const parent = seed();
  let args!: Record<string, any>;
  h.invoke.mockImplementation(
    async (command: string, value: Record<string, any>) => {
      if (command !== "session_fork_current")
        return command === "settings_get" ? null : [];
      args = value;
      return {
        ...response(args),
        status: "unknown",
        childSessionId: "known-child-after-owner-ended",
        session: null,
        sourceReleased: false,
      };
    },
  );
  await threads.forkCurrent(parent.key);
  access.applyChannelEvent(parent.key, { kind: "connectionLost" });
  expect(hasActiveFork(parent)).toBe(true);
  args.channel.onmessage({
    kind: "forkResult",
    operationId: args.operationId,
    result: {
      ...response(args),
      status: "unknown",
      childSessionId: "known-child-after-owner-ended",
      session: null,
      sourceReleased: false,
      reason: "owner_ended",
    },
    settled: true,
  });
  await vi.waitFor(() => expect(parent.forkOperation?.ownerEnded).toBe(true));
  expect(hasActiveFork(parent)).toBe(false);
  expect(parent.forkOperation?.childSessionId).toBe(
    "known-child-after-owner-ended",
  );
  expect(sessionForkControl(parent, vi.fn())?.prepareNew).toBeUndefined();
});

it("presents the fork request's pre-child inquiry with its actual request-scoped owner", async () => {
  const parent = seed();
  const requestId = `fork-request-inquiry-${parent.nativeSessionId}`;
  h.invoke.mockImplementation(
    async (command: string, args: Record<string, any>) => {
      if (command !== "session_fork_current")
        return command === "settings_get" ? null : [];
      args.channel.onmessage({
        kind: "forkSourceEvent",
        operationId: args.operationId,
        childSessionId: null,
        event: {
          kind: "elicitation",
          requestId,
          message: "Copy request needs a choice",
          owner: { connectionId: args.connectionId, requestId: "17" },
        },
      });
      args.channel.onmessage({
        kind: "forkSourceEvent",
        operationId: args.operationId,
        childSessionId: null,
        event: {
          kind: "elicitation",
          requestId: requestId + "-foreign",
          owner: { connectionId: "foreign", requestId: "18" },
        },
      });
      return {
        ...response(args),
        status: "unknown",
        childSessionId: null,
        session: null,
        indexed: false,
        sourceReleased: false,
      };
    },
  );
  await threads.forkCurrent(parent.key);
  const view = openingInquiries
    .getSnapshot()
    .find((view) => view.requests.some((item) => item.requestId === requestId));
  expect(view).toBeDefined();
  expect(
    view?.requests.find((item) => item.requestId === requestId)?.owner,
  ).toEqual({ connectionId: parent.connectionId, requestId: "17" });
  expect(
    view?.requests.some((item) => item.requestId.endsWith("-foreign")),
  ).toBe(false);
  await openingInquiries.owner(view!.id)?.reply(requestId, "decline");
  expect(h.invoke).toHaveBeenCalledWith(
    "session_elicitation_respond",
    expect.objectContaining({
      requestId,
      sessionId: null,
      requestOwner: { connectionId: parent.connectionId, requestId: "17" },
      action: "decline",
    }),
  );
});

it("hides current-context copy for an unestablished draft even when the Agent declares the capability", () => {
  const parent = seed();
  parent.identity = "draft";
  expect(sessionForkControl(parent, vi.fn())).toBeNull();
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_fork_current"),
  ).toBe(false);
});

it("does not regress a settled destination failure when an older unknown RPC or activity arrives", async () => {
  const parent = seed();
  let args!: Record<string, any>;
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation((command: string, value: Record<string, any>) =>
    command === "session_fork_current"
      ? new Promise((resolve) => {
          args = value;
          finish = resolve;
        })
      : Promise.resolve(command === "settings_get" ? null : []),
  );
  const request = threads.forkCurrent(parent.key);
  await vi.waitFor(() => expect(args).toBeDefined());
  const oldUnknown = {
    ...response(args),
    status: "unknown",
    sourceReleased: false,
    session: null,
    reason: "pending",
  };
  args.channel.onmessage({
    kind: "forkResult",
    operationId: args.operationId,
    settled: true,
    result: {
      ...response(args),
      status: "created_unavailable",
      session: null,
      reason: "destination_open_failed",
    },
  });
  await vi.waitFor(() =>
    expect(parent.forkOperation?.status).toBe("created_unavailable"),
  );
  expect(hasActiveFork(parent)).toBe(false);
  finish(oldUnknown);
  await request;
  expect(parent.forkOperation?.status).toBe("created_unavailable");
  access.applyChannelEvent(parent.key, {
    kind: "forkActivity",
    connectionId: args.connectionId,
    sessionId: args.parentSessionId,
    operationId: args.operationId,
    state: "unknown",
    sourceReleased: false,
  });
  expect(parent.forkOperation?.status).toBe("created_unavailable");
  expect(hasActiveFork(parent)).toBe(false);
});

it("retains a late known child ID after actual owner termination without reopening the settled operation", async () => {
  const parent = seed();
  let args!: Record<string, any>;
  h.invoke.mockImplementation(
    async (command: string, value: Record<string, any>) => {
      if (command !== "session_fork_current")
        return command === "settings_get" ? null : [];
      args = value;
      return {
        ...response(args),
        status: "unknown",
        childSessionId: null,
        session: null,
        indexed: false,
        sourceReleased: false,
      };
    },
  );
  await threads.forkCurrent(parent.key);
  const ended = {
    ...response(args),
    status: "unknown",
    childSessionId: null,
    session: null,
    indexed: false,
    sourceReleased: false,
    reason: "owner_ended",
  };
  args.channel.onmessage({
    kind: "forkResult",
    operationId: args.operationId,
    settled: true,
    result: ended,
  });
  await vi.waitFor(() => expect(parent.forkOperation?.ownerEnded).toBe(true));
  args.channel.onmessage({
    kind: "forkResult",
    operationId: args.operationId,
    settled: true,
    result: {
      ...ended,
      childSessionId: "known-late-after-reap",
      indexed: true,
    },
  });
  await vi.waitFor(() =>
    expect(parent.forkOperation?.childSessionId).toBe("known-late-after-reap"),
  );
  expect(parent.forkOperation?.indexed).toBe(true);
  expect(parent.forkOperation?.status).toBe("unknown");
  expect(parent.forkOperation?.sourceReleased).toBe(false);
  expect(hasActiveFork(parent)).toBe(false);
  expect(sessionForkControl(parent, vi.fn())?.prepareNew).toBeUndefined();
});

it.each([
  "session_history_complete",
  "forkResult",
  "forkSourceEvent",
  "turnEnd",
  "permissionState",
  "connectionLost",
])(
  "preserves independent child raw update despite top kind %s",
  async (kind) => {
    const parent = seed();
    const before = structuredClone({
      items: parent.items,
      configOptions: parent.configOptions,
      permissionState: parent.permissionState,
    });
    const raw = {
      sessionUpdate: "future_fork_raw",
      kind,
      value: [null, "FORK_RAW_OWNED_VISIBLE", { untouched: true }],
    };
    let wire!: Record<string, any>;
    h.invoke.mockImplementation(
      async (command: string, args: Record<string, any>) => {
        if (command !== "session_fork_current")
          return command === "settings_get" ? null : [];
        wire = args;
        beginChild(args);
        args.channel.onmessage({
          sessionId: `child-${args.parentSessionId}`,
          kind,
          openToken:
            kind === "session_history_complete"
              ? args.openToken
              : "foreign-token",
          operationId: "foreign-operation",
          update: raw,
        });
        return ready(args);
      },
    );
    const child = await threads.forkCurrent(parent.key);
    expect(
      child?.items.some((item) => item.kind === "raw" && item.update === raw),
    ).toBe(true);
    const live = { sessionUpdate: "future_fork_live_raw", value: [7, null] };
    wire.channel.onmessage({
      sessionId: child!.nativeSessionId,
      kind,
      operationId: "foreign-operation",
      openToken: wire.openToken,
      update: live,
    });
    expect(
      child?.items.some((item) => item.kind === "raw" && item.update === live),
    ).toBe(true);
    expect({
      items: parent.items,
      configOptions: parent.configOptions,
      permissionState: parent.permissionState,
    }).toEqual(before);
  },
);

it("wrapped source updates cannot become local inquiries or independent child replay", async () => {
  const parent = seed();
  const requestId = `raw-wrapped-inquiry-${parent.nativeSessionId}`;
  const sourceRaw = {
    sessionUpdate: "future_source_only",
    body: "NOT_CHILD_HISTORY",
  };
  const observed: boolean[] = [];
  h.invoke.mockImplementation(
    async (command: string, args: Record<string, any>) => {
      if (command !== "session_fork_current")
        return command === "settings_get" ? null : [];
      for (const childSessionId of [null, `child-${args.parentSessionId}`]) {
        args.channel.onmessage({
          kind: "forkSourceEvent",
          operationId: args.operationId,
          childSessionId,
          event: {
            kind: "elicitation",
            requestId,
            owner: { connectionId: args.connectionId, requestId: "17" },
            message: "RAW_NOT_LOCAL_QUESTION",
            update: sourceRaw,
          },
        });
        observed.push(
          openingInquiries
            .getSnapshot()
            .some((view) =>
              view.requests.some((request) => request.requestId === requestId),
            ),
        );
      }
      return ready(args);
    },
  );
  const child = await threads.forkCurrent(parent.key);
  expect(observed).toEqual([false, false]);
  expect(
    child?.items.some(
      (item) =>
        item.kind === "agent" && item.text === "Actual independent load replay",
    ),
  ).toBe(true);
  expect(
    child?.items.some(
      (item) => item.kind === "raw" && item.update === sourceRaw,
    ),
  ).toBe(false);
  expect(
    parent.items.some(
      (item) =>
        item.kind === "agent" && item.text === "Parent visible projection",
    ),
  ).toBe(true);
});

it.each(["tool", "config"] as const)(
  "does not install a child when %s conversion fails during original fork precheck",
  async (kind) => {
    const parent = seed();
    const originalItems = parent.items;
    const originalItem = parent.items[0];
    h.invoke.mockImplementation(
      async (command: string, args: Record<string, any>) => {
        if (command !== "session_fork_current")
          return command === "settings_get" ? null : [];
        beginChild(args);
        const bad = JSON.parse('{"toString":null,"valueOf":null}');
        args.channel.onmessage({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "READABLE BEFORE FAILURE" },
          },
        });
        args.channel.onmessage({
          update:
            kind === "tool"
              ? { sessionUpdate: "tool_call", toolCallId: bad }
              : {
                  sessionUpdate: "config_option_update",
                  configOptions: [
                    {
                      id: bad,
                      name: "owned",
                      type: "boolean",
                      currentValue: false,
                    },
                  ],
                },
        });
        args.channel.onmessage({
          kind: "session_history_complete",
          openToken: args.openToken,
        });
        return response(args);
      },
    );
    expect(await threads.forkCurrent(parent.key)).toBeUndefined();
    const childKey = `${parent.agentId}:${parent.cwd}:child-${parent.nativeSessionId}`;
    expect(threads.thread(childKey)).toBeUndefined();
    expect(threads.thread(parent.key)).toBe(parent);
    expect(parent.items).toBe(originalItems);
    expect(parent.items[0]).toBe(originalItem);
    expect(parent.forkOperation?.status).toBe("created_unavailable");
    expect(parent.forkOperation?.reason).toBe("delivery_failed");
  },
);
