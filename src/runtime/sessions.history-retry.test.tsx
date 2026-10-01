import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type OpenResult, type ThreadState } from "./sessions";
import { composerDrafts, draftPersistence, draftQueues } from "./drafts";
import { STRINGS } from "./strings";
import { isHistoryReadFailure } from "./session_recovery";
import { ThreadView } from "../components/ThreadView";

interface OpenArgs {
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  configOptions: unknown;
  service: unknown;
  openToken: string;
  channel: { onmessage: (value: unknown) => void };
}
interface CloseArgs {
  agentId: string;
  cwd: string;
  sessionId: string;
  allowAlreadyClosed?: boolean;
}

const service = {
  id: "original-api",
  model: "original-model",
  fingerprint: "original-fingerprint",
};
const configCheck = {
  status: "blocked" as const,
  issues: [],
  protectedIds: ["model", "reasoning"],
  current: {
    choices: [
      {
        id: "model",
        category: "model",
        type: "select",
        value: "original-model",
      },
      {
        id: "reasoning",
        category: "thought_level",
        type: "select",
        value: "high",
      },
    ],
  },
};

function target(agent: string, cwd: string, native: string) {
  return JSON.stringify([agent, cwd, native]);
}
function previous(
  native: string,
  cwd = "/private/tmp/history-retry",
  agentId = "retry-fixture",
) {
  const state = threads.markOpenFailed(
    `${agentId}:${cwd}:${native}`,
    agentId,
    cwd,
    native,
    "initial",
  );
  state.items.push({
    kind: "agent",
    id: `old-${native}`,
    text: "Keep original body",
    streaming: false,
    time: 0,
  });
  state.queued = [[{ type: "text", text: "Keep original queue" }]];
  state.queuePaused = "stopped";
  state.configCheck = configCheck;
  state.modelDrift = true;
  state.uncertainPrompt = [{ type: "text", text: "Unknown prior request" }];
  state.stopUnconfirmed = true;
  return state;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function view(thread: ThreadState) {
  return renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
}

/** The IPC double retains successful backend routes after frontend admission fails. */
function backend() {
  const routes = new Set<string>();
  const opens: OpenArgs[] = [];
  const closes: CloseArgs[] = [];
  let readable = false;
  let closeFailure = false;
  let closePending: Promise<void> | undefined;
  const aliases = new Map<string, string>();
  let cwdReply: { value: unknown } | undefined;
  let cwdFailure = false;
  h.invoke.mockImplementation(async (command: string, value: unknown) => {
    if (command === "agent_work_get") {
      if (cwdFailure) throw new Error("fixture: cwd read was rejected");
      const cwd = (value as { cwd: string }).cwd;
      return cwdReply
        ? cwdReply.value
        : { cwd: aliases.get(cwd) ?? cwd, enabled: { "retry-fixture": false } };
    }
    if (command === "session_open") {
      const args = value as OpenArgs;
      opens.push(args);
      const cwd = aliases.get(args.cwd) ?? args.cwd;
      const key = target(args.agentId, cwd, args.nativeSessionId);
      // Matches pump::open_session_on_connection's check before session/load.
      if (routes.has(key)) throw new Error("fixture: session is already open");
      routes.add(key);
      if (readable)
        args.channel.onmessage({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "New readable history" },
          },
        });
      args.channel.onmessage({
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      return {
        cwd,
        nativeSessionId: args.nativeSessionId,
        resumed: true,
        service,
        serviceContext: "original-api-revision",
        configOptions: [],
        configCheck,
        warnings: [],
      } satisfies OpenResult;
    }
    if (command === "session_close") {
      const args = value as CloseArgs;
      closes.push(args);
      await closePending;
      if (closeFailure) throw new Error("fixture: close remains unconfirmed");
      const key = target(args.agentId, args.cwd, args.sessionId);
      if (!routes.delete(key) && !args.allowAlreadyClosed)
        throw new Error("fixture: no owned route");
      return;
    }
    return command === "settings_get" ? null : [];
  });
  return {
    routes,
    opens,
    closes,
    readable(value: boolean) {
      readable = value;
    },
    closeFailure(value: boolean) {
      closeFailure = value;
    },
    closePending(value: Promise<void> | undefined) {
      closePending = value;
    },
    alias(raw: string, canonical: string) {
      aliases.set(raw, canonical);
    },
    cwdReply(value: unknown) {
      cwdReply = { value };
    },
    cwdFailure(value: boolean) {
      cwdFailure = value;
    },
  };
}
async function failedLoad(state: ThreadState) {
  await expect(
    threads.open({
      agentId: state.agentId,
      cwd: state.cwd,
      nativeSessionId: state.nativeSessionId,
    }),
  ).rejects.toBeTruthy();
  expect(state.historyUnavailable?.reason).toBe("empty");
}
function noMutationOrPrompt() {
  expect(
    h.invoke.mock.calls.some(([command]) =>
      [
        "session_prompt",
        "session_set_config",
        "session_confirm_config",
      ].includes(command),
    ),
  ).toBe(false);
}

beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

it("closes the retained route before an explicit empty-history retry and keeps both recovery exits", async () => {
  const state = previous("empty-twice");
  const ipc = backend();
  const oldItems = state.items;
  const oldQueue = state.queued;
  await failedLoad(state);
  expect(ipc.routes.size).toBe(1);
  const result = await threads.reconnect(state.key);
  expect(ipc.closes).toEqual([
    {
      agentId: state.agentId,
      cwd: state.cwd,
      sessionId: state.nativeSessionId,
      allowAlreadyClosed: true,
    },
  ]);
  expect(ipc.opens).toHaveLength(2);
  expect(ipc.routes.size).toBe(1);
  expect(result).toBe(state);
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(state.connectionLost).toBe(false);
  expect(state.reconnecting).toBe(false);
  expect(state.items).toBe(oldItems);
  expect(state.queued).toBe(oldQueue);
  expect(state.configCheck).toBe(configCheck);
  expect(state.modelDrift).toBe(true);
  expect(state.stopUnconfirmed).toBe(true);
  expect(state.service).toEqual(service);
  expect(state.serviceContext).toBe("original-api-revision");
  const html = view(state);
  expect(html).toContain(STRINGS.repair.historyFailed);
  expect(html).toContain(STRINGS.repair.retryHistory);
  expect(html).toContain(STRINGS.repair.newDraft);
  expect(html).not.toContain(STRINGS.repair.reconnectFailed);
  noMutationOrPrompt();
});

it.each(["observed-loss", "no-loss"] as const)(
  "waits for close confirmation and preserves %s semantics before a readable retry",
  async (loss) => {
    const state = previous(`close-then-readable-${loss}`);
    const ipc = backend();
    await failedLoad(state);
    const first = ipc.opens[0].channel;
    const wait = deferred();
    ipc.closePending(wait.promise);
    ipc.readable(true);
    const retry = threads.reconnect(state.key);
    await Promise.resolve();
    expect(ipc.closes).toHaveLength(1);
    expect(ipc.opens).toHaveLength(1);
    if (loss === "observed-loss") first.onmessage({ kind: "connectionLost" });
    const confirmedStop = state.stopUnconfirmed;
    wait.resolve();
    const reopened = await retry;
    expect(reopened?.historyUnavailable).toBeNull();
    expect(reopened?.openError).toBeNull();
    expect(reopened?.connectionLost).toBe(false);
    expect(reopened?.configCheck).toEqual(configCheck);
    expect(reopened?.modelDrift).toBe(true);
    expect(reopened?.uncertainPrompt).toEqual(state.uncertainPrompt);
    expect(reopened?.stopUnconfirmed).toBe(confirmedStop);
    expect(reopened?.queued).toEqual(state.queued);
    expect(reopened?.service).toEqual(service);
    expect(reopened?.items[0]).toMatchObject({ text: "New readable history" });
    first.onmessage({ kind: "connectionLost" });
    expect(reopened?.connectionLost).toBe(false);
    expect(ipc.opens[1]).toMatchObject({
      nativeSessionId: state.nativeSessionId,
      cwd: state.cwd,
      service: null,
      configOptions: null,
    });
    noMutationOrPrompt();
  },
);

it("reuses successful canonical history when the original raw index is opened again", async () => {
  const raw = "/tmp/successful-raw-index";
  const canonical = "/private/tmp/successful-raw-index";
  const state = previous("successful-reentry", raw, "reentry-after-success");
  const ipc = backend();
  ipc.alias(raw, canonical);
  await failedLoad(state);
  ipc.readable(true);
  const recovered = await threads.reconnect(state.key);
  expect(recovered?.historyUnavailable).toBeNull();
  expect(recovered?.resumed).toBe(true);
  const reopened = await threads.open({
    agentId: state.agentId,
    cwd: raw,
    nativeSessionId: state.nativeSessionId,
  });
  expect(reopened).toBe(recovered);
  expect(ipc.closes).toHaveLength(1);
  expect(ipc.opens).toHaveLength(2);
  expect(
    threads.thread(`${state.agentId}:${raw}:${state.nativeSessionId}`),
  ).toBeUndefined();
  noMutationOrPrompt();
});

it.each(["empty", "with-input"] as const)(
  "revalidates the %s raw failure after the canonical target succeeded separately",
  async (kind) => {
    const raw = `/tmp/validated-after-success-${kind}`;
    const canonical = `/private/tmp/validated-after-success-${kind}`;
    const state = previous(
      `validation-then-success-${kind}`,
      raw,
      `validation-after-success-${kind}`,
    );
    const ipc = backend();
    ipc.alias(raw, canonical);
    await failedLoad(state);
    const rawKey = `${state.agentId}:${raw}:${state.nativeSessionId}`;
    draftQueues.write(rawKey, [], null);
    ipc.cwdFailure(true);
    const input = {
      agentId: state.agentId,
      cwd: raw,
      nativeSessionId: state.nativeSessionId,
    };
    await expect(threads.open(input)).rejects.toBeTruthy();
    const placeholder = threads.thread(rawKey)!;
    if (kind === "with-input")
      composerDrafts.update(`session:${rawKey}`, (draft) => ({
        ...draft,
        text: "Retain raw input after other page succeeds",
      }));
    const rawDraft = composerDrafts.read(`session:${rawKey}`);
    ipc.cwdFailure(false);
    ipc.readable(true);
    const recovered = await threads.reconnect(state.key);
    expect(recovered?.historyUnavailable).toBeNull();
    expect(recovered?.resumed).toBe(true);
    if (kind === "empty") {
      expect(await threads.open(input)).toBe(recovered);
      expect(threads.thread(rawKey)).toBeUndefined();
    } else {
      await expect(threads.open(input)).rejects.toThrow("已保留");
      expect(threads.thread(rawKey)).toBe(placeholder);
      expect(composerDrafts.read(`session:${rawKey}`)).toBe(rawDraft);
      expect(threads.thread(recovered!.key)).toBe(recovered);
    }
    expect(ipc.closes).toHaveLength(1);
    expect(ipc.opens).toHaveLength(2);
    noMutationOrPrompt();
  },
);

it("does not start another load while close is unconfirmed and permits a later explicit retry", async () => {
  const state = previous("close-unconfirmed");
  const ipc = backend();
  await failedLoad(state);
  const items = state.items;
  const queue = state.queued;
  const failure = state.historyUnavailable;
  ipc.closeFailure(true);
  await threads.reconnect(state.key);
  expect(ipc.closes).toHaveLength(1);
  expect(ipc.opens).toHaveLength(1);
  expect(ipc.routes.size).toBe(1);
  expect(state.items).toBe(items);
  expect(state.queued).toBe(queue);
  expect(state.historyUnavailable).toBe(failure);
  expect(state.configCheck).toBe(configCheck);
  expect(state.service).toEqual(service);
  expect(state.connectionLost).toBe(false);
  ipc.closeFailure(false);
  await threads.reconnect(state.key);
  expect(ipc.closes).toHaveLength(2);
  expect(ipc.opens).toHaveLength(2);
  expect(state.historyUnavailable?.reason).toBe("empty");
  noMutationOrPrompt();
});

it("closes only the acknowledged target and accepts the backend's confirmed already-closed outcome", async () => {
  const state = previous("precise-route");
  const ipc = backend();
  await failedLoad(state);
  const exact = target(state.agentId, state.cwd, state.nativeSessionId);
  ipc.routes.delete(exact);
  const others = [
    target(state.agentId, "/other-directory", state.nativeSessionId),
    target("another-agent", state.cwd, state.nativeSessionId),
    target(state.agentId, state.cwd, "another-native-api-session"),
  ];
  for (const key of others) ipc.routes.add(key);
  await threads.reconnect(state.key);
  expect(ipc.closes).toHaveLength(1);
  expect(ipc.closes[0]).toEqual({
    agentId: state.agentId,
    cwd: state.cwd,
    sessionId: state.nativeSessionId,
    allowAlreadyClosed: true,
  });
  expect(ipc.opens).toHaveLength(2);
  expect([...ipc.routes]).toEqual([...others, exact]);
  expect(state.historyUnavailable?.reason).toBe("empty");
  noMutationOrPrompt();
});

it("keeps ordinary connection recovery on its existing path without closing an unacknowledged route", async () => {
  const state = previous("ordinary-lost");
  state.connectionLost = true;
  expect(state.historyUnavailable).toBeNull();
  const ipc = backend();
  ipc.readable(true);
  const result = await threads.reconnect(state.key);
  expect(ipc.closes).toEqual([]);
  expect(ipc.opens).toHaveLength(1);
  expect(result?.connectionLost).toBe(false);
  expect(result?.items[0]).toMatchObject({ text: "New readable history" });
  noMutationOrPrompt();
});

it("uses the same close-before-load path when the failed target is opened again from its index", async () => {
  const state = previous("index-reopen");
  const ipc = backend();
  await failedLoad(state);
  await failedLoad(state);
  expect(ipc.closes).toHaveLength(1);
  expect(ipc.opens).toHaveLength(2);
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(state.connectionLost).toBe(false);
  noMutationOrPrompt();
});

it("deduplicates the entire close and load while index open and explicit retry overlap", async () => {
  const state = previous("concurrent-index-retry");
  const ipc = backend();
  await failedLoad(state);
  const wait = deferred();
  ipc.closePending(wait.promise);
  const retry = threads.reconnect(state.key);
  const indexRead = threads
    .open({
      agentId: state.agentId,
      cwd: state.cwd,
      nativeSessionId: state.nativeSessionId,
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await Promise.resolve();
  expect(ipc.closes).toHaveLength(1);
  expect(ipc.opens).toHaveLength(1);
  wait.resolve();
  const [retried, failure] = await Promise.all([retry, indexRead]);
  expect(isHistoryReadFailure(failure)).toBe(true);
  expect(retried).toBe(state);
  expect(ipc.closes).toHaveLength(1);
  expect(ipc.opens).toHaveLength(2);
  expect(state.historyUnavailable?.reason).toBe("empty");
  noMutationOrPrompt();
});

it("keeps the existing source-error close policy when moving preparation into the common open operation", async () => {
  const state = previous("existing-source-error");
  state.sourceError = true;
  const ipc = backend();
  ipc.routes.add(target(state.agentId, state.cwd, state.nativeSessionId));
  ipc.readable(true);
  const result = await threads.reconnect(state.key);
  expect(ipc.closes).toEqual([
    {
      agentId: state.agentId,
      cwd: state.cwd,
      sessionId: state.nativeSessionId,
    },
  ]);
  expect(result?.historyUnavailable).toBeNull();
  expect(result?.connectionLost).toBe(false);
  noMutationOrPrompt();
});

it("reopens a raw index path through the canonical failed target without applying work-policy values", async () => {
  const raw = "/tmp/alias-history";
  const canonical = "/private/tmp/alias-history";
  const state = previous("raw-index-target", raw);
  const ipc = backend();
  ipc.alias(raw, canonical);
  await failedLoad(state);
  expect(state.cwd).toBe(canonical);
  expect(
    threads.thread(`retry-fixture:${raw}:${state.nativeSessionId}`),
  ).toBeUndefined();
  state.workEnabled = true;
  const failure = await threads
    .open({
      agentId: state.agentId,
      cwd: raw,
      nativeSessionId: state.nativeSessionId,
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(isHistoryReadFailure(failure)).toBe(true);
  expect(ipc.closes).toHaveLength(1);
  expect(ipc.closes[0].cwd).toBe(canonical);
  expect(ipc.opens).toHaveLength(2);
  expect(ipc.opens[1].cwd).toBe(canonical);
  expect(state.workEnabled).toBe(true);
  expect(state.historyUnavailable?.reason).toBe("empty");
  expect(
    threads.thread(`retry-fixture:${raw}:${state.nativeSessionId}`),
  ).toBeUndefined();
  noMutationOrPrompt();
});

it("deduplicates raw index and canonical retry admission before closing or loading", async () => {
  const raw = "/tmp/concurrent-alias-history";
  const canonical = "/private/tmp/concurrent-alias-history";
  const state = previous("raw-canonical-overlap", raw);
  const ipc = backend();
  ipc.alias(raw, canonical);
  await failedLoad(state);
  const wait = deferred();
  ipc.closePending(wait.promise);
  const retry = threads.reconnect(state.key);
  const rawOpen = threads
    .open({
      agentId: state.agentId,
      cwd: raw,
      nativeSessionId: state.nativeSessionId,
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(ipc.closes).toHaveLength(1);
  expect(ipc.opens).toHaveLength(1);
  wait.resolve();
  const [reopened, failure] = await Promise.all([retry, rawOpen]);
  expect(isHistoryReadFailure(failure)).toBe(true);
  expect(reopened).toBe(state);
  expect(ipc.closes).toHaveLength(1);
  expect(ipc.opens).toHaveLength(2);
  noMutationOrPrompt();
});

it.each(["rejected", "invalid-cwd"] as const)(
  "does not fall back to raw load after canonical target validation was %s",
  async (kind) => {
    const raw = `/tmp/invalid-${kind}`;
    const canonical = `/private/tmp/invalid-${kind}`;
    const state = previous(`canonical-${kind}`, raw);
    const ipc = backend();
    ipc.alias(raw, canonical);
    await failedLoad(state);
    const items = state.items;
    const failure = state.historyUnavailable;
    if (kind === "rejected") ipc.cwdFailure(true);
    else ipc.cwdReply({ cwd: 42, enabled: {} });
    await expect(
      threads.open({
        agentId: state.agentId,
        cwd: raw,
        nativeSessionId: state.nativeSessionId,
      }),
    ).rejects.toBeTruthy();
    expect(ipc.closes).toHaveLength(0);
    expect(ipc.opens).toHaveLength(1);
    expect(state.items).toBe(items);
    expect(state.historyUnavailable).toBe(failure);
    expect(state.configCheck).toBe(configCheck);
    noMutationOrPrompt();
  },
);

it.each(["body", "queue", "composer", "pending", "send-pending"] as const)(
  "keeps %s on the failed raw page instead of merging it into the canonical target",
  async (kind) => {
    const raw = `/tmp/protected-validation-${kind}`;
    const canonical = `/private/tmp/protected-validation-${kind}`;
    const state = previous(`protected-validation-${kind}`, raw);
    const ipc = backend();
    ipc.alias(raw, canonical);
    await failedLoad(state);
    ipc.cwdFailure(true);
    const input = {
      agentId: state.agentId,
      cwd: raw,
      nativeSessionId: state.nativeSessionId,
    };
    await expect(threads.open(input)).rejects.toBeTruthy();
    const rawKey = `${state.agentId}:${raw}:${state.nativeSessionId}`;
    const placeholder = threads.thread(rawKey)!;
    if (kind === "body") placeholder.items = [...state.items];
    if (kind === "queue")
      draftQueues.write(
        rawKey,
        [[{ type: "text", text: "Keep raw queue" }]],
        null,
      );
    if (kind === "composer")
      composerDrafts.update(`session:${rawKey}`, (draft) => ({
        ...draft,
        text: "Keep raw input",
      }));
    if (kind === "pending")
      composerDrafts.update(`session:${rawKey}`, (draft) => ({
        ...draft,
        pendingConversation: {
          agentId: state.agentId,
          cwd: raw,
          nativeSessionId: state.nativeSessionId,
        },
      }));
    if (kind === "send-pending")
      composerDrafts.update(`session:${rawKey}`, (draft) => ({
        ...draft,
        text: " ",
        sendPending: true,
      }));
    const rawItems = placeholder.items;
    const rawDraft = composerDrafts.read(`session:${rawKey}`);
    const rawQueue = draftQueues.read(rawKey);
    await expect(threads.open(input)).rejects.toBeTruthy();
    expect(draftQueues.read(rawKey)).toEqual(rawQueue);
    expect(composerDrafts.read(`session:${rawKey}`)).toBe(rawDraft);
    ipc.cwdFailure(false);
    const error = await threads.open(input).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("已保留");
    expect(ipc.closes).toHaveLength(0);
    expect(ipc.opens).toHaveLength(1);
    expect(threads.thread(rawKey)).toBe(placeholder);
    expect(placeholder.items).toBe(rawItems);
    expect(composerDrafts.read(`session:${rawKey}`)).toBe(rawDraft);
    expect(draftQueues.read(rawKey)).toEqual(rawQueue);
    expect(threads.thread(state.key)).toBe(state);
    expect(state.historyUnavailable?.reason).toBe("empty");
    noMutationOrPrompt();
  },
);

it("does not start a new load or revive the failed state after it was explicitly closed during route cleanup", async () => {
  const state = previous("removed-during-close");
  const ipc = backend();
  await failedLoad(state);
  const wait = deferred();
  ipc.closePending(wait.promise);
  const retry = threads.reconnect(state.key);
  await Promise.resolve();
  const closing = threads.close(state.key);
  expect(threads.thread(state.key)).toBeUndefined();
  wait.resolve();
  await Promise.all([retry, closing]);
  expect(ipc.opens).toHaveLength(1);
  expect(threads.thread(state.key)).toBeUndefined();
  noMutationOrPrompt();
});

it.each(["rejected", "invalid-cwd"] as const)(
  "can retry canonical validation after %s without leaving a second failed placeholder",
  async (kind) => {
    const raw = `/tmp/recover-validation-${kind}`;
    const canonical = `/private/tmp/recover-validation-${kind}`;
    const state = previous(`retry-validation-${kind}`, raw);
    const ipc = backend();
    ipc.alias(raw, canonical);
    await failedLoad(state);
    draftQueues.write(
      `${state.agentId}:${raw}:${state.nativeSessionId}`,
      [],
      null,
    );
    const oldItems = state.items;
    const oldQueue = state.queued;
    const input = {
      agentId: state.agentId,
      cwd: raw,
      nativeSessionId: state.nativeSessionId,
    };
    if (kind === "rejected") ipc.cwdFailure(true);
    else ipc.cwdReply({ cwd: 42 });
    await expect(threads.open(input)).rejects.toBeTruthy();
    const rawKey = `${state.agentId}:${raw}:${state.nativeSessionId}`;
    expect(threads.thread(rawKey)?.openError).toBeTruthy();
    expect(ipc.opens).toHaveLength(1);
    ipc.cwdFailure(false);
    ipc.cwdReply({ cwd: canonical });
    const error = await threads.open(input).catch((error: unknown) => error);
    expect(isHistoryReadFailure(error)).toBe(true);
    expect(ipc.closes).toHaveLength(1);
    expect(ipc.closes[0].cwd).toBe(canonical);
    expect(ipc.opens).toHaveLength(2);
    expect(state.items).toBe(oldItems);
    expect(state.queued).toBe(oldQueue);
    expect(state.configCheck).toBe(configCheck);
    expect(threads.thread(rawKey)).toBeUndefined();
    noMutationOrPrompt();
  },
);
