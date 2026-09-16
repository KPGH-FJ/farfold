// Test-only native App Server. No network, credentials or model implementation.
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const mode = process.argv[2] ?? "waiting";
let account = null,
  counter = 0;
if (/^(thread_|turn_|interaction_|steer_|admission_)/.test(mode))
  account = { type: "apiKey" };
if (mode === "admission_unauthenticated") account = null;
let catalogReads = 0;
const selectedFile = join(process.env.CODEX_HOME, "synthetic-model.json");
const actualModel = () =>
  existsSync(selectedFile)
    ? JSON.parse(readFileSync(selectedFile, "utf8"))
    : null;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const updated = () =>
  send({
    method: "account/updated",
    params: {
      authMode: account?.type ?? null,
      privateSentinel: "DO-NOT-ROUTE-ACCOUNT",
    },
  });
const complete = (loginId, success) =>
  send({
    method: "account/login/completed",
    params: {
      loginId,
      success,
      error: success ? null : "DO-NOT-ROUTE-NATIVE-ERROR",
    },
  });
const lines = createInterface({ input: process.stdin });
const threadFile = join(
  process.env.CODEX_HOME,
  "sessions",
  "synthetic-thread.jsonl",
);
const readThread = () =>
  existsSync(threadFile) ? JSON.parse(readFileSync(threadFile, "utf8")) : null;
let activeTurn = null,
  turnCount = 0;
const notification = (method, params) => send({ method, params });
const requests = new Map();
function resolveRequest(request, terminal = true) {
  if (!request || !requests.has(request.id)) return;
  requests.delete(request.id);
  notification("serverRequest/resolved", {
    threadId: request.params.threadId,
    requestId: request.id,
  });
  if (request.item) {
    const item = { ...request.item, status: "completed" };
    notification("item/completed", {
      threadId: request.params.threadId,
      turnId: request.params.turnId,
      item,
      completedAtMs: 2,
    });
    activeTurn?.turn.items.push(item);
  }
  if (terminal) finishTurn("completed");
}
function finishTurn(status) {
  if (!activeTurn) return;
  const { threadId, turn } = activeTurn;
  const completed = {
    ...turn,
    status,
    error:
      status === "failed"
        ? {
            message: "PRIVATE-TURN-ERROR",
            codexErrorInfo: null,
            additionalDetails: null,
          }
        : null,
    completedAt: 2,
    durationMs: 1,
  };
  const thread = readThread();
  thread.turns.push(completed);
  writeFileSync(threadFile, JSON.stringify(thread), { mode: 0o600 });
  notification("turn/completed", { threadId, turn: completed });
  activeTurn = null;
  if (mode === "turn_late")
    setTimeout(
      () => notification("turn/completed", { threadId, turn: completed }),
      35,
    );
}
lines.on("line", (line) => {
  const r = JSON.parse(line),
    p = r.params ?? {};
  const reply = (result) => send({ id: r.id, result });
  if (!r.method) {
    const request = requests.get(r.id);
    if (!request || r.result === undefined) return;
    // Persist only synthetic response counts/IDs, never answer content.
    const audit = join(process.env.CODEX_HOME, "synthetic-response-count.json");
    const count = existsSync(audit)
      ? JSON.parse(readFileSync(audit, "utf8")).count
      : 0;
    writeFileSync(audit, JSON.stringify({ count: count + 1, id: r.id }), {
      mode: 0o600,
    });
    if (mode !== "interaction_no_resolve")
      setTimeout(() => resolveRequest(request), 150);
    return;
  }
  if (r.method === "initialize")
    return reply({
      codexHome: process.env.CODEX_HOME,
      platformOs: "macos",
      platformFamily: "unix",
      userAgent: "synthetic-0.143.0",
    });
  if (r.method === "initialized") return;
  if (r.method === "turn/steer") {
    if (
      !activeTurn ||
      activeTurn.threadId !== p.threadId ||
      activeTurn.turn.id !== p.expectedTurnId ||
      !p.input?.[0]?.text ||
      Object.keys(p).sort().join() !== "expectedTurnId,input,threadId"
    )
      return send({
        id: r.id,
        error: { code: -32600, message: "synthetic steer target rejected" },
      });
    const nativeId = activeTurn.turn.id;
    const audit = join(process.env.CODEX_HOME, "synthetic-steer-count.json");
    const count = existsSync(audit)
      ? JSON.parse(readFileSync(audit, "utf8")).count
      : 0;
    writeFileSync(
      audit,
      JSON.stringify({ count: count + 1, turnId: nativeId }),
      { mode: 0o600 },
    );
    if (mode === "steer_reject")
      return send({
        id: r.id,
        error: { code: -32600, message: "PRIVATE-STEER-ERROR" },
      });
    if (mode === "steer_timeout") return;
    if (mode === "steer_delay")
      setTimeout(() => reply({ turnId: nativeId }), 350);
    else reply({ turnId: nativeId });
    return;
  }
  if (r.method === "turn/start") {
    const audit = join(
      process.env.CODEX_HOME,
      "synthetic-turn-start-count.json",
    );
    const count = existsSync(audit)
      ? JSON.parse(readFileSync(audit, "utf8")).count
      : 0;
    writeFileSync(audit, JSON.stringify({ count: count + 1 }), { mode: 0o600 });
    if (mode === "turn_timeout_start") return;
    const thread = readThread();
    if (
      !thread ||
      p.threadId !== thread.id ||
      activeTurn ||
      Object.keys(p).sort().join() !== "input,threadId"
    )
      return send({
        id: r.id,
        error: { code: -32602, message: "synthetic target rejected" },
      });
    const id = `019a0000-0000-7000-8000-${String(++turnCount).padStart(12, "0")}`;
    const turn = {
      id,
      status: "inProgress",
      items: [],
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    };
    activeTurn = { threadId: thread.id, turn };
    notification("turn/started", { threadId: thread.id, turn });
    notification("future/task", { secret: "PRIVATE-UNKNOWN-TURN" });
    for (const item of [
      {
        type: "reasoning",
        id: `reason-${turnCount}`,
        summary: ["summary"],
        content: ["thinking"],
      },
      {
        type: "agentMessage",
        id: `message-${turnCount}`,
        text: "answer",
        phase: null,
        memoryCitation: null,
      },
      {
        type: "commandExecution",
        id: `command-${turnCount}`,
        status: "completed",
        command: "PRIVATE-COMMAND",
        cwd: process.cwd(),
        aggregatedOutput: "PRIVATE-OUTPUT",
        processId: null,
        source: "agent",
        commandActions: [],
        exitCode: 0,
        durationMs: 1,
      },
      {
        type: "fileChange",
        id: `file-${turnCount}`,
        status: "completed",
        changes: [
          { path: "PRIVATE-PATH", kind: { type: "add" }, diff: "PRIVATE-DIFF" },
        ],
      },
      {
        type: "futureSecretItem",
        id: `unknown-${turnCount}`,
        secret: "PRIVATE-UNKNOWN-ITEM",
      },
    ]) {
      const params = { threadId: thread.id, turnId: id };
      notification("item/started", {
        ...params,
        item: { ...item, ...(item.status ? { status: "inProgress" } : {}) },
        startedAtMs: 1,
      });
      if (item.type === "agentMessage") {
        notification("item/agentMessage/delta", {
          ...params,
          itemId: item.id,
          delta: "answer",
          privateExtra: "PRIVATE-DELTA-EXTRA",
        });
        notification("item/agentMessage/delta", {
          ...params,
          turnId: "019a0000-0000-7000-8000-999999999999",
          itemId: item.id,
          delta: "FOREIGN-TURN-TEXT",
        });
      }
      if (item.type === "reasoning") {
        notification("item/reasoning/textDelta", {
          ...params,
          itemId: item.id,
          delta: "thinking",
          contentIndex: 0,
        });
        notification("item/reasoning/summaryTextDelta", {
          ...params,
          itemId: item.id,
          delta: "summary",
          summaryIndex: 0,
        });
      }
      if (mode === "turn_bad_item" && item.type === "commandExecution")
        continue;
      notification("item/completed", { ...params, item, completedAtMs: 2 });
      turn.items.push(item);
    }
    if (mode.startsWith("interaction_")) {
      const question =
        mode.includes("question") || mode === "interaction_expire";
      const file = mode === "interaction_file";
      notification("thread/settings/updated", {
        threadId: thread.id,
        threadSettings: {
          cwd: process.cwd(),
          model: "synthetic-model",
          modelProvider: "synthetic",
          effort: "medium",
          collaborationMode: {
            mode:
              question && mode !== "interaction_question_default"
                ? "plan"
                : "default",
            settings: {
              model: "synthetic-model",
              reasoning_effort: "medium",
              developer_instructions: null,
            },
          },
          privateExtra: "PRIVATE-SETTINGS",
        },
      });
      const itemId = `approval-item-${turnCount}`;
      const item = question
        ? null
        : file
          ? {
              type: "fileChange",
              id: itemId,
              status: "inProgress",
              changes: [
                {
                  path: join(process.cwd(), "preview-only.txt"),
                  kind: { type: "add" },
                  diff: "+synthetic proposed content",
                },
              ],
            }
          : {
              type: "commandExecution",
              id: itemId,
              status: "inProgress",
              command: "printf synthetic",
              cwd: process.cwd(),
              processId: null,
              source: "agent",
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            };
      if (item)
        notification("item/started", {
          threadId: thread.id,
          turnId: id,
          item,
          startedAtMs: 1,
        });
      const params = {
        threadId: thread.id,
        turnId: id,
        itemId,
        ...(question
          ? {
              questions: [
                {
                  id: "question_one",
                  header: "Choice",
                  question: "Choose synthetic path",
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: "A", description: "First" },
                    { label: "B", description: "Second" },
                  ],
                },
                {
                  id: "question_secret",
                  header: "Private input",
                  question: "Provide synthetic private input",
                  isOther: true,
                  isSecret: true,
                  options: null,
                },
              ],
              autoResolutionMs: mode === "interaction_expire" ? 200 : null,
            }
          : {
              startedAtMs: 1,
              reason: "Synthetic user approval",
              ...(file
                ? { grantRoot: null }
                : {
                    command: "printf synthetic",
                    cwd: process.cwd(),
                    environmentId: null,
                    approvalId: "native-callback-id",
                    availableDecisions: [
                      "accept",
                      "decline",
                      "cancel",
                      {
                        acceptWithExecpolicyAmendment: {
                          execpolicy_amendment: ["printf", "synthetic"],
                        },
                      },
                    ],
                  }),
            }),
        privateExtra: "PRIVATE-INTERACTION-EXTRA",
      };
      const request = {
        id: question ? 700 + turnCount : `approval-${turnCount}`,
        method: question
          ? "item/tool/requestUserInput"
          : file
            ? "item/fileChange/requestApproval"
            : "item/commandExecution/requestApproval",
        params,
      };
      requests.set(request.id, { ...request, item });
      send(request);
      if (mode === "interaction_withdraw")
        setTimeout(() => resolveRequest(requests.get(request.id)), 150);
      if (mode === "interaction_expire")
        setTimeout(() => resolveRequest(requests.get(request.id)), 450);
      if (mode === "interaction_disconnect")
        setTimeout(() => process.exit(0), 150);
    }
    reply({ turn: { ...turn, items: [] } });
    if (mode === "turn_disconnect") setTimeout(() => process.exit(0), 60);
    else if (
      ![
        "turn_hold",
        "turn_reject_stop",
        "turn_timeout_stop",
        "turn_late_stop_ack",
      ].includes(mode) &&
      !mode.startsWith("interaction_") &&
      !mode.startsWith("steer_") &&
      !(mode === "turn_late" && turnCount > 1)
    )
      setTimeout(
        () => finishTurn(mode === "turn_failed" ? "failed" : "completed"),
        80,
      );
    return;
  }
  if (r.method === "turn/interrupt") {
    if (
      !activeTurn ||
      activeTurn.threadId !== p.threadId ||
      activeTurn.turn.id !== p.turnId
    )
      return send({
        id: r.id,
        error: { code: -32600, message: "no running turn" },
      });
    if (mode === "turn_timeout_stop") return;
    for (const request of [...requests.values()])
      resolveRequest(request, false);
    if (mode === "turn_late_stop_ack") {
      finishTurn("interrupted");
      setTimeout(() => reply({}), 250);
      return;
    }
    if (mode === "turn_reject_stop") {
      send({
        id: r.id,
        error: { code: -32600, message: "PRIVATE-STOP-ERROR" },
      });
      setTimeout(() => finishTurn("completed"), 150);
    } else {
      reply({});
      setTimeout(() => finishTurn("interrupted"), 150);
    }
    return;
  }
  if (r.method === "account/read") {
    const result = { account, requiresOpenaiAuth: true };
    if (mode === "early_slow" && account) {
      setTimeout(() => reply(result), 200);
      return;
    }
    return reply(result);
  }
  if (r.method === "model/list") {
    if (!p.includeHidden || p.limit !== 32)
      throw Error("Explicit complete catalog required");
    if (p.cursor === null) catalogReads++;
    const entry = {
      id: "synthetic-picker",
      model: "synthetic-model",
      displayName: "Synthetic",
      description: "No model execution",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Medium" },
        { reasoningEffort: "high", description: "High" },
      ],
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
    };
    if (mode === "admission_catalog_change" && catalogReads > 2)
      entry.model = "changed-model";
    if (
      (mode === "admission_account_change" && catalogReads > 2) ||
      (mode === "admission_late_account_change" && catalogReads > 3)
    ) {
      account = null;
      updated();
    }
    const second = {
      ...entry,
      id: "synthetic-hidden",
      hidden: true,
      isDefault: false,
    };
    if (mode === "admission_duplicate") second.id = entry.id;
    return reply({
      data: [p.cursor === null ? entry : second],
      nextCursor:
        p.cursor === null || mode === "admission_cursor_loop"
          ? "page-two"
          : null,
    });
  }
  if (r.method === "thread/list")
    return reply({
      data: readThread() ? [{ ...readThread(), turns: [] }] : [],
      nextCursor: null,
      backwardsCursor: null,
    });
  if (["thread/start", "thread/resume", "thread/read"].includes(r.method)) {
    if (mode === "thread_never") return;
    let thread = readThread();
    if (thread && !p.includeTurns) thread = { ...thread, turns: [] };
    if (r.method === "thread/start") {
      if (
        !p.model ||
        !p.modelProvider ||
        !p.config?.model_reasoning_effort ||
        p.allowProviderModelFallback !== false
      )
        throw Error("Missing explicit selection");
      writeFileSync(
        selectedFile,
        JSON.stringify({
          model: p.model,
          modelProvider: p.modelProvider,
          reasoningEffort: p.config.model_reasoning_effort,
        }),
        { mode: 0o600 },
      );
      mkdirSync(join(process.env.CODEX_HOME, "sessions"), {
        recursive: true,
        mode: 0o700,
      });
      thread = {
        id: "019a0000-0000-7000-8000-000000000001",
        sessionId: "019a0000-0000-7000-8000-000000000002",
        cwd: process.cwd(),
        path: threadFile,
        cliVersion: "0.143.0",
        ephemeral: false,
        forkedFromId: null,
        parentThreadId: null,
        status: { type: "idle" },
        turns: [],
        preview: "PRIVATE-RAW-PREVIEW",
        modelProvider: "synthetic",
        createdAt: 1,
        updatedAt: 1,
        recencyAt: null,
        historyMode: "complete",
        extra: null,
        source: "appServer",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
      };
      writeFileSync(threadFile, JSON.stringify(thread), {
        flag: "wx",
        mode: 0o600,
      });
    }
    if (!thread || (p.threadId && p.threadId !== thread.id))
      return send({
        id: r.id,
        error: { code: -32602, message: "missing synthetic thread" },
      });
    if (mode === "thread_foreign")
      thread = { ...thread, sessionId: "019a0000-0000-7000-8000-000000000099" };
    if (mode === "thread_cwd") thread = { ...thread, cwd: "/" };
    if (mode === "thread_moved") {
      const moved = join(
        process.env.CODEX_HOME,
        "sessions",
        "observed-new-location.jsonl",
      );
      writeFileSync(moved, "synthetic history location", { mode: 0o600 });
      thread = { ...thread, path: moved };
    }
    if (mode === "thread_events") {
      send({ method: "future/native", params: { secret: "PRIVATE-UNKNOWN" } });
      send({ method: "error", params: { message: "PRIVATE-ERROR" } });
      send({
        method: "thread/status/changed",
        params: {
          threadId: thread.id,
          status: { type: "idle" },
          apiKey: "PRIVATE-EXTRA",
        },
      });
      send({
        method: "thread/status/changed",
        params: {
          threadId: "019a0000-0000-7000-8000-000000000099",
          status: { type: "idle" },
        },
      });
    }
    if (r.method !== "thread/read")
      send({ method: "thread/started", params: { thread } });
    const result = {
      thread,
      cwd: process.cwd(),
      runtimeWorkspaceRoots: [process.cwd()],
      ...(r.method === "thread/read" ? {} : actualModel()),
    };
    if (mode === "admission_actual_mismatch") result.model = "wrong-model";
    if (mode === "admission_read_provider" && r.method === "thread/read")
      result.thread.modelProvider = "foreign";
    if (mode === "admission_read_active" && r.method === "thread/read")
      result.thread.status = { type: "active", activeFlags: [] };
    if (mode === "admission_effort_mismatch") result.reasoningEffort = "high";
    if (
      r.method === "thread/resume" &&
      (p.model !== undefined ||
        p.config !== undefined ||
        p.modelProvider !== undefined)
    )
      throw Error("Resume override forbidden");
    if (mode === "thread_delayed") setTimeout(() => reply(result), 200);
    else reply(result);
    return;
  }
  if (r.method === "account/logout") {
    account = null;
    updated();
    return reply({});
  }
  if (r.method === "account/login/cancel") {
    reply({ status: mode === "cancel_not_found" ? "notFound" : "canceled" });
    setTimeout(() => {
      complete(p.loginId, true);
      updated();
    }, 20);
    return;
  }
  if (r.method === "account/login/start") {
    send({
      method: "error",
      params: { message: "DO-NOT-ROUTE-GENERIC-AUTH-ERROR" },
    });
    if (mode === "never_reply") return;
    if (p.type === "apiKey") {
      if (p.apiKey !== "SYNTHETIC-ONLY")
        return send({
          id: r.id,
          error: { code: -32000, message: "SYNTHETIC-SECRET-MUST-NOT-LEAK" },
        });
      account = { type: "apiKey" };
      updated();
      complete(null, true);
      if (mode === "external_logout")
        setTimeout(() => {
          account = null;
          updated();
        }, 100);
      if (mode === "delayed_key") {
        setTimeout(() => reply({ type: "apiKey" }), 100);
        return;
      }
      return reply({ type: "apiKey" });
    }
    const loginId = `login-${++counter}`;
    const finish = () => {
      account = {
        type: "chatgpt",
        email: "synthetic@example.invalid",
        planType: "free",
      };
      updated();
      complete(loginId, true);
    };
    if (mode === "early" || mode === "early_slow") finish();
    const result =
      p.type === "chatgpt"
        ? {
            type: "chatgpt",
            loginId,
            authUrl: "https://auth.openai.com/authorize?state=SYNTHETIC-URL",
          }
        : {
            type: "chatgptDeviceCode",
            loginId,
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "SYNTHETIC-CODE",
          };
    if (mode === "delayed_login") setTimeout(() => reply(result), 100);
    else reply(result);
    if (mode === "auto") setTimeout(finish, 100);
    send({
      method: "account/futurePrivate",
      params: { secret: "DO-NOT-ROUTE-FUTURE-ACCOUNT" },
    });
    return;
  }
  send({
    id: r.id,
    error: { code: -32601, message: "Synthetic method unsupported" },
  });
});
lines.on("close", () => process.exit(0));
