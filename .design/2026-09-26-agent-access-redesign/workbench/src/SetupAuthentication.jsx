import React, { useState } from "react";
import { ArrowLeft, ArrowSquareOut, Key } from "@phosphor-icons/react";
import { Button } from "./ui.jsx";
import { authenticationTypeLabel } from "./agent-redesign-state.js";
import { accountCapabilities, accountRoute } from "./account-capabilities.js";
import {
  availableAuthMethods,
  authenticationFolder,
  authenticationRetryAllowed,
  authenticationStartIssue,
  manualAuthenticationIssue,
  manualAuthenticationMethod,
  markAuthenticationForRetry,
} from "./authentication-state.js";
import { continueAgentJob, startAgentJob } from "./access-jobs.js";
import AuthenticationInteraction from "./AuthenticationInteraction.jsx";
import {
  continueRegistrationLogin,
  rebaseRegistrationSelection,
  registrationSelectionChanged,
  registrationLoginIssue,
  registrationLoginFinished,
} from "./account-handoff.js";
import RegistrationJourney from "./RegistrationJourney.jsx";
import {
  beginRegistration,
  registrationTransition,
} from "./registration-state.js";

import AccountRegistration from "./AccountRegistration.jsx";
import AccountRoutePreparation from "./AccountRoutePreparation.jsx";
import AuthenticationWorkBlockers from "./AuthenticationWorkBlockers.jsx";
import {
  selectedOfficialAccountRoute,
  startOfficialAccountRoute,
  officialAccountProgramConfirmed,
  confirmOfficialAccountProgram,
} from "./official-account-route.js";
export {
  selectedOfficialAccountRoute,
  startOfficialAccountRoute,
} from "./official-account-route.js";

export default function SetupAuthentication({
  agent,
  onChange,
  busyCount = 0,
  blockingTasks = [],
  onOpenBlockingTask,
  outcome = "success",
  cancelOutcome = "success",
  selection = {},
  required = false,
  focused = false,
}) {
  const methods = availableAuthMethods(agent);
  const capabilities = accountCapabilities(agent);
  const [routeId, setRoute] = useState(
    agent.accountRouteSelection || capabilities.routes[0]?.id || "",
  );
  const [manualOpen, setManualOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [methodId, setMethod] = useState(
    agent.authMethodSelection ||
      agent.registration?.methodId ||
      methods[0]?.id ||
      "",
  );
  const [command, setCommand] = useState(
    agent.manualAuthentication?.command || "",
  );
  const [args, setArgs] = useState(
    agent.manualAuthentication?.args?.join("\n") || "",
  );
  const [variable, setVariable] = useState(
    agent.manualAuthentication?.secretVariable || "",
  );
  const [manualError, setManualError] = useState("");
  const method = methods.find((item) => item.id === methodId);
  const selectedRoute = selectedOfficialAccountRoute(agent, method);
  const route = capabilities.routes.find((item) => item.id === routeId);
  const showRoutes = !methods.length || !!agent.accountRouteSelection;
  const registration =
    agent.registration?.methodId === methodId ? agent.registration : null;
  const setRegistration = (next) =>
    onChange({ ...agent, registration: next, authMethodSelection: methodId });
  const loginOptions = { busyCount, outcome, cancelOutcome, selection };
  const startManual = () => {
    if (locked) return;
    const error = manualAuthenticationIssue(command, args, variable);
    if (error) {
      setManualError(error);
      return;
    }
    setManualError("");
    const next = startAgentJob(
      { ...agent, accountRouteSelection: undefined },
      "auth",
      {
        authMethod: manualAuthenticationMethod(command, args, variable),
        busyCount,
        outcome,
        cancelOutcome,
        selection,
      },
    );
    setMethod("manual-explicit");
    onChange({ ...next, authMethodSelection: "manual-explicit" });
  };
  const job = agent.accessJob?.type === "auth" ? agent.accessJob : null;
  const blocked = authenticationStartIssue(agent, method, busyCount);
  const programBlocked =
    !agent.installed ||
    !agent.registered ||
    !agent.connected ||
    agent.dependenciesMissing ||
    agent.removed;
  const locked = !!agent.accessJob || !!busyCount || programBlocked;
  const blockedByWork = !!busyCount && !programBlocked && !agent.accessJob;
  const workBlockers = (
    <AuthenticationWorkBlockers
      tasks={blockingTasks}
      onOpenTask={onOpenBlockingTask}
    />
  );
  const startRoute = (chosen, purpose = "settings", confirmedAgent = agent) => {
    if (locked || !chosen) return;
    if (
      (purpose === "registration" ||
        (chosen.kind === "terminal" &&
          !officialAccountProgramConfirmed(confirmedAgent, chosen.id))) &&
      !confirmedAgent.accountPreparation?.confirmed
    ) {
      onChange({
        ...confirmedAgent,
        accountPreparation: { routeId: chosen.id, purpose, open: true },
      });
      return;
    }
    if (chosen.kind === "terminal") {
      const next = startOfficialAccountRoute(
        { ...confirmedAgent, accountPreparation: null },
        chosen.id,
        {
          ...loginOptions,
          accountActionPurpose: purpose,
        },
      );
      if (next === agent) return;
      setMethod(next.authMethodSelection);
      onChange(next);
    } else {
      onChange({
        ...confirmedAgent,
        accountPreparation: null,
        accountRouteSelection: chosen.id,
        accountPage: {
          routeId: chosen.id,
          purpose,
          open: true,
          selection: structuredClone(selection),
        },
      });
    }
  };
  const flowFinishedHere =
    agent.authentication?.status === "flow-finished" &&
    !agent.authentication?.accountService?.startsWith("演示") &&
    agent.authentication?.method === methodId &&
    authenticationFolder(agent.authentication.folder) ===
      authenticationFolder(selection.folder) &&
    (!method?.manual || !agent.accountRouteSelection || !!selectedRoute);
  if (agent.registrationPortal?.open) {
    const portalRoute = accountRoute(agent, agent.registrationPortal.routeId);
    const clearPortal = () => ({
      ...agent,
      registrationPortal: { ...agent.registrationPortal, open: false },
    });
    if (!portalRoute)
      return (
        <section className="onboarding-heading">
          <h3>原账号入口已不可用</h3>
          <p>返回后重新选择登录方式。</p>
          <Button primary onClick={() => onChange(clearPortal())}>
            返回登录
          </Button>
        </section>
      );
    return (
      <>
        {workBlockers}
        <AccountRegistration
          agent={agent}
          route={portalRoute}
          onChange={onChange}
          onBack={() => onChange(clearPortal())}
          onLogin={() => startRoute(portalRoute, "settings", clearPortal())}
          loginDisabled={locked}
        />
      </>
    );
  }
  if (job)
    return (
      <section
        className="access-auth account-active-login"
        aria-label="认证动作"
      >
        {job?.status === "waiting" && (
          <AuthenticationInteraction
            key={job.id}
            job={job}
            accountRoute={selectedOfficialAccountRoute(agent, job.authMethod)}
            onProgress={() =>
              onChange({
                ...agent,
                accessJob: { ...job, simulatedSettingsSaved: true },
              })
            }
            onPageChange={(changes) =>
              onChange({ ...agent, accessJob: { ...job, ...changes } })
            }
            onComplete={() => onChange(continueAgentJob(agent, job.id))}
            onFailure={() =>
              onChange(
                continueAgentJob(
                  {
                    ...agent,
                    accessJob: {
                      ...job,
                      outcome: "failed",
                      failureMessage:
                        job.authMethod.type === "terminal"
                          ? "登录未完成，请检查登录程序的提示后重试。"
                          : "登录未完成：本次授权未获同意。可以重新登录。",
                    },
                  },
                  job.id,
                ),
              )
            }
          />
        )}
      </section>
    );
  if (agent.accountPreparation?.open) {
    const preparationRoute = accountRoute(
      agent,
      agent.accountPreparation.routeId,
    );
    if (preparationRoute)
      return (
        <>
          {workBlockers}
          <AccountRoutePreparation
            agent={agent}
            route={preparationRoute}
            purpose={agent.accountPreparation.purpose}
            disabled={locked}
            onBack={() => onChange({ ...agent, accountPreparation: null })}
            onContinue={() => {
              const confirmed = confirmOfficialAccountProgram(
                agent,
                preparationRoute.id,
              );
              startRoute(preparationRoute, agent.accountPreparation.purpose, {
                ...confirmed,
                accountPreparation: {
                  ...agent.accountPreparation,
                  confirmed: true,
                },
              });
            }}
          />
        </>
      );
  }
  if (agent.accountPage?.open) {
    const page = accountRoute(agent, agent.accountPage.routeId);
    return (
      <section className="access-auth account-entry" aria-label="官方设置页面">
        <div className="account-entry-heading">
          <h3>{page?.label || "登录设置"}</h3>
          <span>官方页面交接 · 原型演示</span>
        </div>
        <p>
          {page
            ? "在官方页面完成账号或服务设置，然后返回 Farfold。"
            : "这个入口已不可用，请返回选择其他方式。"}
        </p>
        <Button
          primary
          onClick={() =>
            onChange({
              ...agent,
              accountPage: { ...agent.accountPage, open: false },
            })
          }
        >
          <ArrowLeft size={15} />
          返回 Farfold
        </Button>
        <details className="account-entry-details">
          <summary>设置详情</summary>
          <p>这里只展示已核实的页面去向。返回不代表登录成功，原选择仍保留。</p>
          {page?.sourceUrl && (
            <a
              className="access-link"
              href={page.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              官方设置说明
              <ArrowSquareOut size={14} />
            </a>
          )}
        </details>
      </section>
    );
  }
  if (agent.registration?.open) {
    const registration = agent.registration;
    return (
      <>
        {workBlockers}
        <RegistrationJourney
          loginFinished={registrationLoginFinished(agent, registration)}
          state={registration}
          onChange={(next) => onChange({ ...agent, registration: next })}
          onBack={() =>
            onChange({
              ...agent,
              registration: { ...registration, open: false },
            })
          }
          continueIssue={registrationLoginIssue(
            agent,
            registration,
            loginOptions,
          )}
          onUseCurrentSelection={
            registrationSelectionChanged(registration, selection) &&
            rebaseRegistrationSelection(agent, registration, loginOptions) !==
              agent
              ? () => {
                  const rebased = rebaseRegistrationSelection(
                    agent,
                    registration,
                    loginOptions,
                  );
                  onChange(
                    continueRegistrationLogin(
                      rebased,
                      rebased.registration,
                      loginOptions,
                    ),
                  );
                }
              : undefined
          }
          onContinue={(next) =>
            onChange(continueRegistrationLogin(agent, next, loginOptions))
          }
        />
      </>
    );
  }
  return (
    <section className="access-auth account-entry" aria-label="账号操作">
      <div className="account-entry-heading">
        <h3>{focused ? "登录与账号设置" : "账号"}</h3>
        <span>
          {required
            ? "需要完成登录后再使用"
            : flowFinishedHere
              ? "已完成设置"
              : focused
                ? "选择这次要使用的账号服务"
                : "需要设置或更换账号时，在这里操作"}
        </span>
      </div>
      {blocked &&
        (!blockedByWork || !blockingTasks.length) &&
        ((!showRoutes && methods.length > 0) || locked) && (
          <p className="access-warning" role="status">
            {blocked}
          </p>
        )}
      {workBlockers}
      {showRoutes ? (
        capabilities.routes.length ? (
          <>
            {(capabilities.routes.length > 1 || !route) && (
              <label className="access-field">
                <span>账号与服务</span>
                <select
                  value={routeId}
                  disabled={!!agent.accessJob}
                  onChange={(event) => {
                    setRoute(event.target.value);
                    onChange({
                      ...agent,
                      accountRouteSelection: event.target.value,
                    });
                  }}
                >
                  {!route && (
                    <option value={routeId} disabled>
                      原设置方式不可用，请重新选择
                    </option>
                  )}
                  {capabilities.routes.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {route && (
              <p className="agent-auth-type">
                <span className="agent-method-type">
                  {authenticationTypeLabel(route)}
                </span>
                <small>
                  {route.purpose === "service"
                    ? "在 Agent 官方流程中设置服务"
                    : "官方账号设置流程"}{" "}
                  · 演示
                </small>
              </p>
            )}
            <div className="account-entry-actions">
              <Button
                primary={focused || required}
                disabled={locked || !route}
                onClick={() => startRoute(route)}
              >
                <Key size={16} />
                {route?.actionLabel || "打开登录设置"}
              </Button>
              {route?.registration && (
                <Button
                  disabled={!!agent.accessJob}
                  onClick={() =>
                    onChange({
                      ...agent,
                      registrationPortal: {
                        open: true,
                        routeId: route.id,
                        page: "choose",
                      },
                    })
                  }
                >
                  没有账号？创建账号
                </Button>
              )}
            </div>
          </>
        ) : (
          <div className="account-entry-actions">
            <Button
              primary={focused || required}
              disabled={!!agent.accessJob}
              onClick={() => setManualOpen(true)}
            >
              打开登录设置
            </Button>
          </div>
        )
      ) : (
        <>
          {methods.length > 1 || !method ? (
            <div className="agent-auth-methods" aria-label="选择并开始登录">
              {methods.map((item) => (
                <button
                  type="button"
                  className="agent-auth-method"
                  key={item.id}
                  data-method-id={item.id}
                  data-selected={methodId === item.id}
                  aria-label={`登录账号 · ${item.accountLabel || item.label} · ${authenticationTypeLabel(item)}`}
                  disabled={
                    locked || !!authenticationStartIssue(agent, item, busyCount)
                  }
                  onClick={() => {
                    setMethod(item.id);
                    onChange({
                      ...startAgentJob(agent, "auth", {
                        ...loginOptions,
                        authMethod: item,
                      }),
                      authMethodSelection: item.id,
                    });
                  }}
                >
                  <span className="agent-method-type">
                    {authenticationTypeLabel(item)}
                  </span>
                  <strong>{item.accountLabel || item.label}</strong>
                  <small>
                    {item.label}
                    {item.description ? ` · ${item.description}` : ""}
                  </small>
                  <span>选择并开始 →</span>
                </button>
              ))}
            </div>
          ) : (
            method && (
              <p className="agent-auth-type">
                <span className="agent-method-type">
                  {authenticationTypeLabel(method)}
                </span>
                <small>{method.label}</small>
              </p>
            )
          )}
          {!method && (
            <p className="access-warning">原登录方式不可用，请重新选择</p>
          )}
          <div className="account-entry-actions">
            {methods.length <= 1 && method && (
              <Button
                primary={focused || required}
                disabled={locked || !!blocked}
                onClick={() =>
                  onChange(
                    startAgentJob(agent, "auth", {
                      authMethod: method,
                      busyCount,
                      outcome,
                      cancelOutcome,
                      selection,
                    }),
                  )
                }
              >
                <Key size={16} />
                {flowFinishedHere
                  ? "重新登录"
                  : method?.manual
                    ? method.label
                    : method?.accountLabel
                      ? `登录 ${method.accountLabel}`
                      : "登录账号"}
              </Button>
            )}

            {method?.registration ? (
              <Button
                disabled={!!agent.accessJob}
                onClick={() =>
                  setRegistration(
                    registration
                      ? registrationTransition(registration, "resume")
                      : beginRegistration({
                          accountLabel: method.accountLabel || method.label,
                          methodId,
                          destination: method.registration.destination,
                          selection,
                        }),
                  )
                }
              >
                {registration ? "继续创建账号" : "没有账号？创建账号"}
              </Button>
            ) : null}
          </div>
        </>
      )}

      {!(showRoutes ? route?.registration : method?.registration) &&
        agent.sourceUrl && (
          <div className="agent-registration-help">
            <span>没有账号？</span>
            <a href={agent.sourceUrl} target="_blank" rel="noreferrer">
              查看目录提供的说明 <ArrowSquareOut size={13} />
            </a>
            <small>未提供专门的注册入口；此链接是说明页。</small>
          </div>
        )}
      <>
        {required && (
          <Button
            disabled={locked || authenticationRetryAllowed(agent, selection)}
            onClick={() =>
              onChange(markAuthenticationForRetry(agent, selection))
            }
          >
            已在外部完成设置，重新检查
          </Button>
        )}
        <details
          className="account-entry-details account-entry-more"
          open={manualOpen || moreOpen}
          onToggle={(event) => {
            setMoreOpen(event.currentTarget.open);
            if (!event.currentTarget.open) setManualOpen(false);
          }}
        >
          <summary>更多登录选项</summary>

          {capabilities.routes.length > 0 && (
            <Button
              disabled={!!agent.accessJob}
              onClick={() => {
                const selected = capabilities.routes.some(
                  (item) => item.id === routeId,
                )
                  ? routeId
                  : capabilities.routes[0].id;
                setRoute(selected);
                onChange({ ...agent, accountRouteSelection: selected });
              }}
            >
              其他官方登录方式
            </Button>
          )}

          {agent.authenticationEvidence && (
            <p>{agent.authenticationEvidence}</p>
          )}
          {method && !method.registration && !selectedRoute && (
            <p>此登录方式未提供注册入口，可在其官方登录页注册后返回。</p>
          )}
          {registration?.status === "registered" && (
            <p>
              {flowFinishedHere
                ? "注册与登录流程已结束（演示），模型权限和额度仍待实际请求确认。"
                : "注册进度已保留。继续登录后，再确认模型权限和额度。"}
            </p>
          )}
          {agent.sourceUrl && (
            <a
              className="access-link"
              href={agent.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              {agent.sourceLabel || "接入项目说明"}
              <ArrowSquareOut size={14} />
            </a>
          )}
          {(route?.sourceUrl || selectedRoute?.sourceUrl) && (
            <a
              className="access-link"
              href={route?.sourceUrl || selectedRoute.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              官方设置说明
              <ArrowSquareOut size={14} />
            </a>
          )}
          {showRoutes && (
            <p>
              这是官方文档确认的设置步骤。程序提供的登录方式会优先展示；文档动作只在你选择后开始演示。
            </p>
          )}
          {agent.accountRouteSelection &&
            methods.some((item) => !item.manual) && (
              <Button
                disabled={!!agent.accessJob}
                onClick={() => {
                  const nextMethod = methods.find((item) => !item.manual);
                  setMethod(nextMethod.id);
                  onChange({
                    ...agent,
                    accountRouteSelection: undefined,
                    authMethodSelection: nextMethod.id,
                  });
                }}
              >
                使用程序提供的登录方式
              </Button>
            )}
          {capabilities.note && <p>{capabilities.note}</p>}
          <details
            className="account-entry-details"
            open={manualOpen}
            onToggle={(event) => setManualOpen(event.currentTarget.open)}
          >
            <summary>手动配置登录</summary>
            <p>
              只填写你明确选择的演示命令和普通参数；不会执行命令，也不接收真实密钥或密码。
            </p>
            <label className="access-field">
              <span>登录程序路径或命令</span>
              <input
                value={command}
                disabled={!!agent.accessJob}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="/path/to/login-program"
              />
            </label>
            <label className="access-field">
              <span>参数（每行一个）</span>
              <textarea
                rows={2}
                value={args}
                disabled={!!agent.accessJob}
                onChange={(event) => setArgs(event.target.value)}
                placeholder="login"
              />
            </label>
            <label className="access-field">
              <span>密钥变量名称（可选，只填名称）</span>
              <input
                value={variable}
                disabled={!!agent.accessJob}
                onChange={(event) => setVariable(event.target.value)}
                placeholder="EXAMPLE_API_KEY"
              />
            </label>
            {manualError && (
              <p className="access-error" role="alert">
                {manualError}
              </p>
            )}
            <Button disabled={locked || !command.trim()} onClick={startManual}>
              模拟运行这条登录命令
            </Button>
          </details>
        </details>
      </>
    </section>
  );
}
