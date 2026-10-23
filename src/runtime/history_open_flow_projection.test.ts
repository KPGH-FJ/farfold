import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), projected: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));
import { threads, type OpenResult } from "./sessions";
import { draftPersistence } from "./drafts";
import { HistoryReplayProjection } from "./history_replay_projection";

type Args = Record<string, any>;
const agentId = "single-flow-projection";
const cwd = "/flow-projection";
const queueId = "0123456789abcdef0123456789abcdef";
const check = { status: "ready" as const, issues: [], current: {} };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function result(id: string): OpenResult {
  return {
    cwd,
    nativeSessionId: id,
    connectionId: `connection-${id}`,
    resumed: true,
    configOptions: [],
    configCheck: check,
    warnings: [],
  };
}
const message = (id: string) => ({
  sessionId: id,
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: id,
    content: { type: "text", text: id },
    _meta: { untouched: [id, null, { future: true }] },
  },
});
const header = (args: Args, opened: OpenResult) => ({
  kind: "sessionOpening",
  openToken: args.openToken,
  cwd: opened.cwd,
  sessionId: opened.nativeSessionId,
  connectionId: opened.connectionId,
});
const marker = (args: Args) => ({
  kind: "session_history_complete",
  openToken: args.openToken,
});
function nativeQueue() {
  const events: unknown[] = [];
  const acknowledgments: Args[] = [];
  let pulls = 0;
  let retired = false;
  const dispatch = (command: string, args: Args) => {
    if (command === "session_delivery_pull") {
      const event = events.shift();
      return event === undefined ? null : { sequence: String(++pulls), event };
    }
    if (command === "session_delivery_ack") {
      acknowledgments.push(args.receipt);
      return true;
    }
    if (command === "session_delivery_retire") {
      retired = true;
      return true;
    }
    if (command === "settings_get") return null;
    if (command === "agent_work_get") return { cwd, enabled: {} };
    return [];
  };
  const wake = (args: Args) =>
    args.channel.onmessage({
      farfoldDeliveryWake: { queueId, openToken: args.openToken },
    });
  return {
    events,
    acknowledgments,
    dispatch,
    wake,
    get pulls() {
      return pulls;
    },
    get retired() {
      return retired;
    },
  };
}

beforeEach(() => {
  h.invoke.mockReset();
  h.projected.mockClear();
  const push = HistoryReplayProjection.prototype.push;
  vi.spyOn(HistoryReplayProjection.prototype, "push").mockImplementation(
    function (this: HistoryReplayProjection, event: unknown) {
      h.projected(this.state, event);
      return push.call(this, event);
    },
  );
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

it("projects a long actual open delivery once before invoke resolves and transfers that same view", async () => {
  const id = "long-prefix";
  const opened = result(id);
  const reply = deferred<OpenResult>();
  const queue = nativeQueue();
  const count = 1024;
  const take = vi.spyOn(HistoryReplayProjection.prototype, "take");
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") {
      queue.events.push(header(args, opened));
      for (let i = 0; i < count; i++) queue.events.push(message(`long-${i}`));
      queue.events.push(marker(args));
      queue.wake(args);
      return reply.promise;
    }
    return queue.dispatch(command, args);
  });
  const pending = threads.open({ agentId, cwd, nativeSessionId: id });
  await vi.waitFor(() => expect(queue.acknowledgments).toHaveLength(count + 2));
  const updates = h.projected.mock.calls.filter(([, e]) => e?.update);
  expect(updates).toHaveLength(count);
  const hidden = updates[0][0];
  expect(updates.every(([state]) => state === hidden)).toBe(true);
  expect(
    hidden.items.filter((item: { kind: string }) => item.kind === "agent"),
  ).toHaveLength(count);
  expect(threads.thread(`${agentId}:${cwd}:${id}`)).toBeUndefined();
  reply.resolve(opened);
  const installed = await pending;
  expect(installed).toBe(hidden);
  expect(take).toHaveReturnedWith(installed);
  expect(h.projected.mock.calls.filter(([, e]) => e?.update)).toHaveLength(
    count,
  );
  expect(installed.items.at(-1)).toMatchObject({
    text: `long-${count - 1}`,
    time: 0,
    streaming: false,
  });
  expect(queue.acknowledgments.every((r) => r.outcome === "consumed")).toBe(
    true,
  );
  await threads.close(installed.key);
});

it("holds following native bodies until failed history has its old view, then preserves the original envelope", async () => {
  const id = "empty-prefix-following";
  const key = `${agentId}:${cwd}:${id}`;
  const old = threads.markOpenFailed(key, agentId, cwd, id, "retry");
  old.items.push({
    kind: "agent",
    id: "old",
    text: "Old body",
    streaming: false,
    time: 0,
  });
  const opened = result(id);
  const reply = deferred<OpenResult>();
  const queue = nativeQueue();
  const following = message("following-original");
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") {
      queue.events.push(header(args, opened), marker(args), following);
      queue.wake(args);
      return reply.promise;
    }
    return queue.dispatch(command, args);
  });
  const pending = threads.open({ agentId, cwd, nativeSessionId: id });
  const rejected = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(queue.acknowledgments).toHaveLength(2));
  await Promise.resolve();
  expect(queue.pulls).toBe(2);
  expect(queue.events).toEqual([following]);
  expect(old.items).toHaveLength(1);
  reply.resolve(opened);
  expect(await rejected).toBeInstanceOf(Error);
  await vi.waitFor(() => expect(queue.acknowledgments).toHaveLength(3));
  expect(threads.thread(key)).toBe(old);
  expect(old.historyUnavailable?.reason).toBe("empty");
  expect(old.items[0]).toMatchObject({ text: "Old body" });
  expect(old.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "raw", update: following }),
    ]),
  );
  expect(queue.retired).toBe(false);
  await threads.close(key);
});

it("keeps pulling past the fork marker so the same channel can settle and install its single child view", async () => {
  const id = "fork-parent";
  const parent = threads.markOpenFailed(
    `${agentId}:${cwd}:${id}`,
    agentId,
    cwd,
    id,
    "fixture",
  );
  Object.assign(parent, {
    openError: null,
    identity: "established",
    connectionId: `parent-${id}`,
    sessionOperations: { forkCurrentContext: true },
    configCheck: check,
  });
  const child = result("fork-child");
  const queue = nativeQueue();
  const count = 256;
  const take = vi.spyOn(HistoryReplayProjection.prototype, "take");
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_fork_current") {
      const ready = {
        status: "ready",
        operationId: args.operationId,
        parentConnectionId: args.connectionId,
        parentSessionId: args.parentSessionId,
        cwd,
        childSessionId: child.nativeSessionId,
        indexed: true,
        sourceReleased: true,
        session: child,
      };
      queue.events.push(header(args, child));
      for (let i = 0; i < count; i++) queue.events.push(message(`fork-${i}`));
      queue.events.push(marker(args), {
        kind: "forkResult",
        operationId: args.operationId,
        result: ready,
        settled: true,
      });
      queue.wake(args);
      return {
        ...ready,
        status: "unknown",
        indexed: false,
        sourceReleased: false,
        session: undefined,
      };
    }
    return queue.dispatch(command, args);
  });
  await threads.forkCurrent(parent.key);
  const key = `${agentId}:${cwd}:${child.nativeSessionId}`;
  await vi.waitFor(() => expect(threads.thread(key)).toBeDefined());
  await vi.waitFor(() => expect(queue.acknowledgments).toHaveLength(count + 3));
  const installed = threads.thread(key)!;
  const updates = h.projected.mock.calls.filter(([, e]) => e?.update);
  expect(updates).toHaveLength(count);
  expect(updates.every(([state]) => state === installed)).toBe(true);
  expect(take).toHaveReturnedWith(installed);
  expect(parent.forkOperation).toMatchObject({
    status: "ready",
    childKey: key,
  });
  expect(queue.acknowledgments.at(-1)).toMatchObject({
    outcome: "transferred_control",
  });
  await threads.close(key);
});

it.each([false, true])(
  "persists an unnamed history title only after the view is accepted (fork=%s)",
  async (fork) => {
    const id = `metadata-${fork}`;
    const opened = result(id);
    const reply = deferred<any>();
    const queue = nativeQueue();
    let returned: unknown;
    let parentKey = "";
    if (fork) {
      const parentId = `${id}-parent`;
      parentKey = `${agentId}:${cwd}:${parentId}`;
      const parent = threads.markOpenFailed(
        parentKey,
        agentId,
        cwd,
        parentId,
        "fixture",
      );
      Object.assign(parent, {
        openError: null,
        identity: "established",
        connectionId: `connection-${parentId}`,
        sessionOperations: { forkCurrentContext: true },
        configCheck: check,
      });
    }
    h.invoke.mockImplementation(async (command, args) => {
      if (command === (fork ? "session_fork_current" : "session_open")) {
        returned = fork
          ? {
              status: "ready",
              operationId: args.operationId,
              parentConnectionId: args.connectionId,
              parentSessionId: args.parentSessionId,
              cwd,
              childSessionId: id,
              indexed: true,
              sourceReleased: true,
              session: opened,
            }
          : opened;
        queue.events.push(
          header(args, opened),
          {
            update: {
              sessionUpdate: "session_info_update",
              title: "Official history title",
            },
          },
          message(`${id}-body`),
          marker(args),
        );
        queue.wake(args);
        return reply.promise;
      }
      return queue.dispatch(command, args);
    });
    const pending = fork
      ? threads.forkCurrent(parentKey)
      : threads.open({ agentId, cwd, nativeSessionId: id });
    await vi.waitFor(() => expect(queue.acknowledgments).toHaveLength(4));
    const touched = () =>
      h.invoke.mock.calls.filter(([command]) => command === "session_touch");
    expect(touched()).toHaveLength(0);
    reply.resolve(returned);
    const installed = await pending;
    expect(installed?.title).toBe("Official history title");
    expect(touched()).toEqual([
      [
        "session_touch",
        {
          agentId,
          cwd,
          sessionId: id,
          title: "Official history title",
          configOptions: null,
        },
      ],
    ]);
    await threads.close(installed!.key);
  },
);
