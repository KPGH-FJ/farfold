import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  finishConfig: null as null | ((value: unknown) => void),
  holdConfig: false,
  deleteRefusal: null as unknown,
  finishDelete: null as null | ((receipt: unknown) => void),
  holdDelete: false,
  refuseClose: false,
  closedRoutes: new Set<string>(),
  denied: 0,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
}));

import { threads, normalizeConfigOptions, type ThreadState } from "./sessions";

let sequence = 0;
const keys = new Set<string>();
const requests: Promise<unknown>[] = [];
const store = threads as unknown as {
  permissionRevisions: Map<string, number>;
  applyChannelEvent(key: string, value: unknown, live: boolean): void;
};
const options = [
  {
    id: "mode",
    category: "mode",
    type: "select",
    name: "Permission",
    currentValue: "ask",
    options: [{ value: "ask", name: "Ask" }],
  },
];
const ready = () => ({ status: "ready" as const, issues: [], current: {} });
const confirmed = () => ({
  configOptions: options,
  configCheck: ready(),
  permissionConfigId: "mode",
  permissionState: "ready",
  service: null,
});
function seed(key = `owned-permission-lifetime-${++sequence}`) {
  keys.add(key);
  const state = threads.markOpenFailed(
    key,
    "controlled",
    "/owned",
    key,
    "fixture",
  );
  state.openError = null;
  state.permissionConfigId = "mode";
  state.permissionState = "required";
  state.configOptions = normalizeConfigOptions(options);
  return state;
}
function permission(key: string, permissionState: "required" | "unknown") {
  store.applyChannelEvent(
    key,
    { kind: "permissionState", permissionConfigId: "mode", permissionState },
    false,
  );
}
function setting(state: ThreadState) {
  const pending = threads.setConfig(state.key, "mode", "ask");
  requests.push(pending);
  void pending.catch(() => {});
  return pending;
}
async function idleDraft() {
  const state = seed();
  state.identity = "draft";
  permission(state.key, "required");
  await setting(state);
  await threads.continueQueue(state.key);
  expect(state.permissionState).toBe("ready");
  expect(state.queuePaused).toBeNull();
  return state;
}
function replay(
  args: Record<string, any>,
  unknown = false,
  readable = true,
  cwd = args.cwd,
) {
  const result = {
    cwd,
    nativeSessionId: args.nativeSessionId,
    connectionId: `permission-lifetime-${args.nativeSessionId}`,
    resumed: true,
    ...confirmed(),
  };
  args.channel.onmessage({
    kind: "sessionOpening",
    openToken: args.openToken,
    cwd: result.cwd,
    sessionId: result.nativeSessionId,
    connectionId: result.connectionId,
  });
  if (readable)
    args.channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Owned history" },
      },
    });
  if (unknown)
    args.channel.onmessage({
      kind: "permissionState",
      permissionConfigId: "mode",
      permissionState: "unknown",
    });
  args.channel.onmessage({
    kind: "session_history_complete",
    openToken: args.openToken,
  });
  return result;
}
beforeEach(() => {
  h.holdConfig = false;
  h.finishConfig = null;
  h.denied = 0;
  h.deleteRefusal = null;
  h.finishDelete = null;
  h.holdDelete = false;
  h.refuseClose = false;
  h.closedRoutes.clear();
  h.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "session_set_config") {
      if (!h.holdConfig) return confirmed();
      return new Promise((resolve) => {
        h.finishConfig = resolve;
      });
    }
    if (command === "session_open") return replay(args);
    if (command === "agent_work_get") return { cwd: args.cwd };
    if (
      command === "settings_get" &&
      ["autoArchiveDays", "unsentWork.v1"].includes(args.key)
    )
      return null;
    if (command === "settings_set" && args.key === "unsentWork.v1") return null;
    if (command === "session_delete") {
      if (h.refuseClose) throw { code: "localNotRemoved", agent: null };
      if (
        !h.deleteRefusal ||
        (h.deleteRefusal as { connectionClosed?: boolean }).connectionClosed ===
          true
      )
        h.closedRoutes.add(args.nativeSessionId);
      if (h.deleteRefusal) throw h.deleteRefusal;
      if (h.holdDelete)
        return new Promise((resolve) => {
          h.finishDelete = resolve;
        });
      return "unsupported";
    }
    if (command === "session_close") {
      if (
        h.refuseClose ||
        (h.closedRoutes.has(args.sessionId) && !args.allowAlreadyClosed)
      )
        throw new Error("raw busy or absent");
      h.closedRoutes.add(args.sessionId);
      return null;
    }
    if (
      [
        "session_dismiss",
        "session_index_list",
        "session_touch",
        "session_detach_for_config_check",
      ].includes(command)
    )
      return [];
    h.denied++;
    throw new Error("unexpectedExternalCommand");
  });
});
afterEach(async () => {
  h.finishConfig?.(confirmed());
  await Promise.allSettled(requests.splice(0));
  for (const key of keys) await threads.close(key);
  keys.clear();
  expect(h.denied).toBe(0);
});

it.each([8, 64])(
  "retires permission guard keys after %s actual store closes",
  async (count) => {
    const closed: string[] = [];
    for (let i = 0; i < count; i++) {
      const state = seed();
      permission(state.key, "required");
      permission(state.key, "unknown");
      expect(state.permissionState).toBe("unknown");
      expect(store.permissionRevisions.get(state.key)).toBe(2);
      await threads.close(state.key);
      expect(threads.thread(state.key)).toBeUndefined();
      closed.push(state.key);
    }
    expect(closed.filter((key) => store.permissionRevisions.has(key))).toEqual(
      [],
    );
  },
);

it.each([false, true])(
  "retires a discarded draft's permission key (strict=%s)",
  async (strict) => {
    const state = await idleDraft();
    expect(store.permissionRevisions.get(state.key)).toBe(1);
    await threads.discardDraft(state.key, strict);
    expect(threads.thread(state.key)).toBeUndefined();
    expect(store.permissionRevisions.has(state.key)).toBe(false);
  },
);

it("retires an empty preparation's key after the owned close succeeds", async () => {
  const state = await idleDraft();
  await threads.retirePreparationDraft(state.key, () => true);
  expect(threads.thread(state.key)).toBeUndefined();
  expect(store.permissionRevisions.has(state.key)).toBe(false);
});

it("keeps a preparation's permission revision when startup content is retained", async () => {
  const state = await idleDraft();
  store.applyChannelEvent(
    state.key,
    {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Owned startup" },
      },
    },
    false,
  );
  const revision = store.permissionRevisions.get(state.key);
  await threads.retirePreparationDraft(state.key, () => true);
  expect(threads.thread(state.key)).toBe(state);
  expect(state.connectionLost).toBe(true);
  expect(state.items).toContainEqual(
    expect.objectContaining({ text: "Owned startup" }),
  );
  expect(store.permissionRevisions.get(state.key)).toBe(revision);
});

it("retires an explicitly deleted conversation's permission key", async () => {
  const state = await idleDraft();
  state.identity = "established";
  await threads.delete({
    id: state.key,
    agentId: state.agentId,
    cwd: state.cwd,
    nativeSessionId: state.nativeSessionId,
  });
  expect(threads.thread(state.key)).toBeUndefined();
  expect(store.permissionRevisions.has(state.key)).toBe(false);
});

it.each([
  [
    { code: "localNotRemoved", agent: "deleted", connectionClosed: true },
    /未从对话列表移除.*确认已删除/,
  ],
  [{ code: "localNotRemoved", agent: null }, /未从对话列表移除.*未向 Agent/],
  [
    { code: "localRemovalUnknown", agent: "unconfirmed" },
    /本机.*尚未确认.*Agent.*尚未确认/,
  ],
  [new Error("raw user directory"), /本机.*尚未确认/],
])(
  "retains loaded content and exact permission ownership on local deletion refusal %#",
  async (refusal, message) => {
    const state = await idleDraft();
    state.identity = "established";
    state.connectionLost = false;
    state.items.push({
      id: "owned-deletion-fixture",
      kind: "agent",
      text: "Retained history",
      streaming: false,
      time: 0,
    });
    const revision = store.permissionRevisions.get(state.key);
    h.deleteRefusal = refusal;
    await expect(
      threads.delete({
        id: state.key,
        agentId: state.agentId,
        cwd: state.cwd,
        nativeSessionId: state.nativeSessionId,
      }),
    ).rejects.toThrow(message);
    expect(threads.thread(state.key)).toBe(state);
    expect(state.items.at(-1)).toMatchObject({ text: "Retained history" });
    expect(store.permissionRevisions.get(state.key)).toBe(revision);
    expect(state.connectionLost).toBe(
      !(
        refusal &&
        typeof refusal === "object" &&
        "agent" in refusal &&
        refusal.agent === null
      ),
    );
  },
);

it("retains a deleting owner but fences new sends until the exact local receipt", async () => {
  const state = await idleDraft();
  state.identity = "established";
  h.holdDelete = true;
  const deleting = threads.delete({ id: state.key, ...state });
  await vi.waitFor(() => expect(h.finishDelete).toBeTypeOf("function"));
  try {
    expect(threads.thread(state.key)).toBe(state);
    expect(threads.archiveBlockReason(state.key)).toBe("unconfirmed");
    await expect(
      threads.send(state.key, [{ type: "text", text: "Must not start" }]),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(state.queued).toEqual([]);
  } finally {
    h.finishDelete!("unsupported");
    await deleting;
  }
  expect(threads.thread(state.key)).toBeUndefined();
});

it("retains the loaded view when the combined deletion reports a close refusal", async () => {
  const state = await idleDraft();
  state.identity = "established";
  h.refuseClose = true;
  await expect(threads.delete({ id: state.key, ...state })).rejects.toThrow(
    /未从对话列表移除.*未向 Agent/,
  );
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_delete"),
  ).toBe(true);
  expect(threads.thread(state.key)).toBe(state);
});

it("a second explicit attempt can use exact confirmed absence after a local refusal", async () => {
  const state = await idleDraft();
  state.identity = "established";
  const row = { id: state.key, ...state };
  h.deleteRefusal = {
    code: "localNotRemoved",
    agent: "unsupported",
    connectionClosed: true,
  };
  await expect(threads.delete(row)).rejects.toThrow(/未从对话列表移除/);
  expect(h.closedRoutes.has(state.nativeSessionId)).toBe(true);
  expect(threads.thread(state.key)).toBe(state);
  h.deleteRefusal = null;
  await expect(threads.delete(row)).resolves.toBe("unsupported");
  expect(threads.thread(state.key)).toBeUndefined();
});

it("an active owner's unknown event still invalidates its older setter reply", async () => {
  const state = seed();
  h.holdConfig = true;
  const pending = setting(state);
  const rejected = expect(pending).rejects.toBeTruthy();
  permission(state.key, "unknown");
  h.finishConfig!(confirmed());
  await rejected;
  expect(state.permissionState).toBe("unknown");
  expect(threads.thread(state.key)).toBe(state);
});

it("a closed owner's setter cannot confirm a same-key replacement even with equal counters", async () => {
  const state = seed();
  permission(state.key, "required");
  const revision = store.permissionRevisions.get(state.key);
  h.holdConfig = true;
  const pending = setting(state);
  const rejected = expect(pending).rejects.toBeTruthy();
  await threads.close(state.key);
  const replacement = seed(state.key);
  permission(replacement.key, "unknown");
  expect(store.permissionRevisions.get(replacement.key)).toBe(revision);
  h.finishConfig!(confirmed());
  await rejected;
  expect(threads.thread(state.key)).toBe(replacement);
  expect(replacement.permissionState).toBe("unknown");
  expect(replacement.configError).toBeNull();
});

it.each([false, true])(
  "preserves same-key recheck counters and newer unknown protection (unknown=%s)",
  async (unknown) => {
    const input = {
      agentId: "controlled",
      cwd: "/owned",
      nativeSessionId: `recheck-${++sequence}`,
    };
    const original = await threads.open(input);
    keys.add(original.key);
    permission(original.key, "required");
    original.modelDrift = true;
    const revision = store.permissionRevisions.get(original.key)!;
    h.invoke.mockImplementationOnce(async (_command, args) => {
      expect(_command).toBe("session_detach_for_config_check");
      h.invoke.mockImplementationOnce(async (_next, openArgs) => {
        expect(_next).toBe("session_open");
        return replay(openArgs, unknown);
      });
      return [];
    });
    const state = await threads.recheckConfig(original.key);
    expect(state).not.toBe(original);
    expect(state.key).toBe(original.key);
    expect(store.permissionRevisions.get(state.key)).toBe(
      revision + (unknown ? 1 : 0),
    );
    if (unknown) {
      expect(state.permissionState).toBe("unknown");
      h.holdConfig = true;
      const pending = setting(state);
      const rejected = expect(pending).rejects.toBeTruthy();
      permission(state.key, "unknown");
      h.finishConfig!(confirmed());
      await rejected;
      expect(state.permissionState).toBe("unknown");
    }
  },
);

it("moves a failed recovery's counter without reviving its old-key setter", async () => {
  const key = `controlled:/owned:rekey-${++sequence}`;
  const original = seed(key);
  original.nativeSessionId = key.split(":").at(-1)!;
  permission(key, "required");
  permission(key, "unknown");
  const revision = store.permissionRevisions.get(key)!;
  h.holdConfig = true;
  const pending = setting(original);
  const rejected = expect(pending).rejects.toBeTruthy();
  store.applyChannelEvent(key, { kind: "connectionLost" }, false);
  const targetKey = `controlled:/owned/canonical:${original.nativeSessionId}`;
  keys.add(targetKey);
  h.invoke.mockImplementationOnce(async (_command, args) => {
    expect(_command).toBe("session_open");
    return replay(args, false, false, "/owned/canonical");
  });
  await expect(
    threads.open({
      agentId: original.agentId,
      cwd: original.cwd,
      nativeSessionId: original.nativeSessionId,
    }),
  ).rejects.toBeTruthy();
  expect(threads.thread(key)).toBeUndefined();
  expect(threads.thread(targetKey)).toBe(original);
  h.finishConfig!(confirmed());
  await rejected;
  expect(original.permissionState).toBe("unknown");
  expect(store.permissionRevisions.has(key)).toBe(false);
  expect(store.permissionRevisions.get(targetKey)).toBeGreaterThanOrEqual(
    revision,
  );
  const movedRevision = store.permissionRevisions.get(targetKey)!;
  permission(targetKey, "unknown");
  expect(store.permissionRevisions.get(targetKey)).toBe(movedRevision + 1);
  expect(original.permissionState).toBe("unknown");
});
