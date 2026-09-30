import React from "react";
import {
  ArrowLeft,
  ArrowSquareOut,
  Globe,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button } from "./ui.jsx";
import {
  registrationDestinationAddress,
  registrationTransition,
} from "./registration-state.js";
import "./registration.css";

export default function RegistrationJourney({
  state,
  onChange,
  onContinue,
  onBack,
  continueIssue,
  onUseCurrentSelection,
  loginFinished = false,
}) {
  const api = state.kind === "api";
  const loginComplete = !api && loginFinished;
  const registered = ["registered", "key-issued"].includes(state.status);
  const keyIssued = state.status === "key-issued";
  const external = state.page === "external";
  const address = registrationDestinationAddress(state.destination);
  const act = (action) => onChange(registrationTransition(state, action));
  const continueLogin = (source = state) => {
    if (continueIssue) return;
    const next = registrationTransition(source, "return");
    if (onContinue) onContinue(next);
    else onChange(next);
  };
  const openPage = () =>
    act(
      state.status === "ready"
        ? "start"
        : state.status === "failed"
          ? "retry"
          : "open-page",
    );
  const account = state.accountLabel || "所选服务账号";
  const pageLabel = address
    ? state.destination?.label || "官方注册页面"
    : "注册步骤预览";
  if (api && !address)
    return (
      <section className="registration-journey" aria-label="API 账号与密钥准备">
        <div className="registration-heading">
          <h3>{account}</h3>
          <span>API 服务</span>
        </div>
        <div className="registration-current">
          <h4>准备账号与 API 密钥</h4>
          <p>请自行向服务方获取 API 密钥；需要账号时，先完成注册或登录。</p>
          <div className="registration-actions">
            <Button primary onClick={() => act("return")}>
              返回填写 API 配置
            </Button>
          </div>
        </div>
        <div className="registration-return">
          <small>原 API 表单内容保留</small>
        </div>
      </section>
    );
  return (
    <section
      className={
        api
          ? "registration-journey"
          : "registration-journey onboarding-registration"
      }
      aria-label={api ? "API 服务注册" : "账号注册"}
    >
      {!api && onBack && (
        <Button kind="ghost" onClick={onBack}>
          <ArrowLeft size={15} />
          返回登录
        </Button>
      )}
      <div className={api ? "registration-heading" : "onboarding-heading"}>
        <h3>{api ? account : "创建账号"}</h3>
        {api ? <span>API 服务</span> : <p>{account}</p>}
      </div>

      {loginComplete ? (
        <div className="registration-current" aria-live="polite">
          <h4>登录步骤已完成，可返回准备页继续</h4>
          <p>不需要重复登录。</p>
        </div>
      ) : external ? (
        <div
          className="registration-external"
          aria-label={address ? "官方注册页面预览" : "注册步骤预览"}
        >
          <div className="registration-external-heading">
            <Globe size={20} />
            <div>
              <strong>{pageLabel}</strong>
              <span>外部步骤 · 未打开真实网站</span>
            </div>
          </div>
          <p>
            {registered
              ? api
                ? "在服务商页面获取密钥；完成后返回 Farfold 填写配置。"
                : "完成注册后返回 Farfold，继续 Agent 提供的登录授权。"
              : address
                ? "在官方页面创建账号，完成邮箱或手机号验证及必要确认。"
                : "在账号服务提供的流程中完成注册。"}
          </p>
          <Button primary onClick={() => act("return-page")}>
            <ArrowLeft size={15} />
            返回 Farfold
          </Button>
        </div>
      ) : (
        <div className="registration-current" aria-live="polite">
          {state.status === "ready" && (
            <>
              <h4>{address ? "先到官方页面注册" : "准备账号"}</h4>
              <p>
                {api
                  ? "注册服务账号，再获取 API 密钥。"
                  : "在账号服务提供的流程中注册，然后继续登录。"}
              </p>
            </>
          )}
          {state.status === "waiting" && (
            <>
              <h4>注册结果待确认</h4>
              <p>
                {api
                  ? "已有账号后，可继续获取密钥。"
                  : "已注册可继续登录；尚未完成可返回注册步骤。"}
              </p>
            </>
          )}
          {state.status === "failed" && (
            <>
              <h4>
                <WarningCircle size={16} />
                注册尚未完成
              </h4>
              <p>返回注册步骤重试，或稍后再处理。</p>
            </>
          )}
          {registered && (
            <>
              <h4>
                {state.existingAccount ? "使用已有账号" : "注册步骤已完成"}
              </h4>
              <p>
                {api
                  ? keyIssued
                    ? "密钥获取步骤已完成。返回后仍需填写并保存 API 配置。"
                    : "接下来在服务商控制台取得 API 密钥，再回到这里配置。"
                  : "接下来继续登录，由 Agent 确认授权结果。"}
              </p>
            </>
          )}
          {continueIssue && !api && (
            <p className="registration-blocked" role="status">
              继续登录前：{continueIssue}
            </p>
          )}
          <div className="registration-actions">
            {continueIssue && onUseCurrentSelection && (
              <Button primary onClick={onUseCurrentSelection}>
                按当前选择继续登录
              </Button>
            )}
            {!registered && (
              <Button
                primary={state.status !== "waiting" || api}
                onClick={openPage}
              >
                <ArrowSquareOut size={15} />
                {address
                  ? state.status === "ready"
                    ? api
                      ? "前往官方注册"
                      : "前往创建账号"
                    : "打开官方页面"
                  : "查看注册步骤"}
              </Button>
            )}
            {!api && state.status === "waiting" && (
              <Button
                primary
                disabled={Boolean(continueIssue)}
                onClick={() => continueLogin()}
              >
                我已注册，继续登录
              </Button>
            )}
            {registered && !api && (
              <Button
                primary
                disabled={Boolean(continueIssue)}
                onClick={() => continueLogin()}
              >
                继续登录
              </Button>
            )}
            {registered && api && !keyIssued && (
              <Button primary onClick={openPage}>
                <ArrowSquareOut size={15} />
                打开服务商页面
              </Button>
            )}
            {keyIssued && (
              <Button primary onClick={() => act("return")}>
                返回填写 API 配置
              </Button>
            )}
            {!registered && (api || state.status !== "waiting") && (
              <Button
                disabled={!api && Boolean(continueIssue)}
                onClick={() =>
                  api
                    ? act("existing-account")
                    : continueLogin(
                        registrationTransition(state, "existing-account"),
                      )
                }
              >
                {api
                  ? state.status === "waiting"
                    ? "我已注册，获取密钥"
                    : "已有账号，获取密钥"
                  : "已有账号，继续登录"}
              </Button>
            )}
          </div>
        </div>
      )}

      {(api || !onBack || loginComplete) && (
        <div className="registration-return">
          <Button primary={loginComplete} onClick={() => act("return")}>
            {api ? "返回 API 配置" : "返回准备页"}
          </Button>
          <small>
            {api ? "原 API 表单内容保留" : "原草稿、来源和模型保持不变"}
          </small>
        </div>
      )}

      <details className="registration-details">
        <summary>注册详情</summary>
        {!address && <p>注册入口尚未核实；此处只演示离开与返回。</p>}
        {address && <p className="registration-address">官方页面：{address}</p>}
        <p>返回应用不会被当作注册成功。注册、登录授权和订阅额度分别确认。</p>
        <p>
          {api
            ? "获取密钥不会自动保存或交付给 Agent。"
            : "模型是否可用，仍由后续实际请求确认。"}
        </p>
        <p>外部页面以流程占位展示，不接收密码、验证码或个人资料。</p>
      </details>

      {!loginComplete && (
        <details className="registration-review">
          <summary>评审工具 · 设置外部步骤结果</summary>
          <p>只改变原型状态，不发起注册、授权或密钥请求。</p>
          <div className="registration-demo">
            {state.status === "waiting" && (
              <>
                <Button onClick={() => act("registered")}>模拟注册完成</Button>
                <Button onClick={() => act("fail")}>模拟注册未完成</Button>
              </>
            )}
            {api && state.status === "registered" && (
              <Button onClick={() => act("key-issued")}>模拟已获取密钥</Button>
            )}
            {state.status === "ready" && (
              <span>先打开注册步骤，再设置返回结果。</span>
            )}
            {(state.status === "failed" ||
              (!api && registered) ||
              keyIssued) && <span>当前结果已保留。通过上方主操作继续。</span>}
          </div>
        </details>
      )}
    </section>
  );
}
