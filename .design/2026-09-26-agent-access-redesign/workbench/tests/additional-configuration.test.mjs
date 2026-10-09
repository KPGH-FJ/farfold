import { restorePrototypeSnapshot } from "../src/prototype-persistence.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  OBSERVED_CONFIGURATION_SAMPLE,
  INTERACTIVE_CONFIGURATION_SAMPLE,
  additionalOptions,
  optionEditable,
  optionChoices,
  optionLabel,
  validAdditionalValues,
} from "../src/additional-configuration.js";
import {
  AGENT_CATALOG,
  additionalOptionsFor,
  setupTestFingerprint,
} from "../src/agent-catalog.js";
import {
  configurationChoice,
  startConfigurationChange,
  finishConfigurationChange,
  configurationReceiptMatches,
} from "../src/conversation-configuration.js";
import { applyConversationPatch } from "../src/conversation-policy.js";
import { previewConversationBlocked } from "../src/conversation-state.js";
import { initialSetupDraft, preparedAgent } from "../src/agent-setup-state.js";
import { setupSelectionChanged } from "../src/agent-redesign-state.js";
import { draftForEntry } from "../src/setup-entry.js";

const source = {
  id: "sample",
  agent: "Example Agent",
  status: "done",
  model: "Model A",
  effort: "Low",
  accessMode: "existing",
  folder: "/example",
  draft: "保留草稿",
  queue: [{ text: "保留待发" }],
  reviewConfigurationOptions: true,
  configValues: { "review-detail": "standard" },
};
const capability = { configOptions: OBSERVED_CONFIGURATION_SAMPLE };
const choice = {
  ...configurationChoice(source),
  configValues: { "review-detail": "expanded" },
};
const begin = (task = source) =>
  applyConversationPatch(
    task,
    startConfigurationChange(task, capability, choice, "change-1"),
  );

test("审查样例只提供已观测的两个当前值，不推测替代值、语义和生效范围", () => {
  const options = additionalOptions(capability);
  assert.equal(options.length, 2);
  assert.deepEqual(
    options.map((item) => optionLabel(item)),
    ["Default", "Off"],
  );
  assert.deepEqual(
    options.map((item) => optionChoices(item).length),
    [1, 1],
  );
  assert.ok(
    options.every(
      (item) =>
        !optionEditable(item) &&
        !item.description &&
        !item.scope &&
        !item.effectiveAt,
    ),
  );
});

test("可交互选项只在明确开启演示后追加，未知类型即使声明可变仍只读", () => {
  assert.equal(
    additionalOptions(capability, {}).some(
      (item) => item.id === "review-detail",
    ),
    false,
  );
  const options = additionalOptions(capability, source);
  assert.equal(options.length, 4);
  assert.equal(
    optionEditable(options.find((item) => item.id === "review-detail")),
    true,
  );
  assert.equal(
    optionEditable({
      ...INTERACTIVE_CONFIGURATION_SAMPLE[1],
      changeSupported: true,
      options: ["a", "b"],
    }),
    false,
  );
});

test("值验证拒绝未声明选项、臆造开关值及对未知类型的更改", () => {
  const options = additionalOptions(capability, source);
  for (const values of [
    { fast_mode: "On" },
    { collaboration_mode: "Plan" },
    { "not-declared": "x" },
    { "review-detail": "invented" },
    { "review-unsupported": "edited" },
  ]) {
    assert.equal(validAdditionalValues(options, {}, values), false);
  }
  assert.equal(
    validAdditionalValues(options, {}, { "review-detail": "expanded" }),
    true,
  );
  assert.equal(
    validAdditionalValues(
      options,
      { retainedUnknown: "saved" },
      { retainedUnknown: "saved", "review-detail": "expanded" },
    ),
    true,
  );
  assert.equal(
    validAdditionalValues(options, { retainedUnknown: "saved" }, {}),
    false,
  );
});

test("附加设置先保留旧值，匹配确认回执后更新配置而不改来源、草稿和队列", () => {
  const pending = begin();
  assert.equal(pending.configurationChange.phase, "pending");
  assert.deepEqual(pending.configValues, source.configValues);
  assert.equal(previewConversationBlocked(pending), true);
  const patch = finishConfigurationChange(pending, "change-1", "success");
  assert.equal(configurationReceiptMatches(pending, patch), true);
  const saved = applyConversationPatch(pending, patch);
  assert.deepEqual(saved.configValues, choice.configValues);
  assert.deepEqual(saved.fixedIdentity.configValues, choice.configValues);
  assert.equal(saved.draft, source.draft);
  assert.deepEqual(saved.queue, source.queue);
  assert.equal(saved.queuePaused, true);
  assert.equal(saved.agent, source.agent);
});

test("普通 patch 不能越过首发后配置护栏，伪造回执也不能写入附加值", () => {
  const pending = begin();
  assert.deepEqual(
    applyConversationPatch(pending, { configValues: choice.configValues })
      .configValues,
    source.configValues,
  );
  assert.deepEqual(
    applyConversationPatch(pending, {
      configValues: choice.configValues,
      confirmConfiguration: { id: "wrong" },
    }).configValues,
    source.configValues,
  );
  const receipt = finishConfigurationChange(pending, "change-1", "success");
  receipt.configValues = { "review-detail": "invented" };
  assert.equal(configurationReceiptMatches(pending, receipt), false);
});

test("明确失败保留已确认附加值，未知暂停发送，核对后不自动发送队列", () => {
  const pending = begin();
  const failed = applyConversationPatch(
    pending,
    finishConfigurationChange(pending, "change-1", "failed"),
  );
  assert.deepEqual(failed.configValues, source.configValues);
  assert.equal(failed.configurationChange, null);
  let unknown = applyConversationPatch(
    pending,
    finishConfigurationChange(pending, "change-1", "unknown"),
  );
  assert.deepEqual(unknown.configValues, source.configValues);
  assert.equal(previewConversationBlocked(unknown), true);
  assert.equal(
    startConfigurationChange(unknown, capability, choice, "other"),
    null,
  );
  unknown = applyConversationPatch(
    unknown,
    finishConfigurationChange(unknown, "change-1", "success"),
  );
  assert.deepEqual(unknown.configValues, choice.configValues);
  assert.equal(unknown.queuePaused, true);
});

test("忙碌、审批、停止与未知期间不能开始附加配置变更", () => {
  for (const patch of [
    { status: "running" },
    { status: "approval" },
    { status: "question" },
    { status: "unknown" },
    { stopPhase: "unknown" },
    { configurationChange: { phase: "pending" } },
    { configurationChange: { phase: "unknown" } },
    { readOnly: true },
  ]) {
    assert.equal(
      startConfigurationChange(
        { ...source, ...patch },
        capability,
        choice,
        "change-1",
      ),
      null,
    );
  }
});

test("来源、位置与演示能力在等待中改变，迟到成功保持未知而不写入旧来源的值", () => {
  const pending = begin();
  for (const patch of [
    { agent: "Other Agent" },
    { folder: "/other" },
    { accessMode: "api" },
    { serviceSnapshot: { endpoint: "https://other.invalid" } },
    { reviewConfigurationOptions: false },
  ]) {
    const result = finishConfigurationChange(
      { ...pending, ...patch },
      "change-1",
      "success",
    );
    assert.equal(result.configurationChange.phase, "unknown");
    assert.equal(result.configValues, undefined);
  }
  assert.equal(finishConfigurationChange(pending, "wrong", "success"), null);
  assert.equal(finishConfigurationChange(pending, "change-1", "waiting"), null);
});

test("API 来源不继承沿用已有设置的审查样例，旧目录快照可呈现同一来源的只读样例", () => {
  const agent = AGENT_CATALOG.find((item) => item.configurationSamples?.length);
  assert.equal(
    additionalOptionsFor(
      { ...agent, configOptions: [] },
      { access: "existing" },
    ).length,
    2,
  );
  assert.deepEqual(additionalOptionsFor(agent, { access: "api" }), []);
  assert.deepEqual(
    additionalOptionsFor(agent, { accessMode: "api", serviceId: "api-1" }),
    [],
  );
});

test("接入草稿保存附加选择、退出比较能发现更改、测试证据随选择失效", () => {
  const agent = AGENT_CATALOG[0];
  const draft = { ...initialSetupDraft(agent), configValues: { sample: "a" } };
  const changed = { ...draft, configValues: { sample: "b" } };
  assert.equal(setupSelectionChanged(draft, changed), true);
  assert.notEqual(
    setupTestFingerprint(agent, draft),
    setupTestFingerprint(agent, changed),
  );
  const saved = preparedAgent(agent, draft, []);
  assert.deepEqual(saved.configValues, draft.configValues);
  assert.deepEqual(initialSetupDraft(saved).configValues, draft.configValues);
  const forConversation = draftForEntry(
    saved,
    [],
    { ...source, agentId: agent.id, configValues: { own: "value" } },
    { view: "thread", folder: source.folder },
  );
  assert.deepEqual(forConversation.configValues, { own: "value" });
});

test("重启演示将首发前后仍待保存的配置标为未知，保留旧值与待选值供核对", () => {
  const pending = begin();
  const snapshot = {
    version: 6,
    tasks: [pending],
    draft: {
      text: "未发草稿",
      files: [],
      choice: { ...pending, status: "draft" },
    },
  };
  const restored = restorePrototypeSnapshot(snapshot);
  assert.equal(restored.tasks[0].configurationChange.phase, "unknown");
  assert.equal(restored.draft.choice.configurationChange.phase, "unknown");
  assert.deepEqual(restored.tasks[0].configValues, source.configValues);
  assert.deepEqual(restored.draft.choice.configValues, source.configValues);
  assert.deepEqual(
    restored.draft.choice.configurationChange.next.configValues,
    choice.configValues,
  );
  assert.equal(restored.draft.text, "未发草稿");
  assert.equal(previewConversationBlocked(restored.tasks[0]), true);
});

test("模型尚未提供时仍能保存已声明的独立附加选项，不编造模型", () => {
  const task = { ...source, model: undefined, effort: undefined };
  const next = {
    ...configurationChoice(task),
    configValues: choice.configValues,
  };
  const pending = {
    ...task,
    ...startConfigurationChange(
      task,
      { configOptions: [] },
      next,
      "without-model",
    ),
  };
  assert.equal(pending.configurationChange.phase, "pending");
  const saved = finishConfigurationChange(pending, "without-model", "success");
  assert.equal(saved.model, undefined);
  assert.equal(saved.effort, undefined);
  assert.deepEqual(saved.configValues, choice.configValues);
});
