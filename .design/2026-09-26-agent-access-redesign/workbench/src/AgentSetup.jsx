import React, { useEffect, useRef, useState } from "react";
import { Plus, Robot } from "@phosphor-icons/react";
import { Button, Modal, Notice } from "./ui.jsx";
import { ServiceEditor } from "./SettingsApi.jsx";
import {
  compatibleServices,
  agentServiceFormats,
  changedServiceSource,
  serviceSelectionSnapshot,
  serviceChoiceIssue,
} from "./service-access.js";
import {
  normalizeAgent,
  preparedAgent,
  serviceAuthIssueFor,
  agentProgramReady,
  setupChoiceIssue,
  setupCompletionIssue,
  setupFingerprint,
} from "./agent-setup-state.js";
import { startAgentJob, cancelAgentJob } from "./access-jobs.js";
import {
  draftForEntry,
  selectionMatchesAgent,
  pendingOnboardingForEntry,
  hasPendingOnboarding,
  preservePendingPreparation,
} from "./setup-entry.js";
import AccessProgram from "./access-program.jsx";
import AccessJobStatus from "./access-job-status.jsx";
import SetupAuthentication from "./SetupAuthentication.jsx";
import {
  accountRequiredForSelection,
  authenticationFolder,
  authenticationRetryAllowed,
  rememberAuthenticationRequirement,
} from "./authentication-state.js";
import {
  entitlementIssue,
  entitlementRetryAllowed,
  markEntitlementForRetry,
} from "./selection-entitlement.js";
import "./access-ui.css";
import OnboardingLayout from "./OnboardingLayout.jsx";
import {
  onboardingInitial,
  nextOnboarding,
  onboardingStepIssue,
  usesOnboarding,
  initialOnboardingRecord,
} from "./onboarding-state.js";
import OnboardingMethod from "./OnboardingMethod.jsx";
import SetupTabs from "./SetupTabs.jsx";
import AgentModelRead from "./AgentModelRead.jsx";
import { currentModelOptions, modelReadScope } from "./model-read-state.js";
import "./setup-layout.css";
import "./agent-redesign.css";
import { AgentIdentity } from "./AgentEvidence.jsx";
import {
  needsAutomaticProgramCheck,
  setupSelectionChanged,
  setupSelectionSummary,
} from "./agent-redesign-state.js";

export function HubIcon({ agent, size = 32 }) {
  return agent.icon ? (
    <img
      className="hub-logo"
      src={agent.icon}
      width={size}
      height={size}
      alt=""
    />
  ) : (
    <span
      className="hub-generic-icon"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Robot size={Math.round(size * 0.65)} />
    </span>
  );
}
export default function AgentSetup({
  agent: input,
  services = [],
  setServices,
  onChange: commitChange,
  onClose,
  onUse,
  onImportExisting,
  initialSelection,
  initialContext: providedContext = {},
  allAgents = [],
  onOpenTest,
  busyCount = 0,
  blockingTasks = [],
  onOpenBlockingTask,
  toast = () => {},
  onManageServices,
  returnLabel = "暂时返回",
}) {
  const agent = normalizeAgent(input);
  const resumedContext = pendingOnboardingForEntry(
    agent,
    initialSelection,
    providedContext,
  );
  const initialContext = resumedContext || providedContext;
  const [draft, setDraft] = useState(() =>
    draftForEntry(agent, services, initialSelection, initialContext),
  );
  const entryDraft = useRef(structuredClone(draft));
  const [exitPrompt, setExitPrompt] = useState(false);
  const autoChecked = useRef(null);
  const wasAuthenticating = useRef(agent.accessJob?.type === "auth");
  const fixedConversation =
    initialContext.view === "thread" &&
    selectionMatchesAgent(agent, initialSelection);
  const guided = usesOnboarding(
    { ...initialContext, fixedConversation },
    agent,
  );
  const otherPreparation = useRef(
    !guided && hasPendingOnboarding(agent) ? structuredClone(agent) : null,
  );
  const onChange = (changes) =>
    commitChange(preservePendingPreparation(changes, otherPreparation.current));
  const [journey, setJourney] = useState(() =>
    onboardingInitial(agent, draft, { ...initialContext, fixedConversation }),
  );
  useEffect(() => {
    const record = initialOnboardingRecord(
      agent,
      draft,
      guided ? journey : null,
    );
    if (record) onChange(record);
  }, [guided]);
  const [methodChoice, setMethodChoice] = useState(
    journey?.intent ||
      (draft.access === "api"
        ? agentServiceFormats(agent).length
          ? "api"
          : ""
        : "existing"),
  );
  const cancelToMethod = useRef(false);
  const globalContext = ["agents", "explore"].includes(initialContext.view);
  const intent = initialContext.intent;
  const managementContext = globalContext && intent === "manage";
  const needsAuthentication = accountRequiredForSelection(agent, draft);
  const canUseAgentAccount =
    draft.access === "existing" ||
    agent.serviceCapabilities?.requiresAgentAuthentication === true ||
    needsAuthentication;
  const [editor, setEditor] = useState(null);
  const programReady = agentProgramReady(agent);
  const requestedPanel =
    initialContext.repair === "account"
      ? "account"
      : ["account", "model", "program"].includes(initialContext.panel)
        ? initialContext.panel
        : null;
  const [panel, setPanel] = useState(
    programReady ? requestedPanel || "account" : "program",
  );
  const wasReady = useRef(programReady);
  const [outcome, setOutcome] = useState("success");
  const [cancelOutcome, setCancelOutcome] = useState("success");
  const [savedNotice, setSavedNotice] = useState("");
  const busy = !!agent.accessJob;
  const requestClose = () => {
    if (!busy && setupSelectionChanged(entryDraft.current, draft))
      setExitPrompt(true);
    else onClose("return");
  };
  useEffect(() => {
    const key = `${agent.selectedInstallationId}:${agent.programRevision}:${agent.dependenciesMissing}`;
    if (agent.removed || !agent.registered) autoChecked.current = null;
    if (
      needsAutomaticProgramCheck(agent, busyCount) &&
      autoChecked.current !== key
    ) {
      autoChecked.current = key;
      onChange(
        startAgentJob(agent, "connect", { outcome, cancelOutcome, busyCount }),
      );
    }
  }, [
    agent.selectedInstallationId,
    agent.programRevision,
    agent.registered,
    agent.dependenciesMissing,
    agent.connected,
    agent.accessJob?.id,
    busyCount,
  ]);
  const compatible = compatibleServices(agent, services);
  const selectedService = services.find(
    (service) => service.id === draft.serviceId,
  );
  const sourceChanged = changedServiceSource(draft, selectedService);
  const models =
    draft.access === "api"
      ? selectedService?.models || []
      : currentModelOptions(agent, draft);
  const fingerprint = setupFingerprint(agent, draft, services);
  const testValid =
    draft.test === "passed" && draft.testFingerprint === fingerprint;
  const issue = setupChoiceIssue(agent, draft, services);
  const completionIssue = setupCompletionIssue(agent, draft, services);
  const currentAccount =
    agent.authentication?.status === "flow-finished" &&
    authenticationFolder(agent.authentication.folder) ===
      authenticationFolder(draft.folder) &&
    agent.authentication.accountService &&
    !agent.authentication.accountService.startsWith("演示")
      ? agent.authentication.accountService
      : null;
  const patch = (change) => {
    const next = { ...draft, ...change };
    setDraft(next);
    const updatedJourney = guided
      ? {
          ...journey,
          entryKey: onboardingInitial(
            { ...agent, onboarding: null },
            next,
            initialContext,
          ).entryKey,
        }
      : null;
    if (guided) setJourney(updatedJourney);
    onChange({
      setupDraft: next,
      setupComplete: false,
      ...(guided ? { onboarding: updatedJourney } : {}),
    });
  };
  const choose = (change) => {
    if (
      Object.entries(change).every(
        ([key, value]) => JSON.stringify(draft[key]) === JSON.stringify(value),
      )
    )
      return;
    if (Object.hasOwn(change, "serviceId")) setSavedNotice("");
    patch({ ...change, test: "idle", testFingerprint: null });
  };
  const advance = (action, selection = draft, patch = {}) => {
    const next = nextOnboarding(journey, action, {
      agent,
      selection,
      services,
      context: initialContext,
    });
    setJourney(next);
    onChange({ ...patch, setupDraft: selection, onboarding: next });
  };
  const chooseMethod = () => {
    const selection =
      methodChoice === "api"
        ? {
            ...draft,
            access: "api",
            serviceId: draft.access === "api" ? draft.serviceId : "",
            serviceSnapshot:
              draft.access === "api" ? draft.serviceSnapshot : undefined,
            model: draft.access === "api" ? draft.model : "",
          }
        : {
            ...draft,
            access: "existing",
            serviceId: "",
            serviceSnapshot: undefined,
            model:
              draft.access === "existing"
                ? draft.model
                : agent.model || agent.models?.[0] || "",
          };
    if (selection.access !== draft.access) {
      selection.test = "idle";
      selection.testFingerprint = null;
    }
    setDraft(selection);
    advance({ type: "choose", intent: methodChoice }, selection, {
      setupComplete: false,
    });
  };
  useEffect(() => {
    if (agent.setupDraft?.test !== undefined)
      setDraft((current) => ({
        ...current,
        test: agent.setupDraft.test,
        testFingerprint: agent.setupDraft.testFingerprint,
      }));
  }, [agent.setupDraft?.test, agent.setupDraft?.testFingerprint]);
  useEffect(() => {
    if (
      needsAuthentication &&
      programReady &&
      (!requestedPanel || initialContext.repair === "account")
    )
      setPanel("account");
  }, [
    needsAuthentication,
    programReady,
    requestedPanel,
    initialContext.repair,
  ]);
  useEffect(() => {
    if (!programReady) setPanel("program");
    else if (!wasReady.current) {
      setPanel(requestedPanel || "account");
      if (guided && journey?.step === "program") advance("next");
    }
    wasReady.current = programReady;
  }, [programReady]);
  useEffect(() => {
    if (wasAuthenticating.current && !agent.accessJob) {
      setDraft(
        draftForEntry(agent, services, initialSelection, initialContext),
      );
      setPanel("account");
      if (guided && journey?.step === "account") {
        if (cancelToMethod.current) {
          cancelToMethod.current = false;
          advance("back");
        } else if (agent.lastAccessResult?.status === "passed") {
          advance(
            agent.authentication?.status === "flow-finished"
              ? "after-auth"
              : "next",
          );
        }
      }
    }
    wasAuthenticating.current = agent.accessJob?.type === "auth";
  }, [agent.accessJob?.id]);
  const finish = () => {
    if (
      busy ||
      completionIssue ||
      (guided && onboardingStepIssue(journey, agent, draft, services))
    )
      return;
    const next = { ...preparedAgent(agent, draft, services), onboarding: null };
    onChange(
      fixedConversation
        ? {
            ...agent,
            setupDraft: next.setupDraft,
            setupEvidence: next.setupEvidence,
          }
        : next,
    );
    onUse?.(next.name, next, guided ? { intent: "use" } : undefined);
  };
  const saveService = (service) => {
    setServices?.((previous) =>
      previous.some((item) => item.id === service.id)
        ? previous.map((item) => (item.id === service.id ? service : item))
        : [...previous, service],
    );
    setEditor(null);
    setSavedNotice(
      `已保存“${service.name}”，尚未选用。请从下方列表选择，再确认模型。`,
    );
  };
  const test = () => {
    if (busy || issue) return;
    onChange(
      startAgentJob({ ...agent, setupDraft: draft }, "test", {
        outcome,
        cancelOutcome,
        busyCount,
        fingerprint,
        selection: {
          ...draft,
          secretRevision: selectedService?.secretRevision || 0,
        },
      }),
    );
  };
  const accountPanel = (
    <>
      <section className="access-sources">
        {!guided &&
          (agentServiceFormats(agent).length > 0 || draft.access === "api") && (
            <div
              className="setup-source-options"
              role="radiogroup"
              aria-label="模型来源"
            >
              <label
                className={`access-choice ${draft.access === "existing" ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name={`source-${agent.id}`}
                  checked={draft.access === "existing"}
                  disabled={busy || fixedConversation}
                  onChange={() =>
                    draft.access !== "existing" &&
                    choose({
                      access: "existing",
                      serviceId: "",
                      serviceSnapshot: undefined,
                      model: agent.models?.includes(agent.model)
                        ? agent.model
                        : agent.models?.[0] || "",
                    })
                  }
                />
                <span>
                  <strong>沿用已有设置</strong>
                  <small>使用 Agent 自己管理的账号或服务</small>
                </span>
              </label>
              <label
                className={`access-choice ${draft.access === "api" ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name={`source-${agent.id}`}
                  checked={draft.access === "api"}
                  disabled={
                    busy ||
                    fixedConversation ||
                    !agentServiceFormats(agent).length
                  }
                  onChange={() =>
                    draft.access !== "api" &&
                    choose({
                      access: "api",
                      serviceId: "",
                      serviceSnapshot: undefined,
                      model: "",
                    })
                  }
                />
                <span>
                  <strong>API 服务</strong>
                  <small>
                    {agentServiceFormats(agent).length
                      ? "使用你保存的 API 配置"
                      : "当前不可用，请切换到 Agent 配置"}
                  </small>
                </span>
              </label>
            </div>
          )}
        {draft.access === "api" && (
          <div className="access-service-choice">
            <label className="access-field">
              <span>为当前草稿选择服务</span>
              <select
                value={draft.serviceId}
                disabled={busy || fixedConversation}
                onChange={(event) =>
                  choose({
                    serviceId: event.target.value,
                    serviceSnapshot: serviceSelectionSnapshot(
                      services.find(
                        (service) => service.id === event.target.value,
                      ),
                    ),
                    model: "",
                  })
                }
              >
                <option value="">请选择一个已保存服务</option>
                {compatible.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
                {draft.serviceId &&
                  !compatible.some((item) => item.id === draft.serviceId) && (
                    <option value={draft.serviceId} disabled>
                      原服务已不可用
                    </option>
                  )}
              </select>
            </label>
            {!compatible.length && (
              <p className="access-muted">还没有可用服务。</p>
            )}
            <div className="access-inline">
              <Button
                disabled={busy}
                onClick={() => {
                  setEditor({});
                  setSavedNotice("");
                }}
              >
                <Plus size={15} />
                添加 API 服务
              </Button>
              {onManageServices && (
                <Button disabled={busy} onClick={onManageServices}>
                  管理所有服务
                </Button>
              )}
              {selectedService &&
                !serviceAuthIssueFor(agent, selectedService) && (
                  <Button
                    disabled={busy}
                    onClick={() => setEditor(selectedService)}
                  >
                    编辑所选服务
                  </Button>
                )}
            </div>
          </div>
        )}
        {draft.access === "api" &&
          selectedService &&
          serviceAuthIssueFor(agent, selectedService) && (
            <div className="access-inline">
              <p className="access-warning">这个服务明确返回了认证错误。</p>
              <Button
                disabled={busy}
                onClick={() => setEditor(selectedService)}
              >
                编辑此服务
              </Button>
            </div>
          )}
        {savedNotice && (
          <p role="status" className="access-success">
            {savedNotice}
          </p>
        )}
        {draft.access === "api" && sourceChanged && (
          <div className="access-confirm" role="alert">
            <strong>
              {fixedConversation ? "此对话仍使用原来源" : "确认服务来源变化"}
            </strong>
            <dl className="access-source-comparison">
              <div>
                <dt>原地址</dt>
                <dd>{draft.serviceSnapshot.endpoint}</dd>
              </div>
              <div>
                <dt>新地址</dt>
                <dd>{selectedService.endpoint}</dd>
              </div>
              <div>
                <dt>接口</dt>
                <dd>
                  {draft.serviceSnapshot.format} → {selectedService.format}
                </dd>
              </div>
            </dl>
            <p>
              {fixedConversation
                ? "请恢复原服务配置，或返回后明确新建对话；这里不能换掉旧对话的来源。"
                : "保存设置没有授权切换来源。确认后只更新当前草稿，已有对话保持原来源。"}
            </p>
            {!fixedConversation && (
              <Button
                disabled={busy}
                onClick={() =>
                  choose({
                    serviceSnapshot: serviceSelectionSnapshot(selectedService),
                  })
                }
              >
                确认此来源，用于当前草稿
              </Button>
            )}
            {onManageServices && (
              <Button disabled={busy} onClick={onManageServices}>
                查看 API 配置
              </Button>
            )}
          </div>
        )}
      </section>
      {!guided && draft.access === "existing" && (
        <AgentIdentity
          agent={agent}
          folder={draft.folder}
          source={
            currentAccount ? `沿用已有设置 · ${currentAccount}` : undefined
          }
          model={draft.model}
          testValid={testValid}
        />
      )}
      {!guided && canUseAgentAccount && (
        <details
          className="agent-account-actions"
          open={needsAuthentication || undefined}
        >
          <summary>
            {needsAuthentication ? "需要登录 · 查看登录方式" : "登录或更换账号"}
          </summary>
          <SetupAuthentication
            agent={agent}
            onChange={onChange}
            busyCount={busyCount}
            blockingTasks={blockingTasks}
            onOpenBlockingTask={onOpenBlockingTask}
            outcome={outcome}
            cancelOutcome={cancelOutcome}
            selection={draft}
            focused={guided}
            required={needsAuthentication}
          />
        </details>
      )}
    </>
  );
  const modelPanel = (
    <section className="access-model">
      <div className="agent-model-source">
        <span>当前来源</span>
        <strong>
          {draft.access === "api"
            ? selectedService?.name || "尚未选择 API 服务"
            : "沿用已有设置"}
        </strong>
        <small>
          {draft.access === "api"
            ? selectedService?.endpoint || "先在账号与服务中选择服务"
            : "具体服务由 Agent 管理；尚未提供时保持未知"}
        </small>
      </div>
      <div className="access-form-grid">
        <label className="access-field">
          <span>模型</span>
          {models.length ? (
            <select
              value={draft.model}
              disabled={busy || fixedConversation}
              onChange={(event) => choose({ model: event.target.value })}
            >
              <option value="">请选择模型</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          ) : (
            <span className="access-readonly">
              {draft.access === "existing"
                ? agent.modelCatalog?.scope === modelReadScope(agent, draft) &&
                  agent.modelCatalog?.status === "not-provided"
                  ? "由 Agent 自己的配置决定"
                  : "由 Agent 配置决定 · 尚未读取"
                : "先选择服务"}
            </span>
          )}
        </label>
        {agent.configOptions
          .filter((option) => option.id === "effort" && option.options?.length)
          .map((option) => (
            <label key={option.id} className="access-field">
              <span>{option.label}</span>
              <select
                value={draft.effort}
                disabled={busy || fixedConversation}
                onChange={(event) => choose({ effort: event.target.value })}
              >
                {option.options.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ))}
      </div>
      {draft.access === "existing" && (
        <AgentModelRead
          agent={agent}
          selection={draft}
          onChange={onChange}
          disabled={busy || !programReady || fixedConversation}
        />
      )}
      {setupSelectionChanged(entryDraft.current, draft) && (
        <div className="agent-selection-diff" role="status">
          <h4>待保存的变更</h4>
          <table>
            <thead>
              <tr>
                <th>设置</th>
                <th>进入时</th>
                <th>本次选择</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["source", "来源"],
                ["model", "模型"],
                ["effort", "推理等级"],
              ].map(([key, label]) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td>
                    {setupSelectionSummary(entryDraft.current, services)[key]}
                  </td>
                  <td>{setupSelectionSummary(draft, services)[key]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>确认后用于当前草稿与后续新对话；已有对话保持各自的来源。</p>
        </div>
      )}
      {(!guided || journey?.step === "review") && (
        <details className="onboarding-review-details">
          <summary>连接测试（可选）</summary>
          <div className="setup-test-heading">
            <h3>连接测试</h3>
            <span>可选</span>
          </div>
          <p className="access-muted">
            本原型仅模拟测试，不发送真实消息。真实使用时测试可能消耗额度。
          </p>
          {!agent.accessJob && agent.lastAccessResult?.type === "test" && (
            <div
              className={`setup-test-result ${testValid ? "access-success" : "access-muted"}`}
              role="status"
            >
              <span>
                {testValid
                  ? "当前选择已通过测试 · 演示"
                  : agent.lastAccessResult.fingerprint === fingerprint
                    ? agent.lastAccessResult.message
                    : "之前的测试记录不代表当前配置"}
              </span>
              {onOpenTest && (
                <Button onClick={() => onOpenTest(agent.lastAccessResult.id)}>
                  查看测试对话
                </Button>
              )}
            </div>
          )}
          {(completionIssue || issue) && (
            <p className="access-warning">{completionIssue || issue}</p>
          )}
          {entitlementIssue(agent, draft, selectedService) && (
            <div className="access-inline">
              <Button
                disabled={
                  busy || entitlementRetryAllowed(agent, draft, selectedService)
                }
                onClick={() =>
                  onChange(
                    markEntitlementForRetry(agent, draft, selectedService),
                  )
                }
              >
                已处理权益，重新检查
              </Button>
            </div>
          )}
          {!testValid && draft.test === "passed" && (
            <p className="access-warning">
              程序、连接或所选服务已变化，之前的检查不再适用。
            </p>
          )}
          <Button disabled={busy || !!issue} onClick={test}>
            {testValid ? "再次短测" : "测试当前选择"}
          </Button>
        </details>
      )}
    </section>
  );
  if (exitPrompt)
    return (
      <Modal
        className="agent-redesign-modal"
        title="保留未确认的设置？"
        onClose={() => setExitPrompt(false)}
        footer={
          <>
            <Button onClick={() => setExitPrompt(false)}>继续编辑</Button>
            <Button
              onClick={() => {
                onChange({ setupDraft: entryDraft.current });
                onClose("return");
              }}
            >
              放弃本次设置
            </Button>
            <Button primary onClick={() => onClose("return")}>
              保留草稿并返回
            </Button>
          </>
        }
      >
        <p>
          来源、模型或推理等级已有变更，还未确认使用。保留后可继续编辑；程序与账号操作的进度会保留。
        </p>
      </Modal>
    );
  if (editor)
    return (
      <ServiceEditor
        service={editor?.id ? editor : null}
        services={services}
        agents={[agent]}
        onSave={saveService}
        onCancel={() => setEditor(null)}
      />
    );
  if (
    !agent.accessJob &&
    (agent.registration?.open || agent.registrationPortal?.open)
  )
    return guided ? (
      <OnboardingLayout
        agent={agent}
        step="account"
        intent={journey?.intent}
        onClose={requestClose}
        showNext={false}
      >
        <SetupAuthentication
          agent={agent}
          onChange={onChange}
          busyCount={busyCount}
          blockingTasks={blockingTasks}
          onOpenBlockingTask={onOpenBlockingTask}
          outcome={outcome}
          cancelOutcome={cancelOutcome}
          selection={draft}
          focused
        />
      </OnboardingLayout>
    ) : (
      <Modal
        className="agent-redesign-modal"
        title={`${agent.name} · 创建账号`}
        onClose={() =>
          onChange({
            ...(agent.registrationPortal?.open
              ? {
                  registrationPortal: {
                    ...agent.registrationPortal,
                    open: false,
                  },
                }
              : { registration: { ...agent.registration, open: false } }),
          })
        }
      >
        <SetupAuthentication
          agent={agent}
          onChange={onChange}
          busyCount={busyCount}
          blockingTasks={blockingTasks}
          onOpenBlockingTask={onOpenBlockingTask}
          outcome={outcome}
          cancelOutcome={cancelOutcome}
          selection={draft}
        />
      </Modal>
    );
  if (agent.accountPreparation?.open || agent.accessJob?.type === "auth") {
    const authJob = agent.accessJob?.type === "auth";
    const content = (
      <>
        {authJob && (
          <AccessJobStatus
            compact
            agent={agent}
            onChange={onChange}
            onOpenTest={onOpenTest}
            cancelLabel={guided ? "取消登录，重新选择" : undefined}
            onCancel={
              guided
                ? () => {
                    cancelToMethod.current = true;
                    onChange(cancelAgentJob(agent));
                  }
                : undefined
            }
          />
        )}
        <SetupAuthentication
          agent={agent}
          onChange={onChange}
          busyCount={busyCount}
          blockingTasks={blockingTasks}
          onOpenBlockingTask={onOpenBlockingTask}
          outcome={outcome}
          cancelOutcome={cancelOutcome}
          selection={agent.accessJob?.selection || draft}
          required={needsAuthentication}
          focused={guided}
        />
      </>
    );
    return guided ? (
      <OnboardingLayout
        agent={agent}
        step="account"
        intent={journey?.intent}
        busy={authJob}
        showNext={false}
        onClose={requestClose}
      >
        {content}
      </OnboardingLayout>
    ) : (
      <Modal
        className="agent-redesign-modal"
        title={`${agent.name} · 登录与账号设置`}
        onClose={requestClose}
        footer={<Button onClick={requestClose}>暂离并保留进度</Button>}
      >
        {content}
      </Modal>
    );
  }
  if (guided) {
    const step = !programReady ? "program" : journey?.step || "method";
    const stepIssue = onboardingStepIssue(
      { ...journey, step },
      agent,
      draft,
      services,
    );
    const accountReady = authenticationRetryAllowed(agent, draft);
    return (
      <OnboardingLayout
        agent={agent}
        step={step}
        intent={journey?.intent}
        busy={busy}
        onClose={requestClose}
        onBack={step === "program" ? undefined : () => advance("back")}
        onNavigate={(target) => {
          if (busy || (target !== "program" && !programReady)) return;
          const next = {
            ...journey,
            step:
              target === "account"
                ? "method"
                : target === "model"
                  ? "review"
                  : "program",
            intent: journey?.intent || methodChoice || "existing",
          };
          setJourney(next);
          onChange({ onboarding: next, setupDraft: draft });
        }}
        programReady={programReady}
        showNext={step !== "program" && (step !== "account" || accountReady)}
        nextLabel={step === "review" ? "进入对话" : "继续"}
        nextDisabled={busy || (step === "method" ? !methodChoice : !!stepIssue)}
        onNext={() =>
          step === "method"
            ? chooseMethod()
            : step === "review"
              ? finish()
              : advance("next")
        }
      >
        {busy && step !== "program" && (
          <AccessJobStatus
            agent={agent}
            onChange={onChange}
            onOpenTest={onOpenTest}
          />
        )}
        {step === "program" && (
          <>
            <div className="onboarding-heading">
              <h3>准备 {agent.name} 程序</h3>
              <p>添加或安装后会自动检查，再确认账号服务与模型。</p>
            </div>
            <AccessJobStatus compact agent={agent} onChange={onChange} />
            <AccessProgram
              allAgents={allAgents}
              agent={agent}
              onChange={onChange}
              busyCount={busyCount}
              blockingTasks={blockingTasks}
              onOpenBlockingTask={onOpenBlockingTask}
              outcome={outcome}
              cancelOutcome={cancelOutcome}
            />
            {programReady && (
              <Button primary onClick={() => advance("next")}>
                继续
              </Button>
            )}
          </>
        )}
        {step === "method" && (
          <>
            <OnboardingMethod
              agent={agent}
              value={methodChoice}
              onChange={setMethodChoice}
            />
            {!methodChoice && draft.access === "api" && (
              <p className="access-warning">
                原 API 方式已不可用，请选择其他方式。草稿保留。
              </p>
            )}
          </>
        )}
        {step === "account" && (
          <>
            {needsAuthentication && (
              <p className="onboarding-inline-note" role="status">
                当前请求需要完成账号设置。
              </p>
            )}
            {!busy &&
              agent.lastAccessResult?.type === "auth" &&
              agent.lastAccessResult.status !== "passed" && (
                <AccessJobStatus compact agent={agent} onChange={onChange} />
              )}
            <SetupAuthentication
              agent={agent}
              onChange={onChange}
              busyCount={busyCount}
              blockingTasks={blockingTasks}
              onOpenBlockingTask={onOpenBlockingTask}
              outcome={outcome}
              cancelOutcome={cancelOutcome}
              selection={draft}
              required={needsAuthentication}
              focused
            />
          </>
        )}
        {step === "api" && (
          <>
            <div className="onboarding-heading">
              <h3>选择 API 服务</h3>
              <p>只在本次新对话中使用。</p>
            </div>
            {accountPanel}
            {draft.serviceId && modelPanel}
          </>
        )}
        {step === "review" && (
          <>
            <div className="onboarding-heading">
              <h3>确认这次使用的配置</h3>
              <p>进入对话后，你可以编辑草稿再发送。</p>
            </div>
            <dl className="onboarding-summary">
              <div>
                <dt>Agent</dt>
                <dd>{agent.name}</dd>
              </div>
              <div>
                <dt>账号或服务</dt>
                <dd>
                  {draft.access === "api"
                    ? selectedService?.name
                    : currentAccount
                      ? currentAccount
                      : "Agent 在这台电脑上的设置"}
                </dd>
              </div>
            </dl>
            <div className="onboarding-confirm-model">{modelPanel}</div>
            {needsAuthentication &&
              !authenticationRetryAllowed(agent, draft) && (
                <Button
                  primary
                  disabled={busy}
                  onClick={() => advance("repair-account")}
                >
                  前往登录设置
                </Button>
              )}
            {draft.access === "api" &&
              serviceChoiceIssue(draft, agent, services) && (
                <Button disabled={busy} onClick={() => advance("repair-api")}>
                  调整 API 服务
                </Button>
              )}
            {!stepIssue && (
              <p className="onboarding-inline-note">
                {testValid
                  ? "当前选择已通过演示测试。"
                  : "尚未验证模型请求；也可以先进入对话。"}
              </p>
            )}
          </>
        )}
        {stepIssue && !["program", "method", "account"].includes(step) && (
          <p className="access-warning" role="status">
            {stepIssue}
          </p>
        )}
        <details className="onboarding-review-details">
          <summary>评审：异常结果</summary>
          <label className="access-field">
            <span>下一次操作结果</span>
            <select
              disabled={busy}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            >
              <option value="success">成功</option>
              <option value="failure">失败</option>
              <option value="agent_auth_required">需要登录</option>
              <option value="service_auth_required">API 认证失败</option>
              <option value="entitlement">权限或额度不足</option>
              <option value="unknown">结果未知</option>
            </select>
          </label>
        </details>
      </OnboardingLayout>
    );
  }
  return (
    <Modal
      className="agent-redesign-modal"
      wide
      title={`${agent.name} 设置`}
      titleContent={
        <span className="setup-title">
          <HubIcon agent={agent} size={28} />
          {agent.name} <span>设置</span>
        </span>
      }
      onClose={requestClose}
      footer={
        <>
          <span className="access-footer-note">
            {completionIssue ||
              (fixedConversation
                ? "此对话的来源与模型保持不变"
                : managementContext
                  ? "保存到此 Agent，已有对话保持各自设置"
                  : returnLabel === "返回草稿"
                    ? "完成后返回草稿"
                    : "")}
          </span>
          <Button onClick={requestClose}>
            {busy ? "暂离并保留进度" : "暂时返回"}
          </Button>
          <Button primary disabled={busy || !!completionIssue} onClick={finish}>
            {intent === "import"
              ? "返回已有对话"
              : intent === "manage"
                ? "保存设置"
                : globalContext && intent !== "use"
                  ? "保存设置"
                  : fixedConversation
                    ? "返回对话"
                    : "使用此配置"}
          </Button>
        </>
      }
    >
      <div className="access-setup setup-layout">
        <>
          <div className="setup-context">
            <span
              title={
                managementContext ? "接入管理" : draft.folder || "普通对话"
              }
            >
              {managementContext ? "接入管理" : draft.folder || "普通对话"}
            </span>
            <span className={`setup-status ${programReady ? "ready" : ""}`}>
              <i aria-hidden="true" />
              {programReady ? "程序检查通过 · 演示" : "程序待检查 · 演示"}
            </span>
          </div>
          <SetupTabs
            value={panel}
            onChange={setPanel}
            programReady={programReady}
          />
          {initialContext.reason && (
            <p className="onboarding-inline-note" role="status">
              {initialContext.reason}
            </p>
          )}
          {(agent.accessJob ||
            (agent.lastAccessResult?.type !== "test" &&
              agent.lastAccessResult?.status !== "passed")) && (
            <AccessJobStatus
              compact
              agent={agent}
              onChange={onChange}
              onOpenTest={onOpenTest}
            />
          )}
          <div
            id="setup-panel-account"
            role="tabpanel"
            aria-labelledby="setup-tab-account"
            hidden={panel !== "account"}
          >
            {accountPanel}
          </div>
          <div
            id="setup-panel-model"
            role="tabpanel"
            aria-labelledby="setup-tab-model"
            hidden={panel !== "model"}
          >
            {modelPanel}
          </div>
          <div
            id="setup-panel-program"
            role="tabpanel"
            aria-labelledby="setup-tab-program"
            hidden={panel !== "program"}
          >
            <AccessProgram
              allAgents={allAgents}
              agent={agent}
              onChange={onChange}
              busyCount={busyCount}
              blockingTasks={blockingTasks}
              onOpenBlockingTask={onOpenBlockingTask}
              outcome={outcome}
              cancelOutcome={cancelOutcome}
            />
            {onImportExisting && agent.registered && (
              <Button
                disabled={busy}
                onClick={() => {
                  onClose();
                  onImportExisting(agent.name);
                }}
              >
                查找已有对话
              </Button>
            )}
          </div>
          <details className="access-review">
            <summary>评审工具 · 只改变模拟状态</summary>
            <p>
              {agent.capabilitiesEvidence || "没有执行真实程序、认证或请求。"}
            </p>
            {agentServiceFormats(agent).length > 0 && (
              <Button
                disabled={busy || !!busyCount}
                onClick={() =>
                  onChange({
                    ...rememberAuthenticationRequirement(agent, draft.folder),
                    serviceCapabilities: {
                      ...agent.serviceCapabilities,
                      requiresAgentAuthentication:
                        !agent.serviceCapabilities?.requiresAgentAuthentication,
                    },
                  })
                }
              >
                {agent.serviceCapabilities?.requiresAgentAuthentication
                  ? "演示 API 无需 Agent 账号"
                  : "演示 API 还需要 Agent 账号"}
              </Button>
            )}
            <div className="access-form-grid">
              <label className="access-field">
                <span>下一次操作结果</span>
                <select
                  disabled={busy}
                  value={outcome}
                  onChange={(event) => setOutcome(event.target.value)}
                >
                  <option value="success">成功</option>
                  <option value="failure">失败，保留原选择</option>
                  <option value="agent_auth_required">Agent 要求登录</option>
                  <option value="service_auth_required">
                    API 服务认证失败
                  </option>
                  <option value="authentication_unknown">
                    认证失败，来源未明
                  </option>
                  <option value="entitlement">权限或额度不足</option>
                  <option value="approval">等待确认</option>
                  <option value="unknown">结果未知</option>
                </select>
              </label>
              <label className="access-field">
                <span>取消结果</span>
                <select
                  disabled={busy}
                  value={cancelOutcome}
                  onChange={(event) => setCancelOutcome(event.target.value)}
                >
                  <option value="success">收到结束确认</option>
                  <option value="unknown">结束未确认</option>
                </select>
              </label>
            </div>
            <Button
              disabled={busy || !!busyCount || agent.connected}
              onClick={() =>
                onChange({ dependenciesMissing: !agent.dependenciesMissing })
              }
            >
              {agent.dependenciesMissing
                ? "模拟必要程序齐备"
                : "模拟缺少必要程序"}
            </Button>
          </details>
        </>
      </div>
    </Modal>
  );
}
