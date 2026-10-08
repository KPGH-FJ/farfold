import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  createPreviewClock,
  canAnswerPreview,
  rememberReply,
  resumePreview,
  latestArtifactReply,
  readableTranscript,
  resolvePreviewRecovery,
  previewQueueGate,
} from "../src/conversation-state.js";
import { TASKS_V2 } from "../src/data-v2.js";
import { WORKSPACE_TASKS } from "../src/workspace-scenarios.js";

let server, Conversation, ConversationTranscript;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
    logLevel: "error",
  });
  ({ default: Conversation } = await server.ssrLoadModule(
    "/src/Conversation.jsx",
  ));
  ({ default: ConversationTranscript } = await server.ssrLoadModule(
    "/src/ConversationTranscript.jsx",
  ));
  await server.ssrLoadModule("/src/AppV2.jsx");
});
after(async () => server?.close());
const render = (task, props = {}) =>
  renderToStaticMarkup(
    React.createElement(Conversation, {
      task,
      onTaskChange() {},
      onNew() {},
      onSettings() {},
      toast() {},
      ...props,
    }),
  );

test("审批与运行的 Enter 提示和待发动作一致，停止未知只提供检查结果", () => {
  for (const status of ["approval", "running"]) {
    const html = render({
      id: "keyboard-review",
      agent: "Codex",
      model: "A",
      title: "输入行为",
      status,
      draft: "保留内容",
      queue: [],
    });
    assert.match(html, /Enter 加入待发/);
    assert.match(html, /aria-label="加入待发"/);
    assert.doesNotMatch(html, /Enter 发送 · Shift Enter 换行/);
  }
});

test("连接测试用统一对话展示原短句和审批，不套用普通任务示例或另起发送器", () => {
  const task = {
    id: "test-job",
    agent: "Codex",
    model: "A",
    title: "连接测试",
    prompt: "请只回复：已连接。",
    status: "approval",
    accessTest: { phase: "approval", label: "等待确认" },
    queue: [],
  };
  const html = render(task, {
    onAccessTestAction() {},
    onReturnToPreparation() {},
  });
  assert.match(html, /请只回复：已连接。/);
  assert.match(html, /批准本次/);
  assert.match(html, /拒绝本次/);
  assert.match(html, /停止测试/);
  assert.match(html, /返回准备/);
  assert.doesNotMatch(html, /aria-label="消息内容"/);
  assert.doesNotMatch(
    html,
    /有 2 项操作需要你决定|检查项目卡片|先让重点更清楚/,
  );
  const unknown = render(
    {
      ...task,
      status: "unknown",
      accessTest: { phase: "unknown", label: "结果待确认" },
    },
    { onAccessTestAction() {} },
  );
  assert.match(unknown, /演示收到停止确认/);
  assert.doesNotMatch(
    unknown,
    /明确完成结果|再次请求停止|已连接。\（模拟回复\）/,
  );
  const done = render({
    ...task,
    status: "done",
    accessTest: { phase: "passed", result: "passed", label: "完成" },
  });
  assert.match(done, /已连接。（模拟回复）/);
  const failed = render({
    ...task,
    status: "failed",
    accessTest: {
      phase: "failed",
      result: "failed",
      label: "这次请求明确需要认证。",
    },
  });
  assert.match(failed, /class="status failed recovery"/);
  assert.match(failed, /未通过/);
  assert.match(failed, /这次请求明确需要认证。/);
  assert.doesNotMatch(failed, /已停止/);
});

test("imported history renders its original speakers without fabricated initial replies", () => {
  const task = {
    id: "import-demo",
    agent: "Codex",
    model: "6 Astra",
    status: "done",
    imported: true,
    importedMessages: [
      { role: "user", text: "原先的问题" },
      { role: "assistant", text: "原先的完整答复" },
    ],
    queue: [],
  };
  const html = render(task);
  assert.equal((html.match(/原先的问题/g) || []).length, 1);
  assert.equal((html.match(/原先的完整答复/g) || []).length, 1);
  assert.doesNotMatch(html, /先把想得到的结果说清楚/);
  assert.match(html, /历史已带入/);
  assert.doesNotMatch(html, /查看对话内容/);
  const continued = render({
    ...task,
    resultMode: "simulated",
    previewKind: "writing",
    extraMessages: [{ text: "请润色这一段" }],
  });
  assert.ok(
    continued.indexOf("原先的完整答复") < continued.indexOf("请润色这一段"),
  );
  assert.match(continued, /先让重点更清楚/);
});

test("read-only imported history has no sending input and retains an explicit new-conversation exit", () => {
  const task = {
    id: "import-readonly",
    agent: "Pi",
    status: "done",
    imported: true,
    readOnly: true,
    readOnlyReason: "只能读取历史",
    importedMessages: [{ role: "assistant", text: "可复制的历史" }],
  };
  const html = render(task);
  assert.match(html, /仅可查看/);
  assert.match(html, /可复制的历史/);
  assert.doesNotMatch(html, /aria-label="消息内容"/);
  assert.match(html, /用这个 Agent 新开对话/);
  assert.match(
    render({ ...task, importedLocationMissing: true }),
    /另选位置新开对话/,
  );
});

test("stop wins over a late question submission and remains able to confirm", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let task = { status: "question", queue: ["keep this"] },
    stopping = false;
  const clock = createPreviewClock((value) => {
    stopping = value;
  });
  clock.stop(() => {
    task = { ...task, status: "stopped" };
  });
  assert.equal(canAnswerPreview(task, "question", clock.stopping), false);
  assert.equal(
    clock.work(() => {
      task.status = "done";
    }),
    false,
  );
  t.mock.timers.tick(1100);
  assert.equal(stopping, false);
  assert.equal(task.status, "stopped");
  assert.deepEqual(task.queue, ["keep this"]);
  assert.equal(canAnswerPreview(task, "question", clock.stopping), false);
  clock.dispose();
});

test("independent conversation clocks keep working when another conversation stops", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  const a = createPreviewClock(() => {});
  const b = createPreviewClock(() => {});
  a.work(() => events.push("a-completed"), 500);
  b.work(() => events.push("b-completed"), 500);
  a.stop(() => events.push("a-stopped"));
  t.mock.timers.tick(1100);
  assert.deepEqual(events, ["b-completed", "a-stopped"]);
  a.dispose();
  b.dispose();
});

test("closing then reopening work before completion cannot silently resume queued work", () => {
  let task = {
    status: "running",
    queue: [{ id: "later", text: "keep" }],
    draft: "draft",
    queuePaused: false,
  };
  task = { ...task, ...previewQueueGate(task, { workEnabled: false }) };
  task = { ...task, ...previewQueueGate(task, { workEnabled: true }) };
  assert.equal(task.status, "running");
  assert.equal(task.queuePaused, true);
  assert.deepEqual(task.queue, [{ id: "later", text: "keep" }]);
  assert.equal(task.draft, "draft");
  for (const field of ["sourceAvailable", "agentAvailable"]) {
    const approval = { status: "approval", queuePaused: false };
    const paused = {
      ...approval,
      ...previewQueueGate(approval, { [field]: false }),
    };
    assert.equal(paused.status, "approval");
    assert.equal(paused.queuePaused, true);
    assert.equal(previewQueueGate(paused, { [field]: true }), null);
  }
});

test("matching history recovery preserves identity, input and queue without automatically continuing", () => {
  const task = {
    id: "history",
    status: "recovery",
    agent: "A",
    model: "old",
    effort: "high",
    source: "old service",
    draft: "keep me",
    attachments: ["notes.md"],
    queue: [{ id: "q", text: "later" }],
    currentModel: "other",
  };
  const recovered = {
    ...task,
    ...resolvePreviewRecovery(task, "recovery", "matched"),
  };
  assert.equal(recovered.status, "done");
  assert.equal(recovered.currentModel, "old");
  assert.equal(recovered.queuePaused, true);
  for (const field of [
    "agent",
    "model",
    "effort",
    "source",
    "draft",
    "attachments",
    "queue",
  ])
    assert.deepEqual(recovered[field], task[field]);
  assert.equal(
    resolvePreviewRecovery(
      { ...task, status: "running" },
      "recovery",
      "matched",
    ),
    null,
  );
});

test("unknown execution is never retried or promoted until an explicit simulated result arrives", () => {
  const task = {
    id: "a",
    status: "unknown",
    unknownReason: "admission",
    queue: ["later"],
    draft: "held",
    model: "A",
  };
  const waiting = {
    ...task,
    ...resolvePreviewRecovery(task, "unknown", "unknown"),
  };
  assert.equal(waiting.status, "unknown");
  assert.equal(waiting.draft, "held");
  const stopped = {
    ...task,
    ...resolvePreviewRecovery(task, "unknown", "stopped"),
  };
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(stopped.queue, ["later"]);
  assert.equal(stopped.queuePaused, true);
  assert.equal(resolvePreviewRecovery(task, "unknown", "matched"), null);
});

test("remembered approval cannot restart work during or after stop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const task = { status: "approval" };
  const clock = createPreviewClock(() => {});
  let accepted = 0;
  const lateApproval = () => {
    if (canAnswerPreview(task, "approval", clock.stopping)) accepted++;
  };
  setTimeout(lateApproval, 5000);
  t.mock.timers.tick(4500);
  clock.stop(() => {
    task.status = "stopped";
  });
  t.mock.timers.tick(500);
  assert.equal(accepted, 0);
  t.mock.timers.tick(600);
  lateApproval();
  assert.equal(task.status, "stopped");
  assert.equal(accepted, 0);
  clock.dispose();
});

test("stop cancels queued progression; normal work can resume afterward", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = ["second"],
    events = [];
  const clock = createPreviewClock((value) => events.push(value));
  clock.work(() => queue.shift());
  t.mock.timers.tick(3000);
  clock.stop(() => events.push("stopped"));
  t.mock.timers.tick(1100);
  assert.deepEqual(queue, ["second"]);
  assert.deepEqual(events, [true, false, "stopped"]);
  clock.work(() => queue.shift());
  t.mock.timers.tick(3200);
  assert.deepEqual(queue, []);
  assert.equal(clock.working, false);
  clock.dispose();
});

test("every sample and a fresh noncoding conversation render using the actual components", () => {
  for (const task of [
    ...TASKS_V2,
    ...WORKSPACE_TASKS,
    {
      id: "new-smoke",
      title: "一起计划旅行",
      prompt: "计划旅行",
      agent: "Codex",
      model: "6 Astra",
      status: "running",
      draft: "",
      queue: [],
      resultMode: "simulated",
    },
  ])
    assert.ok(render(task).includes("conv-transcript"), task.id);
});

test("stopping visibly disables both question submission and individual approvals", () => {
  for (const id of ["question", "approval"]) {
    const task = TASKS_V2.find((item) => item.id === id);
    const html = renderToStaticMarkup(
      React.createElement(ConversationTranscript, {
        task,
        stopping: true,
        copy() {},
        onDecision() {},
        onTaskChange() {},
        onSubmitAnswer() {},
        onCancelQuestion() {},
      }),
    );
    assert.ok(
      (html.match(/disabled=""/g) || []).length >= (id === "question" ? 5 : 5),
      id,
    );
  }
});

test("closing work or losing a service blocks new messages without disabling existing approvals or stop", () => {
  const task = {
    ...TASKS_V2.find((item) => item.id === "approval"),
    draft: "保留下一步",
  };
  const html = render(task, {
    workEnabled: false,
    serviceMissing: true,
    serviceIssue: "原服务已删除",
    onResumeSending() {},
  });
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  const send = buttons.find((item) =>
    item[1].includes('aria-label="加入待发"'),
  );
  assert.match(send[1], /disabled/);
  for (const label of ["批准这一次", "停止", "恢复发送"]) {
    const button = buttons.find((item) => item[2].includes(label));
    assert.ok(button, label);
    assert.doesNotMatch(button[1], /disabled/, label);
  }
  assert.ok(html.includes("原服务已删除"));
  assert.ok(html.includes("保留下一步"));
});

test("admission uncertainty is distinct from a missing stop confirmation in the actual conversation", () => {
  const task = {
    ...TASKS_V2.find((item) => item.id === "running"),
    status: "unknown",
    unknownReason: "admission",
  };
  const html = render(task);
  assert.ok(html.includes("这条消息的接纳结果尚未确认"));
  assert.ok(html.includes("查询这次请求的结果"));
  assert.ok(html.includes('aria-label="模拟未知请求的确认结果"'));
  assert.ok(html.includes("不能重复发送"));
});

test("stopped conversations without queued messages offer direct send; queued work needs explicit continue", () => {
  const task = {
    id: "new-stopped",
    title: "继续讨论",
    agent: "Codex",
    prompt: "先看看",
    status: "stopped",
    resultMode: "simulated",
    draft: "接着做这件事",
    queuePaused: true,
    queue: [],
  };
  const empty = render(task);
  assert.ok(empty.includes('aria-label="发送消息"'));
  assert.ok(empty.includes("你可以输入新的要求并发送"));
  assert.ok(!empty.includes("点击“继续发送”"));
  const queued = render({ ...task, queue: [{ id: "q1", text: "保留的待发" }] });
  assert.ok(queued.includes('aria-label="加入待发"'));
  assert.ok(queued.includes("点击“继续发送”"));
});

test("scenario summaries reflect stopped, unknown, and recovery states including historical rounds", () => {
  const seed = TASKS_V2.find((task) => task.id === "question");
  for (const [status, summary] of Object.entries({
    stopped: "整理已停止",
    unknown: "整理结果待确认",
    recovery: "等待恢复后继续",
  })) {
    const html = render({ ...seed, status });
    assert.ok(html.includes(summary), status);
    assert.ok(!html.includes("正在整理内容"), status);
  }
  const stopped = { ...seed, status: "stopped" };
  const continued = {
    ...stopped,
    ...resumePreview(stopped),
    status: "running",
    resultMode: "simulated",
    extraMessages: [{ text: "换个方向，继续讨论" }],
  };
  const html = render(continued);
  assert.ok(html.indexOf("整理已停止") < html.indexOf("换个方向，继续讨论"));
  assert.ok(!html.includes("正在整理内容"));
});

test("two subsequent rounds retain the original replies, order, and attachments", () => {
  let task = {
    id: "new-history",
    title: "先旅行再写作",
    agent: "Codex",
    status: "done",
    prompt: "帮我计划旅行",
    resultMode: "simulated",
    previewKind: "travel",
    sentAttachments: ["出行要求.md"],
    extraMessages: [],
    draft: "",
    queue: [],
  };
  const original = structuredClone(task);
  task = {
    ...task,
    ...resumePreview(task),
    status: "running",
    previewKind: "writing",
    extraMessages: [
      { text: "再帮我润色一封邮件", attachments: ["邮件草稿.md"] },
    ],
  };
  let html = render(task);
  assert.ok(
    html.indexOf("先把行程节奏定下来") < html.indexOf("再帮我润色一封邮件"),
  );
  assert.ok(
    !html.includes("先让重点更清楚"),
    "running turn must not invent a completed reply",
  );
  assert.ok(html.includes("出行要求.md") && html.includes("邮件草稿.md"));
  task.status = "done";
  html = render(task);
  assert.ok(
    html.indexOf("再帮我润色一封邮件") < html.indexOf("先让重点更清楚"),
  );
  task = {
    ...task,
    ...resumePreview(task),
    status: "running",
    previewKind: "general",
    extraMessages: [...task.extraMessages, { text: "接着比较三个选择" }],
  };
  html = render(task);
  assert.equal((html.match(/先把行程节奏定下来/g) || []).length, 1);
  assert.equal((html.match(/先让重点更清楚/g) || []).length, 1);
  assert.ok(html.indexOf("先让重点更清楚") < html.indexOf("接着比较三个选择"));
  assert.equal(task.replyHistory.length, 2);
  assert.equal(original.replyHistory, undefined);
});

test("queued rounds are captured before the next message and archives reopen on resume", () => {
  const original = {
    id: "archived",
    archived: true,
    status: "done",
    agent: "Pi",
    prompt: "first",
  };
  const patch = resumePreview(original);
  assert.equal(patch.archived, false);
  assert.equal(patch.replyHistory[0].round, 0);
  const current = {
    ...original,
    ...patch,
    status: "running",
    resultMode: "simulated",
    extraMessages: [{ text: "second", attachments: ["材料.md"] }],
  };
  const history = rememberReply(current, "done");
  assert.equal(history.length, 2);
  assert.equal(history[1].status, "done");
  assert.deepEqual(history[1].replyAttachments, ["材料.md"]);
  assert.equal(
    latestArtifactReply({ ...current, replyHistory: history }).round,
    0,
  );
  assert.equal(original.archived, true);
});

test("historical preset output remains once and keeps its original file source", () => {
  const first = TASKS_V2.find((task) => task.id === "done");
  const task = {
    ...first,
    ...resumePreview(first),
    resultMode: "simulated",
    previewKind: "writing",
    status: "done",
    extraMessages: [{ text: "然后帮我写一段介绍" }],
  };
  const html = render(task);
  assert.equal((html.match(/项目卡片交互已完善/g) || []).length, 1);
  assert.ok(
    html.indexOf("项目卡片交互已完善") < html.indexOf("然后帮我写一段介绍"),
  );
  assert.equal(latestArtifactReply(task).resultMode, undefined);
  assert.equal(latestArtifactReply(task).status, "done");
});

test("workspace feedback preserves findings while each follow-up keeps its own reply", () => {
  const first = WORKSPACE_TASKS.find((task) => task.workspaceKind === "review");
  let task = {
    ...first,
    ...resumePreview(first),
    resultMode: "simulated",
    status: "done",
    extraMessages: [{ text: "先处理第一条反馈" }],
  };
  task = {
    ...task,
    ...resumePreview(task),
    status: "running",
    extraMessages: [...task.extraMessages, { text: "再讨论键盘操作" }],
  };
  const html = render(task);
  assert.equal((html.match(/3 条需要关注的反馈/g) || []).length, 1);
  assert.equal((html.match(/这条审阅反馈已收到/g) || []).length, 1);
  assert.ok(
    html.indexOf("先处理第一条反馈") < html.indexOf("这条审阅反馈已收到"),
  );
  assert.ok(
    html.indexOf("这条审阅反馈已收到") < html.indexOf("再讨论键盘操作"),
  );
});

test("copy includes readable speakers and replies, excludes controls and closed details", () => {
  const text = (value) => ({ nodeType: 3, textContent: value });
  const element = (tagName, children, props = {}) => ({
    nodeType: 1,
    tagName,
    childNodes: children,
    children: children.filter((x) => x.nodeType === 1),
    getAttribute: () => null,
    ...props,
  });
  const root = element("DIV", [
    element("DIV", [
      element("STRONG", [text("你")]),
      element("P", [text("安排旅行")]),
      element("BUTTON", [text("复制消息")]),
    ]),
    element("DIV", [
      element("STRONG", [text("Codex")]),
      element("P", [text("先把行程节奏定下来")]),
    ]),
    element(
      "DETAILS",
      [
        element("SUMMARY", [text("已整理需求")]),
        element("P", [text("隐藏的过程")]),
      ],
      { open: false },
    ),
    element("DIV", [text("隐藏的控件")], { hidden: true }),
    element("INPUT", []),
  ]);
  const copied = readableTranscript(root, "旅行安排");
  for (const expected of [
    "旅行安排",
    "你",
    "安排旅行",
    "Codex",
    "先把行程节奏定下来",
    "已整理需求",
  ])
    assert.ok(copied.includes(expected));
  for (const absent of ["复制消息", "隐藏的过程", "隐藏的控件"])
    assert.ok(!copied.includes(absent));
});

test("停止未确认保留审批与问题，真正确认后才移除待办", () => {
  for (const id of ["approval", "question"]) {
    const seed = TASKS_V2.find((item) => item.id === id);
    const unknown = render({ ...seed, stopPhase: "unknown" });
    assert.match(unknown, /停止结果未知/);
    assert.match(unknown, /检查停止结果/);
    assert.doesNotMatch(unknown, /重试停止/);
    assert.match(unknown, id === "approval" ? /批准这一次/ : /提交回答/);
    const stopped = render({ ...seed, status: "stopped", stopPhase: null });
    assert.doesNotMatch(stopped, id === "approval" ? /批准这一次/ : /提交回答/);
  }
});

test("恢复只收到回执时发送锁住，缺少旧推理记录只允许显式确认缺值", () => {
  const seed = {
    ...TASKS_V2.find((item) => item.id === "recovery"),
    draft: "保留这句话",
  };
  const loading = render({
    ...seed,
    recoveryRead: {
      id: "r",
      phase: "loading",
      receipt: true,
      bodyComplete: false,
    },
  });
  assert.match(loading, /原内容与草稿保留，续发尚未开放/);
  assert.match(loading, /aria-label="发送消息"[^>]*disabled/);
  const old = render({
    ...seed,
    effort: undefined,
    identityIncomplete: true,
    reportedIdentity: { model: seed.model, effort: "High" },
  });
  assert.match(old, /确认缺失的选择/);
  assert.match(old, /已记录推理等级/);
  assert.match(old, /未记录/);
  assert.doesNotMatch(old, /恢复后的设置发生了变化/);
});

test("重启线程附件未核对时，当前输入和待发继续都禁止发送", () => {
  const task = {
    ...TASKS_V2.find((item) => item.id === "done"),
    draft: "当前正文",
    attachments: ["输入.md"],
    attachmentsNeedReview: true,
    queuePaused: true,
    queue: [{ id: "q", text: "队列正文不能丢", attachments: ["待发.pdf"] }],
  };
  const html = render(task);
  assert.match(html, /核对恢复的附件/);
  assert.match(html, /核对附件/);
  assert.match(html, /aria-label="加入待发"[^>]*disabled/);
  const continueButton = [
    ...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),
  ].find((match) => match[2].includes("继续发送"));
  assert.match(continueButton[1], /disabled/);
  assert.match(html, /队列正文不能丢/);
});

test("restart notices describe expired questions instead of claiming a stop request was sent", () => {
  const task = {
    id: "expired-question",
    agent: "A",
    title: "上次的问题",
    status: "unknown",
    unknownReason: "restart",
    interactionExpired: true,
    draft: "保留意见",
    queue: [],
  };
  const html = render(task);
  assert.match(html, /重新打开后，需要确认上次工作的结果/);
  assert.match(html, /上次的审批或问题已失效/);
  assert.doesNotMatch(html, /还没有收到停止确认|再次请求停止/);
  assert.match(html, /aria-label="发送消息"[^>]*disabled/);
});

test("declining and cancelling wait for a distinct result without fabricated work or stopped status", () => {
  for (const decisionOutcome of ["declined", "cancelled"]) {
    const task = {
      ...TASKS_V2.find((item) => item.id === "approval"),
      status: "running",
      resultMode: "decision",
      decisionOutcome,
    };
    const running = render(task);
    assert.doesNotMatch(
      running,
      /<strong>已停止<\/strong>|项目卡片交互已完善|Agent 已结束本次请求/,
    );
    const done = render({ ...task, status: "done" });
    assert.match(done, /Agent 已结束本次请求（模拟）/);
    assert.doesNotMatch(done, /<strong>已停止<\/strong>|项目卡片交互已完善/);
  }
});

test("read-only histories expose retained feedback drafts for copying without a send button", () => {
  const html = render({
    id: "readonly-feedback",
    agent: "A",
    status: "done",
    readOnly: true,
    draft: "保留的文件意见",
    queue: [],
  });
  assert.match(html, /保留的文件意见/);
  assert.match(html, /复制草稿/);
  assert.doesNotMatch(html, /aria-label="发送消息"/);
});

test("attachment-only messages render their files without inventing a prompt from the title", () => {
  const task = {
    id: "new-attachment",
    title: "a title is not a prompt",
    agent: "A",
    status: "running",
    prompt: "",
    sentAttachments: ["only-attachment.md"],
    resultMode: "simulated",
    queue: [],
  };
  const html = renderToStaticMarkup(
    React.createElement(ConversationTranscript, { task, copy() {} }),
  );
  assert.match(html, /only-attachment.md/);
  assert.doesNotMatch(html, /a title is not a prompt|请查看附加文件/);
});
