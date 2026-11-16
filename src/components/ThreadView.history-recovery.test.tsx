import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import {
  threads,
  applyUpdate,
  hasActiveTools,
  toolActivityState,
  type ThreadState,
} from "../runtime/sessions";
import { composerDrafts, draftPersistence } from "../runtime/drafts";
import { STRINGS } from "../runtime/strings";
import { ThreadView } from "./ThreadView";

const render = (thread: ThreadState) =>
  renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
function prior(id: string) {
  const state = threads.markOpenFailed(
    `fixture:/p:${id}`,
    "fixture",
    "/p",
    id,
    "retry",
  );
  state.items.push({
    kind: "agent",
    id: `message-${id}`,
    text: "Preserved prior conversation",
    streaming: false,
    time: 0,
  });
  state.queued = [[{ type: "text", text: "Unsent work" }]];
  return state;
}
function replay(args: Record<string, any>, configCheck?: unknown) {
  const result = {
    cwd: args.cwd,
    nativeSessionId: args.nativeSessionId,
    connectionId: `history-recovery-${args.nativeSessionId}`,
    resumed: true,
    configOptions: [],
    configCheck,
  };
  args.channel.onmessage({
    kind: "sessionOpening",
    openToken: args.openToken,
    cwd: result.cwd,
    sessionId: result.nativeSessionId,
    connectionId: result.connectionId,
  });
  args.channel.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Recovered conversation" },
    },
  });
  args.channel.onmessage({
    kind: "session_history_complete",
    openToken: args.openToken,
  });
  return result;
}
beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  h.invoke.mockImplementation(async (command) =>
    command === "settings_get" ? null : [],
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

it("shows one failed-recovery reason beside the input with its actual retry action", () => {
  const state = prior("one-recovery-notice");
  state.openError = STRINGS.repair.reconnectFailed;
  state.connectionLost = true;
  state.queuePaused = "unavailable";
  const html = render(state);
  expect(html.split(STRINGS.repair.reconnectFailed)).toHaveLength(2);
  expect(html).not.toContain(STRINGS.thread.connectionIdle);
  expect(html.match(/>重连<\/button>/g)).toHaveLength(1);
  expect(html).not.toContain(STRINGS.empty.goSettings);
  expect(html.indexOf(STRINGS.repair.reconnectFailed)).toBeGreaterThan(
    html.indexOf('class="composer-wrap"'),
  );
  expect(html).toContain("Preserved prior conversation");
  expect(state.queued).toHaveLength(1);
  expect(state.queuePaused).toBe("unavailable");
  expect(
    h.invoke.mock.calls.some(([command]) =>
      ["session_open", "session_prompt", "session_set_config"].includes(
        command,
      ),
    ),
  ).toBe(false);
});

const openingFailures = [
  ["AGENT_INITIALIZE_FAILED", "连接检查未完成，请检查程序或启动设置后重试"],
  [
    "AGENT_INITIALIZE_TIMEOUT",
    "连接检查超时，原因尚未确定。请先查看是否有待处理的登录或文件夹访问提示，再检查程序启动设置",
  ],
  ["AGENT_CONNECTION_ENDED", "连接在检查完成前结束，请检查程序后重试"],
  ["AGENT_START_FAILED", "程序未能启动，请检查程序文件和资料文件夹后重试"],
  [
    "AGENT_OPEN_TIMEOUT",
    "打开对话尚未确认完成，等待已超时。原内容已保留，请先查看是否有待处理的提示。",
  ],
  [
    "AGENT_OPEN_CLOSED",
    "打开对话尚未确认完成，未能取得结果。原内容已保留，请检查连接后重试。",
  ],
] as const;

function retainedOpening(state: ThreadState) {
  state.queuePaused = "stopped";
  state.uncertainPrompt = [{ type: "text", text: "Unknown prior request" }];
  state.stopUnconfirmed = true;
  state.connectionOutcomeUnknown = true;
  state.service = {
    id: "original-service",
    model: "original-model",
    fingerprint: "original-fingerprint",
  };
  state.serviceContext = "original-service-context";
  state.configOptions = [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "original-model",
      options: [],
    },
  ];
  state.configCheck = { status: "blocked", current: {}, issues: [] };
  state.modelDrift = true;
  const draftKey = `session:${state.key}`;
  composerDrafts.update(draftKey, () => ({
    text: "Unsent original draft",
    attachments: [
      {
        id: "retained-file",
        kind: "file",
        name: "retained-note.txt",
        uri: "file:///owned/retained-note.txt",
      },
    ],
  }));
  return () => ({
    items: state.items,
    queued: state.queued,
    queuePaused: state.queuePaused,
    uncertainPrompt: state.uncertainPrompt,
    stopUnconfirmed: state.stopUnconfirmed,
    connectionOutcomeUnknown: state.connectionOutcomeUnknown,
    service: state.service,
    serviceContext: state.serviceContext,
    configOptions: state.configOptions,
    configCheck: state.configCheck,
    modelDrift: state.modelDrift,
    draft: composerDrafts.read(draftKey),
  });
}

it.each(
  openingFailures.flatMap(([code, message], index) =>
    [false, true].map((wrapped) => ({ code, message, wrapped, index })),
  ),
)(
  "shows the safe opening stage after actual open rejection: $code, Error wrapper: $wrapped",
  async ({ code, message, wrapped, index }) => {
    const state = prior(`opening-stage-${index}-${wrapped}`);
    const retained = retainedOpening(state);
    const before = structuredClone(retained());
    const reason = wrapped ? new Error(code) : code;
    h.invoke.mockImplementation(async (command) => {
      if (command === "session_open") throw reason;
      throw new Error(`Unexpected IPC ${command}`);
    });
    await expect(
      threads.open({
        agentId: state.agentId,
        cwd: state.cwd,
        nativeSessionId: state.nativeSessionId,
      }),
    ).rejects.toBe(reason);
    expect(threads.thread(state.key)).toBe(state);
    expect(retained()).toEqual(before);
    expect(state.reconnecting).toBe(false);
    expect(state.connectionLost).toBe(true);
    expect(state.openError).toBe(message);
    const html = render(state);
    expect(html.split(message)).toHaveLength(2);
    expect(html).toContain("Preserved prior conversation");
    expect(html).toContain("Unsent original draft");
    expect(html).toContain("retained-note.txt");
    expect(html).not.toContain(code);
    expect(html).not.toContain(STRINGS.repair.reconnectFailed);
    expect(html).not.toContain("技术详情");
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      "session_open",
    ]);
  },
);

it.each(openingFailures.map(([code], index) => ({ code, index })))(
  "keeps untrusted variants of $code behind the original opening fallback",
  async ({ code, index: codeIndex }) => {
    const reasons: unknown[] = [
      `${code}: /private/secret-canary`,
      `检查结果：${code}: secret-canary`,
      `prefix:${code}`,
      `${code}\nsecret-canary`,
      `${code}\0secret-canary`,
      `${code} `,
      new Error(`${code}: secret-canary`),
      { code, message: "secret-canary" },
      { toString: () => code },
      "未知错误：/private/secret-canary",
    ];
    for (const [index, reason] of reasons.entries()) {
      const state = prior(`untrusted-opening-${codeIndex}-${index}`);
      const retained = retainedOpening(state);
      const before = structuredClone(retained());
      h.invoke.mockClear();
      h.invoke.mockImplementation(async (command) => {
        if (command === "session_open") throw reason;
        throw new Error(`Unexpected IPC ${command}`);
      });
      await expect(
        threads.open({
          agentId: state.agentId,
          cwd: state.cwd,
          nativeSessionId: state.nativeSessionId,
        }),
      ).rejects.toBe(reason);
      expect(state.openError).toBe(STRINGS.repair.reconnectFailed);
      expect(retained()).toEqual(before);
      const html = render(state);
      expect(html).not.toContain(code);
      expect(html).not.toContain("secret-canary");
      expect(html).not.toContain("/private/");
      expect(html).not.toContain("技术详情");
      expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
        "session_open",
      ]);
    }
  },
);

it("keeps the disconnected target's retry beside the input before any retry fails", () => {
  const state = prior("idle-recovery-notice");
  state.openError = null;
  state.connectionLost = true;
  const html = render(state);
  expect(html.split(STRINGS.thread.connectionIdle)).toHaveLength(2);
  expect(html.match(/>重连<\/button>/g)).toHaveLength(1);
  expect(html.indexOf(STRINGS.thread.connectionIdle)).toBeGreaterThan(
    html.indexOf('class="composer-wrap"'),
  );
});

it.each([false, true])(
  "offers a safe same-conversation configuration recheck (blocked: %s)",
  (blocked) => {
    const state = prior(`config-recheck-exit-${blocked}`);
    state.openError = null;
    state.modelDrift = blocked;
    state.configCheck = {
      status: blocked ? "blocked" : "ready",
      issues: [],
      current: {},
    };
    state.configError = STRINGS.repair.configFailed;
    const html = render(state);
    expect(html).toMatch(/>重新检查<\/button>/);
    expect(html).toContain("无法确认已保存选择，请重新检查");
    expect(html).not.toContain("Private official diagnostic");
    if (!blocked) expect(html).not.toContain(STRINGS.repair.newDraftHint);
  },
);

it("keeps source and unknown-execution facts with the single failed-recovery action", () => {
  const state = prior("source-unknown-recovery-notice");
  state.openError = STRINGS.repair.reconnectFailed;
  state.connectionLost = true;
  state.connectionOutcomeUnknown = true;
  state.sourceError = true;
  const html = render(state);
  expect(html.split(STRINGS.repair.reconnectFailed)).toHaveLength(2);
  expect(html).toContain(STRINGS.service.reconnect);
  expect(html).toContain(STRINGS.thread.connectionLost);
  expect(html.match(/>重连<\/button>/g)).toHaveLength(1);
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(state.sourceError).toBe(true);
});

it("keeps history reading's dedicated retry without duplicating its failed reason", () => {
  const state = prior("history-recovery-notice");
  state.openError = STRINGS.repair.historyEmpty;
  state.historyUnavailable = { reason: "empty", sourceKnown: true };
  state.connectionLost = true;
  state.connectionOutcomeUnknown = true;
  state.sourceError = true;
  const html = render(state);
  expect(html.split(STRINGS.repair.historyEmpty)).toHaveLength(2);
  expect(html).toContain(STRINGS.repair.retryHistory);
  expect(html).toContain(STRINGS.repair.newDraft);
  expect(html).toContain(STRINGS.service.reconnect);
  expect(html).toContain(STRINGS.thread.connectionLost);
  expect(html).not.toMatch(/>重连<\/button>/);
});

it("shows the complete displayed confirmation snapshot by ID without changing options or sending", () => {
  const state = prior("complete-confirmation");
  state.openError = null;
  state.identity = "established";
  state.modelDrift = true;
  state.configOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "different-live-value",
    },
    {
      id: "inference_speed",
      name: "Speed",
      category: "model",
      currentValue: "different-live-value",
    },
    {
      id: "reasoning_effort",
      name: "Reasoning",
      category: "thought_level",
      currentValue: "different-live-value",
    },
    {
      id: "thinking_budget",
      name: "Thinking Budget",
      category: "thought_level",
      currentValue: "different-live-value",
    },
  ].map((option) => ({ ...option, type: "select", options: [] }));
  const values = [
    "snapshot-model",
    "snapshot-speed",
    "snapshot-reasoning",
    "snapshot-budget",
  ];
  state.configCheck = {
    status: "confirmation_required",
    protectedIds: state.configOptions.map((o) => o.id),
    issues: [
      {
        id: "thinking_budget",
        category: "thought_level",
        reason: "unrecorded",
        expected: null,
        current: "snapshot-budget",
      },
    ],
    current: {
      choices: state.configOptions.map((option, index) => ({
        id: option.id,
        category: option.category,
        type: "select",
        value: values[index],
      })),
    },
  };
  const before = structuredClone(state.configCheck);
  const html = render(state);
  for (const value of values) expect(html).toContain(value);
  for (const name of ["Model", "Speed", "Reasoning", "Thinking Budget"])
    expect(html).toContain(name);
  expect(html).toContain(STRINGS.repair.confirmConfig);
  expect(state.configCheck).toEqual(before);
  expect(
    state.configOptions.every(
      (option) => option.currentValue === "different-live-value",
    ),
  ).toBe(true);
  expect(
    h.invoke.mock.calls.some(([command]) =>
      [
        "session_prompt",
        "session_set_config",
        "session_confirm_config",
      ].includes(command),
    ),
  ).toBe(false);
});

it.each([false, true])(
  "keeps the exact unsupported-history reason without offering an impossible reconnect (Error wrapper: %s)",
  async (wrapped) => {
    const state = prior(`unsupported-${wrapped}`);
    h.invoke.mockImplementation(async (command) => {
      if (command === "session_open")
        throw wrapped
          ? new Error("该 Agent 不支持恢复历史")
          : "该 Agent 不支持恢复历史";
      return command === "settings_get" ? null : [];
    });
    await expect(
      threads.open({
        agentId: state.agentId,
        cwd: state.cwd,
        nativeSessionId: state.nativeSessionId,
      }),
    ).rejects.toBeTruthy();
    expect(threads.thread(state.key)).toBe(state);
    expect(state.unrecoverable).toBe(true);
    expect(state.openError).toBe(STRINGS.thread.notResumable);
    expect(state.connectionLost).toBe(false);
    const html = render(state);
    expect(html).toContain("该 Agent 不支持恢复历史");
    expect(html).toContain("Preserved prior conversation");
    expect(html).toContain(STRINGS.repair.newDraft);
    expect(html).not.toContain(STRINGS.repair.reconnectFailed);
    expect(html).not.toContain(STRINGS.thread.connectionIdle);
    expect(html).not.toMatch(/>重连<\/button>/);
    expect(state.queued).toHaveLength(1);
    h.invoke.mockClear();
    await threads.reconnect(state.key);
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it.each([
  "Transport closed",
  "请求失败，暂不能确认是否不支持恢复",
  { code: "UNKNOWN", message: "Restore failed" },
])("keeps unknown or temporary failures retryable: %j", async (reason) => {
  const state = prior(`retry-${JSON.stringify(reason)}`);
  let failed = true;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") {
      if (failed) throw reason;
      return replay(args);
    }
    return command === "settings_get" ? null : [];
  });
  await expect(
    threads.open({
      agentId: state.agentId,
      cwd: state.cwd,
      nativeSessionId: state.nativeSessionId,
    }),
  ).rejects.toBeTruthy();
  expect(state.unrecoverable).toBe(false);
  expect(state.connectionLost).toBe(true);
  const html = render(state);
  expect(html).toContain("Preserved prior conversation");
  expect(html).toMatch(/>重连<\/button>/);
  expect(html).not.toContain(STRINGS.thread.notResumable);
  failed = false;
  await threads.reconnect(state.key);
  expect(threads.thread(state.key)).toMatchObject({
    openError: null,
    connectionLost: false,
    unrecoverable: false,
    items: [expect.objectContaining({ text: "Recovered conversation" })],
  });
});

it("does not claim unread history was preserved when a cold open has no load capability", async () => {
  const id = "cold-no-history";
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "agent_work_get") return { cwd: args.cwd, enabled: {} };
    if (command === "session_open") throw "该 Agent 不支持恢复历史";
    return command === "settings_get" ? null : [];
  });
  await expect(
    threads.open({ agentId: "fixture", cwd: "/p", nativeSessionId: id }),
  ).rejects.toBeTruthy();
  const state = threads.thread(`fixture:/p:${id}`)!;
  expect(state.items).toEqual([]);
  const html = render(state);
  expect(html).toContain("该 Agent 不支持恢复历史");
  expect(html).toContain("原对话记录不会删除");
  expect(html).toContain(STRINGS.repair.newDraft);
  expect(html).not.toContain("原内容已保留");
  expect(html).not.toContain(STRINGS.thread.connectionIdle);
});

it("does not revive an unknown tool from a lost connection after unsupported recovery", async () => {
  const state = prior("lost-tool-no-load");
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: "unfinished",
    title: "Unknown command",
    kind: "execute",
    status: "in_progress",
  });
  state.activeToolCallIds = ["unfinished"];
  state.connectionLost = true;
  state.connectionOutcomeUnknown = true;
  h.invoke.mockImplementation(async (command) => {
    if (command === "session_open") throw "该 Agent 不支持恢复历史";
    return command === "settings_get" ? null : [];
  });
  await expect(
    threads.open({
      agentId: state.agentId,
      cwd: state.cwd,
      nativeSessionId: state.nativeSessionId,
    }),
  ).rejects.toBeTruthy();
  expect(state.connectionLost).toBe(true);
  expect(state.connectionOutcomeUnknown).toBe(true);
  expect(state.activeToolCallIds).toEqual(["unfinished"]);
  expect(threads.needsAttention(state)).toBe(true);
  expect(hasActiveTools(state)).toBe(false);
  const item = state.items.find((item) => item.kind === "tool");
  if (item?.kind !== "tool") throw new Error("Missing original tool");
  expect(item.call.status).toBe("in_progress");
  expect(toolActivityState(state, item.call)).toBe("unknown");
  const html = render(state);
  expect(html).toContain(STRINGS.thread.toolResultUnknown);
  expect(html).not.toContain('class="g run"');
  expect(html).not.toMatch(/>重连<\/button>/);
});

it("keeps a restored unknown model blocked and offers a separate new conversation", async () => {
  const id = "unknown-model-recovery";
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "agent_work_get") return { cwd: args.cwd, enabled: {} };
    if (command === "session_open")
      return replay(args, {
        status: "blocked",
        issues: [
          {
            category: "model",
            reason: "unrecorded",
            expected: null,
            current: "reported-default",
          },
        ],
        current: {},
      });
    return command === "settings_get" ? null : [];
  });
  const state = await threads.open({
    agentId: "fixture",
    cwd: "/p",
    nativeSessionId: id,
  });
  expect(state).toMatchObject({
    modelDrift: true,
    unrecoverable: false,
    connectionLost: false,
  });
  const html = render(state);
  expect(html).toContain("无法确认原模型");
  expect(html).toContain(STRINGS.repair.newDraft);
  expect(html).not.toContain(STRINGS.thread.notResumable);
  expect(
    await threads.send(state.key, [{ type: "text", text: "Blocked" }]),
  ).toMatchObject({ status: "queued" });
  expect(state.configCheck?.status).toBe("blocked");
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
});

it("opens only an explicit fresh draft without moving old history or queued work", async () => {
  const state = prior("new-after-unsupported");
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_open") {
      if (args.nativeSessionId) throw "该 Agent 不支持恢复历史";
      const result = {
        cwd: args.cwd,
        nativeSessionId: "new-after-unsupported-draft",
        connectionId: "new-after-unsupported-connection",
        resumed: false,
        configOptions: [],
      };
      args.channel.onmessage({
        kind: "sessionOpening",
        openToken: args.openToken,
        cwd: result.cwd,
        sessionId: result.nativeSessionId,
        connectionId: result.connectionId,
      });
      return result;
    }
    return command === "settings_get" ? null : [];
  });
  await expect(
    threads.open({
      agentId: state.agentId,
      cwd: state.cwd,
      nativeSessionId: state.nativeSessionId,
    }),
  ).rejects.toBeTruthy();
  const fresh = await threads.newAfterRecoveryFailure(state.key);
  expect(fresh).toMatchObject({
    agentId: state.agentId,
    cwd: state.cwd,
    identity: "draft",
    items: [],
    queued: [],
    modelDrift: false,
  });
  expect(state.items[0]).toMatchObject({
    text: "Preserved prior conversation",
  });
  expect(state.queued).toHaveLength(1);
  expect(state.unrecoverable).toBe(true);
  expect(h.invoke.mock.calls.some(([cmd]) => cmd === "session_prompt")).toBe(
    false,
  );
});
