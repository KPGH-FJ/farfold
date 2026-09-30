import test from "node:test";
import assert from "node:assert/strict";
import { setupTestFingerprint } from "../src/agent-catalog.js";
import {
  canAttempt,
  makeAttempt,
  admittedConversation,
  draftSignature,
  draftConflicts,
  authScopeKey,
  rememberAuthFailure,
  settleSuccessfulAuthBlock,
  releasePreparedAuthFailure,
  completePreparation,
  preparationEntry,
  preparationReturn,
  scopedAuthIssue,
} from "../src/workbench-state.js";
const draft = {
  text: "保留我的任务",
  files: ["资料一.md", "资料二.md"],
  folder: "阅读笔记",
  choice: {
    agent: "Codex",
    model: "A",
    effort: "High",
    accessMode: "existing",
  },
};
function withTestProof(prepared, service) {
  const evidence = prepared.setupEvidence;
  const fingerprint = setupTestFingerprint(
    prepared,
    evidence,
    service ? [service] : [],
  );
  return {
    ...prepared,
    setupEvidence: { ...evidence, testFingerprint: fingerprint },
    lastAccessResult: {
      ...prepared.lastAccessResult,
      fingerprint,
      folder: evidence.folder,
    },
  };
}
test("已添加并连接且认证未知的已有设置可尝试普通任务，无全局短测门槛", () => {
  assert.equal(
    canAttempt({ installed: true, registered: true, connected: true }),
    true,
  );
  assert.equal(canAttempt({ installed: true, connected: false }), false);
  assert.equal(canAttempt({ installed: true, removed: true }), false);
});
test("拒绝首次消息不制造历史，也不修改草稿", () => {
  const a = makeAttempt({ ...draft, outcome: "rejected", id: "r" });
  assert.equal(admittedConversation(a), null);
  assert.deepEqual(a.draft, draft);
});
test("未知结果保留请求身份，不能包装为明确失败", () => {
  const a = makeAttempt({ ...draft, outcome: "unknown", id: "u" });
  const t = admittedConversation(a);
  assert.equal(t.id, "u");
  assert.equal(t.status, "unknown");
  assert.equal(t.unknownReason, "admission");
  assert.equal(t.simulatePending, false);
  assert.deepEqual(t.sentAttachments, draft.files);
});
test("晚到接纳只允许清除仍等于提交快照的草稿", () => {
  const a = makeAttempt({ ...draft, outcome: "success", id: "a" });
  assert.equal(a.signature, draftSignature(draft));
  assert.notEqual(
    a.signature,
    draftSignature({ ...draft, text: "后来写下的新内容" }),
  );
  assert.notEqual(
    a.signature,
    draftSignature({ ...draft, folder: "另一目录" }),
  );
});
test("从别处改Agent或来源必须处理未发草稿冲突，附件单独存在也算", () => {
  assert.equal(
    draftConflicts(draft, { ...draft.choice, agent: "OpenCode" }),
    true,
  );
  assert.equal(
    draftConflicts(
      { ...draft, text: "" },
      { ...draft.choice, serviceId: "new" },
    ),
    true,
  );
  assert.equal(draftConflicts(draft, { ...draft.choice }), false);
});

test("首次给尚未选择 Agent 的草稿带回配置，保留内容且不制造更换来源冲突", () => {
  const first = {
    ...draft,
    choice: { agent: "", model: "", accessMode: "existing" },
  };
  const result = completePreparation(
    { view: "new", intent: "use" },
    first,
    draft.choice,
  );
  assert.equal(result.conflict, false);
  assert.deepEqual(result.draft.files, first.files);
  assert.equal(result.draft.text, first.text);
  assert.deepEqual(result.draft.choice, draft.choice);
});
test("A和B分别保留自身来源和原工作目录", () => {
  const a = admittedConversation(
    makeAttempt({ ...draft, outcome: "success", id: "a" }),
  );
  const b = admittedConversation(
    makeAttempt({
      ...draft,
      choice: { ...draft.choice, agent: "OpenCode" },
      folder: "个人网站",
      outcome: "success",
      id: "b",
    }),
  );
  assert.equal(a.choice, undefined);
  assert.equal(a.agent, "Codex");
  assert.equal(a.folder, "阅读笔记");
  assert.equal(b.agent, "OpenCode");
  assert.equal(a.status, "running");
  assert.equal(b.status, "running");
});
test("多个API认证失败互不覆盖，换来源或更新密钥仅改变对应匹配范围", () => {
  const a = {
    ...draft,
    choice: { ...draft.choice, accessMode: "api", serviceId: "a" },
    service: { id: "a", secretRevision: 1 },
  };
  const b = {
    ...a,
    choice: { ...a.choice, serviceId: "b" },
    service: { id: "b", secretRevision: 1 },
  };
  let blocks = rememberAuthFailure(
    {},
    makeAttempt({ ...a, outcome: "auth", id: "a" }),
    "old-a",
  );
  blocks = rememberAuthFailure(
    blocks,
    makeAttempt({ ...b, outcome: "auth", id: "b" }),
    "old-b",
  );
  assert.equal(Object.keys(blocks).length, 2);
  assert.ok(blocks[authScopeKey(a)]);
  assert.ok(blocks[authScopeKey(b)]);
  assert.equal(
    blocks[
      authScopeKey({ ...a, service: { ...a.service, secretRevision: 2 } })
    ],
    undefined,
  );
  assert.ok(blocks[authScopeKey(a)], "旧密钥范围仍记得失败");
});
test("已有设置在两个位置失败后分别保留，成功重新测试只解除入口位置", () => {
  const a = { ...draft, folder: "位置A" },
    b = { ...draft, folder: "位置B" };
  let blocks = rememberAuthFailure(
    {},
    makeAttempt({ ...a, outcome: "auth", id: "a" }),
    "old",
  );
  blocks = rememberAuthFailure(
    blocks,
    makeAttempt({ ...b, outcome: "auth", id: "b" }),
    "old",
  );
  const prepared = withTestProof({
    name: "Codex",
    setupEvidence: {
      access: "existing",
      folder: "位置A",
      model: "A",
      effort: "High",
    },
    lastAccessResult: { type: "test", status: "passed", id: "new" },
  });
  const released = releasePreparedAuthFailure(blocks, a, prepared);
  assert.equal(released[authScopeKey(a)], undefined);
  assert.ok(released[authScopeKey(b)]);
  assert.ok(blocks[authScopeKey(a)], "不原地修改旧状态");
  assert.ok(
    releasePreparedAuthFailure(released, b, prepared)[authScopeKey(b)],
    "A 的测试不能再被 B 复用",
  );
});
test("旧测试、只完成授权、无关来源测试不能解除API认证阻断", () => {
  const context = {
    ...draft,
    choice: { ...draft.choice, accessMode: "api", serviceId: "a" },
    service: { id: "a", secretRevision: 1 },
  };
  const blocks = rememberAuthFailure(
    {},
    makeAttempt({ ...context, outcome: "auth", id: "a" }),
    "old",
  );
  const prepared = withTestProof(
    {
      name: "Codex",
      setupEvidence: {
        access: "api",
        serviceId: "a",
        folder: draft.folder,
        model: "A",
        effort: "High",
        secretRevision: 1,
      },
      lastAccessResult: { type: "test", status: "passed", id: "new" },
    },
    context.service,
  );
  for (const changed of [
    {
      ...prepared,
      lastAccessResult: { ...prepared.lastAccessResult, id: "old" },
    },
    {
      ...prepared,
      lastAccessResult: { ...prepared.lastAccessResult, type: "auth" },
    },
    { ...prepared, setupEvidence: { access: "api", serviceId: "b" } },
    { ...prepared, setupEvidence: { ...prepared.setupEvidence, model: "B" } },
    {
      ...prepared,
      setupEvidence: { ...prepared.setupEvidence, effort: "Low" },
    },
    {
      ...prepared,
      setupEvidence: { ...prepared.setupEvidence, folder: "其他位置" },
    },
    {
      ...prepared,
      setupEvidence: { ...prepared.setupEvidence, secretRevision: 0 },
    },
    { ...prepared, name: "OpenCode" },
    { ...prepared, programRevision: 3 },
    {
      ...prepared,
      lastAccessResult: {
        ...prepared.lastAccessResult,
        fingerprint: "another-test",
      },
    },
  ])
    assert.ok(
      releasePreparedAuthFailure(blocks, context, changed)[
        authScopeKey(context)
      ],
    );
  assert.equal(
    releasePreparedAuthFailure(blocks, context, prepared)[
      authScopeKey(context)
    ],
    undefined,
  );
});
test("已有对话完成准备返回原对话，其他未发草稿的内容附件位置和选择完全不变", () => {
  const next = { ...draft.choice, agent: "OpenCode", model: "B" };
  const result = completePreparation(
    { view: "thread", active: "original-thread" },
    draft,
    next,
  );
  assert.deepEqual(result.destination, {
    view: "thread",
    active: "original-thread",
  });
  assert.equal(result.draft, draft);
  assert.equal(result.conflict, false);
  assert.equal(result.draft.choice.agent, "Codex");
});
test("草稿入口仍可确认新选择，其他入口仍保护冲突草稿", () => {
  const next = { ...draft.choice, model: "B" };
  const direct = completePreparation(
    { view: "new", agent: "Codex", signature: draftSignature(draft) },
    draft,
    next,
  );
  assert.equal(direct.conflict, false);
  assert.equal(direct.draft.choice.model, "B");
  const conflict = completePreparation({ view: "new-intent" }, draft, next);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.draft, draft);
});

test("经设置进入准备保留既有对话身份，完成后返回设置且不碰新草稿", () => {
  const task = {
    id: "old",
    agent: "OpenCode",
    accessMode: "existing",
    model: "B",
    effort: "",
    folder: "旧目录",
  };
  const original = preparationEntry({
    view: "thread",
    active: "old",
    tasks: [task],
    draft,
  });
  const entry = preparationEntry({
    view: "settings",
    active: "old",
    tasks: [task],
    draft,
    settingsContext: original,
  });
  assert.equal(entry.view, "settings");
  assert.equal(entry.contextView, "thread");
  assert.equal(entry.contextActive, "old");
  assert.equal(entry.choice.agent, "OpenCode");
  assert.equal(entry.folder, "旧目录");
  assert.equal(entry.agent, "OpenCode");
  const complete = completePreparation(entry, draft, { ...task, model: "C" });
  assert.deepEqual(complete.destination, { view: "settings", active: "old" });
  assert.equal(complete.draft, draft);
  assert.equal(complete.conflict, false);
});

test("首发已知认证失败也阻止同来源既有对话续发，其他来源与位置不受影响", () => {
  const current = { ...draft, service: null };
  const blocks = rememberAuthFailure(
    {},
    makeAttempt({ ...current, outcome: "auth", id: "failed" }),
  );
  assert.match(scopedAuthIssue(blocks, current), /重新验证/);
  assert.equal(
    scopedAuthIssue(blocks, { ...current, folder: "另一个位置" }),
    null,
  );
  const api = {
    ...draft,
    choice: { ...draft.choice, accessMode: "api", serviceId: "api" },
    service: { id: "api", secretRevision: 1 },
  };
  const all = rememberAuthFailure(
    blocks,
    makeAttempt({ ...api, outcome: "auth", id: "api-failed" }),
  );
  assert.match(scopedAuthIssue(all, api), /API/);
  assert.equal(
    scopedAuthIssue(all, {
      ...api,
      service: { ...api.service, secretRevision: 2 },
    }),
    null,
  );
  assert.equal(
    scopedAuthIssue({}, api, { authRequired: true }),
    null,
    "已有设置的认证错误不污染 API",
  );
});

test("未指定使用意图的全局管理不改变草稿，明确新开才带入", () => {
  for (const entry of [
    null,
    { view: "agents" },
    { view: "explore" },
    { view: "settings", active: "api" },
  ]) {
    const result = completePreparation(entry, draft, {
      ...draft.choice,
      model: "B",
    });
    assert.equal(result.draft, draft);
    assert.equal(result.conflict, false);
    assert.equal(result.destination.view, entry?.view || "agents");
  }
  const result = completePreparation(
    { view: "new-intent" },
    { ...draft, text: "", files: [] },
    { ...draft.choice, model: "B" },
  );
  assert.equal(result.destination.view, "new");
  assert.equal(result.draft.choice.model, "B");
});
test("同名服务地址变化也属于草稿来源冲突，密钥轮换不改变来源", () => {
  const current = {
    ...draft,
    choice: {
      ...draft.choice,
      serviceSnapshot: {
        id: "s",
        endpoint: "https://first.invalid",
        format: "openai",
      },
    },
  };
  assert.equal(
    draftConflicts(current, {
      ...current.choice,
      serviceSnapshot: {
        ...current.choice.serviceSnapshot,
        endpoint: "https://second.invalid",
      },
    }),
    true,
  );
  assert.equal(
    draftConflicts(current, {
      ...current.choice,
      serviceSnapshot: { ...current.choice.serviceSnapshot, secretRevision: 2 },
    }),
    false,
  );
});

test("探索中的准备使用完成后带回草稿，保留未发送内容且不产生对话", () => {
  const next = { ...draft.choice, model: "B" };
  const empty = { ...draft, text: "", files: [] };
  const result = completePreparation(
    { view: "agents", intent: "use" },
    empty,
    next,
  );
  assert.equal(result.destination.view, "new");
  assert.deepEqual(result.draft, { ...empty, choice: next });
  assert.equal(result.conflict, false);
  assert.equal(result.task, undefined);
});

test("探索中准备另一选择遇到有内容草稿时必须保留并确认", () => {
  const result = completePreparation({ view: "agents", intent: "use" }, draft, {
    ...draft.choice,
    agent: "OpenCode",
    model: "B",
  });
  assert.equal(result.destination.view, "new");
  assert.equal(result.conflict, true);
  assert.equal(result.draft, draft);
});

test("从草稿进入管理只保存设置，不能顺带更改草稿的模型", () => {
  const result = completePreparation({ view: "new", intent: "manage" }, draft, {
    ...draft.choice,
    model: "B",
  });
  assert.deepEqual(result.destination, { view: "new" });
  assert.equal(result.draft, draft);
  assert.equal(result.conflict, false);
});

test("已有对话导入补连接后返回同一 Agent 的导入，不触碰全局草稿", () => {
  const result = completePreparation(
    {
      view: "conversations",
      active: "old-thread",
      intent: "import",
      importAgent: "OpenCode",
    },
    draft,
    { ...draft.choice, agent: "OpenCode", model: "B" },
  );
  assert.deepEqual(result.destination, {
    view: "conversations",
    active: "old-thread",
    importAgent: "OpenCode",
  });
  assert.equal(result.draft, draft);
  assert.equal(result.conflict, false);
});

test("导入连接失败或暂离时也能返回保留的导入，不冒充连接成功", () => {
  const entry = {
    view: "conversations",
    intent: "import",
    importAgent: "OpenCode",
    choice: { agent: "OpenCode", model: "历史模型" },
  };
  assert.deepEqual(preparationReturn(entry), {
    view: "conversations",
    importAgent: "OpenCode",
  });
  assert.equal(entry.choice.model, "历史模型");
});

test("修复后首次发送成功会清除原作用域旧阻断，其他位置仍保留", () => {
  const attempt = makeAttempt({ ...draft, outcome: "auth", id: "failed" });
  const other = makeAttempt({
    ...draft,
    folder: "另一位置",
    outcome: "auth",
    id: "other",
  });
  const blocks = rememberAuthFailure(rememberAuthFailure({}, attempt), other);
  for (const outcome of ["unknown", "rejected", "agent_auth"])
    assert.equal(
      settleSuccessfulAuthBlock(blocks, { ...attempt, outcome }),
      blocks,
    );
  const settled = settleSuccessfulAuthBlock(blocks, {
    ...attempt,
    outcome: "success",
  });
  assert.equal(settled[authScopeKey(draft)], undefined);
  assert.ok(settled[authScopeKey(other.draft)]);
  assert.ok(blocks[authScopeKey(draft)]);
});
