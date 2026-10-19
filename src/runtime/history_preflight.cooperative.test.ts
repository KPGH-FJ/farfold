import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), sequence: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type OpenResult, type ThreadState } from "./sessions";
import { draftPersistence } from "./drafts";
import { previewHistory } from "./history_import";
import { requireReadableHistory } from "./session_recovery";
import type { ForkResult } from "./session_fork_types";

interface Wire {
  channel: { onmessage(event: unknown): void };
  admissionChannel?: { onmessage(event: unknown): void };
  openToken: string;
  operationId: string;
  connectionId: string;
  parentSessionId: string;
  cwd: string;
}
const SIZE = 80;
const message = (id: string) => ({
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: id,
    content: { type: "text", text: id },
  },
});
const raw = () => ({
  update: {
    sessionUpdate: "future_history_work",
    exact: [null, "中文🙂", { value: false }],
  },
  unknownEnvelope: { own: true },
});
function deliverPrefix(wire: Wire, extra?: unknown) {
  for (let index = 0; index < SIZE; index++)
    wire.channel.onmessage(message(`history-${index}`));
  if (extra) wire.channel.onmessage(extra);
  wire.channel.onmessage({
    kind: "session_history_complete",
    openToken: wire.openToken,
  });
}
function nextTask<T>(observe: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(observe());
      } catch (error) {
        reject(error);
      }
    }, 0);
  });
}
function seed(label: string): ThreadState {
  const id = `${label}-${++h.sequence}`;
  const state = threads.markOpenFailed(
    `cooperative-history:/owned:${id}`,
    "cooperative-history",
    "/owned",
    id,
    "fixture",
  );
  state.items = [
    {
      kind: "agent",
      id: "original",
      text: "Original body",
      streaming: false,
      time: 0,
    },
  ];
  state.queued = [[{ type: "text", text: "Original paused input" }]];
  state.queuePaused = "stopped";
  return state;
}
function openResult(state: ThreadState): OpenResult {
  return {
    nativeSessionId: state.nativeSessionId,
    connectionId: `connection-${state.nativeSessionId}`,
    cwd: state.cwd,
    resumed: true,
    configOptions: [],
    warnings: [],
    service: null,
  };
}
const historyText = (state: ThreadState) =>
  state.items.flatMap((item) => (item.kind === "agent" ? [item.text] : []));
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

it("lets a real task run during open's full precheck while preserving the old owner and exact prefix/live order", async () => {
  const prior = seed("open");
  const originalItems = prior.items;
  const originalQueue = prior.queued;
  const opaque = raw();
  let settled = false;
  let checkpoint!: Promise<{
    settled: boolean;
    oldOwner: boolean;
    oldItems: boolean;
    acknowledged: boolean;
  }>;
  h.invoke.mockImplementation(async (command: string, wire: Wire) => {
    if (command === "session_history_delivery_ack")
      return {
        openToken: wire.openToken,
        receiptId: 77,
        outcome: "acknowledged",
      };
    if (command !== "session_open") return [];
    wire.admissionChannel!.onmessage({
      kind: "session_history_admission",
      openToken: wire.openToken,
      phase: "starting",
      historyDelivery: { openToken: wire.openToken, receiptId: 77 },
    });
    deliverPrefix(wire, opaque);
    checkpoint = nextTask(() => {
      const observed = {
        settled,
        oldOwner: threads.thread(prior.key) === prior,
        oldItems: prior.items === originalItems,
        acknowledged: h.invoke.mock.calls.some(
          ([name]) => name === "session_history_delivery_ack",
        ),
      };
      wire.channel.onmessage(message("Live following, never precheck history"));
      return observed;
    });
    return openResult(prior);
  });
  const pending = threads.open({
    agentId: prior.agentId,
    cwd: prior.cwd,
    nativeSessionId: prior.nativeSessionId,
  });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await expect(checkpoint).resolves.toEqual({
    settled: false,
    oldOwner: true,
    oldItems: true,
    acknowledged: false,
  });
  const opened = await pending;
  expect(historyText(opened)).toEqual([
    ...Array.from({ length: SIZE }, (_, index) => `history-${index}`),
    "Live following, never precheck history",
  ]);
  expect(
    opened.items.some(
      (item) => item.kind === "raw" && item.update === opaque.update,
    ),
  ).toBe(true);
  expect(opened.queued).toBe(originalQueue);
  expect(
    h.invoke.mock.calls.filter(
      ([name]) => name === "session_history_delivery_ack",
    ),
  ).toHaveLength(1);
  expect(
    opened.items
      .filter(
        (item) => item.kind === "agent" && item.text.startsWith("history-"),
      )
      .every((item) => "time" in item && item.time === 0),
  ).toBe(true);
  expect(opened.items.at(-1)).toMatchObject({
    text: "Live following, never precheck history",
    streaming: true,
  });
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_open"),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("does not admit a prefix when the same original channel reports loss during cooperative precheck", async () => {
  const prior = seed("lost");
  const originalItems = prior.items;
  const originalQueue = prior.queued;
  let checkpoint!: Promise<void>;
  h.invoke.mockImplementation(async (command: string, wire: Wire) => {
    if (command !== "session_open") return [];
    deliverPrefix(wire);
    checkpoint = nextTask(() =>
      wire.channel.onmessage({
        kind: "connectionLost",
        closeReason: "unexpected",
      }),
    );
    return openResult(prior);
  });
  const pending = outcome(
    threads.open({
      agentId: prior.agentId,
      cwd: prior.cwd,
      nativeSessionId: prior.nativeSessionId,
    }),
  );
  await checkpoint;
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(threads.thread(prior.key)).toBe(prior);
  expect(prior.items).toBe(originalItems);
  expect(prior.queued).toBe(originalQueue);
  expect(prior.connectionLost).toBe(true);
  expect(prior.historyUnavailable).toBeNull();
  expect(historyText(prior)).toEqual(["Original body"]);
});

it("still rejects the original late JSON TypeError before replacing any old body or queue", async () => {
  const prior = seed("late-error");
  const originalItems = prior.items;
  const originalQueue = prior.queued;
  let settled = false;
  let checkpoint!: Promise<boolean>;
  const malformed = {
    update: {
      sessionUpdate: "tool_call",
      toolCallId: JSON.parse('{"toString":null,"valueOf":null}'),
    },
  };
  h.invoke.mockImplementation(async (command: string, wire: Wire) => {
    if (command !== "session_open") return [];
    deliverPrefix(wire, malformed);
    checkpoint = nextTask(() => settled);
    return openResult(prior);
  });
  const pending = outcome(
    threads.open({
      agentId: prior.agentId,
      cwd: prior.cwd,
      nativeSessionId: prior.nativeSessionId,
    }),
  );
  void pending.then(() => {
    settled = true;
  });
  await expect(checkpoint).resolves.toBe(false);
  const result = await pending;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected admitted history");
  expect(result.error).toBeInstanceOf(TypeError);
  expect(
    Object.getOwnPropertyDescriptor(result.error, "cause")?.value,
  ).toBeInstanceOf(TypeError);
  expect(threads.thread(prior.key)).toBe(prior);
  expect(prior.items).toBe(originalItems);
  expect(prior.queued).toBe(originalQueue);
  expect(prior.historyUnavailable?.reason).toBe("unreadable");
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_open"),
  ).toHaveLength(1);
});

it("cannot resurrect an old same-key owner closed during its cooperative precheck", async () => {
  const prior = seed("closed");
  let checkpoint!: Promise<Promise<void>>;
  h.invoke.mockImplementation(async (command: string, wire: Wire) => {
    if (command !== "session_open") return [];
    deliverPrefix(wire);
    checkpoint = nextTask(() => threads.close(prior.key));
    return openResult(prior);
  });
  const pending = outcome(
    threads.open({
      agentId: prior.agentId,
      cwd: prior.cwd,
      nativeSessionId: prior.nativeSessionId,
    }),
  );
  await checkpoint;
  expect((await pending).ok).toBe(false);
  expect(threads.thread(prior.key)).toBeUndefined();
  expect(
    h.invoke.mock.calls.filter(([command]) => command === "session_close"),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("keeps preview projection private between tasks and excludes post-marker following from its full snapshot", async () => {
  let settled = false;
  let checkpoint!: Promise<boolean>;
  const opaque = raw();
  h.invoke.mockImplementation(async (command: string, wire: Wire) => {
    if (command !== "session_import_preview") return [];
    for (let index = 0; index < SIZE; index++)
      wire.channel.onmessage(message(`history-${index}`));
    wire.channel.onmessage(opaque);
    wire.channel.onmessage({
      kind: "history_preview_complete",
      previewToken: wire.openToken,
    });
    checkpoint = nextTask(() => {
      wire.channel.onmessage(message("Following is outside this preview"));
      return settled;
    });
    return {
      nativeSessionId: "preview-owned",
      cwd: "/owned",
      resumed: true,
      configOptions: [],
      warnings: [],
      previewToken: wire.openToken,
    } satisfies OpenResult & { previewToken: string };
  });
  const pending = previewHistory("cooperative-history", {
    nativeSessionId: "preview-owned",
    cwd: "/owned",
    title: null,
    updatedAt: null,
    canLoad: true,
    locationAvailable: true,
    alreadyAddedId: null,
    isOpen: false,
  });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await expect(checkpoint).resolves.toBe(false);
  const preview = await pending;
  expect(preview.replayComplete).toBe(true);
  expect(historyText(preview.state)).toEqual(
    Array.from({ length: SIZE }, (_, index) => `history-${index}`),
  );
  expect(
    preview.state.items.some(
      (item) => item.kind === "raw" && item.update === opaque.update,
    ),
  ).toBe(true);
  expect(
    preview.state.items.every((item) => !("time" in item) || item.time === 0),
  ).toBe(true);
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "session_import_preview",
    ),
  ).toHaveLength(1);
});

it("keeps the original fork parent and child identity while yielding its independent full precheck", async () => {
  const parent = seed("fork");
  parent.openError = null;
  parent.connectionId = `parent-${parent.nativeSessionId}`;
  parent.sessionOperations = { forkCurrentContext: true };
  parent.configCheck = { status: "ready", issues: [], current: {} };
  const originalItems = parent.items;
  const originalQueue = parent.queued;
  const childId = `child-${parent.nativeSessionId}`;
  const childKey = `${parent.agentId}:${parent.cwd}:${childId}`;
  let settled = false;
  let checkpoint!: Promise<{ settled: boolean; childInstalled: boolean }>;
  h.invoke.mockImplementation(async (command: string, wire: Wire) => {
    if (command !== "session_fork_current")
      return command === "settings_get" ? null : [];
    deliverPrefix(wire);
    checkpoint = nextTask(() => ({
      settled,
      childInstalled: threads.thread(childKey) !== undefined,
    }));
    const session: OpenResult = {
      ...openResult(parent),
      nativeSessionId: childId,
      connectionId: `independent-${childId}`,
      configCheck: { status: "ready", issues: [], current: {} },
    };
    return {
      status: "ready",
      operationId: wire.operationId,
      parentConnectionId: wire.connectionId,
      parentSessionId: wire.parentSessionId,
      cwd: wire.cwd,
      childSessionId: childId,
      indexed: true,
      sourceReleased: true,
      session,
    } satisfies ForkResult;
  });
  const pending = threads.forkCurrent(parent.key);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // perform() flushes the existing draft first; let that original promise run.
  await Promise.resolve();
  await Promise.resolve();
  await expect(checkpoint).resolves.toEqual({
    settled: false,
    childInstalled: false,
  });
  const child = await pending;
  expect(child?.nativeSessionId).toBe(childId);
  expect(child?.connectionId).not.toBe(parent.connectionId);
  expect(historyText(child!)).toEqual(
    Array.from({ length: SIZE }, (_, index) => `history-${index}`),
  );
  expect(parent.items).toBe(originalItems);
  expect(parent.queued).toBe(originalQueue);
  expect(parent.forkOperation).toMatchObject({
    status: "ready",
    childSessionId: childId,
    childKey,
  });
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "session_fork_current",
    ),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.some(([command]) =>
      ["session_open", "session_prompt"].includes(command),
    ),
  ).toBe(false);
});

it("keeps the existing synchronous direct-check TypeError contract", () => {
  const state = seed("sync-negative");
  expect(() =>
    requireReadableHistory(
      state.agentId,
      openResult(state),
      [
        message("Readable before malformed tool"),
        {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: JSON.parse('{"toString":null,"valueOf":null}'),
          },
        },
      ],
      true,
      false,
    ),
  ).toThrow(TypeError);
});
