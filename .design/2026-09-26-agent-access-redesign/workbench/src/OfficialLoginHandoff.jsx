import React from "react";
import { ArrowSquareOut, Terminal } from "@phosphor-icons/react";
import { Button } from "./ui.jsx";
import {
  beginOfficialHandoff,
  transitionOfficialHandoff,
} from "./official-handoff-state.js";

export default function OfficialLoginHandoff({
  job,
  accountRoute,
  onPageChange,
  onComplete,
  onFailure,
}) {
  const official = !job.authMethod.manual || !!accountRoute;
  const initial = beginOfficialHandoff(accountRoute, job.authMethod);
  // Existing preview progress remains valid when moving to the common layout.
  const flow = job.officialHandoff || {
    ...initial,
    stage: job.authPageOpen
      ? "external"
      : job.authPageReturned || job.authPageError
        ? "waiting"
        : "ready",
  };
  const act = (action) =>
    onPageChange({
      officialHandoff: transitionOfficialHandoff(flow, action),
      ...(action === "open" ? { authPageError: false } : {}),
    });
  const device = job.authMethod.presentation === "device";
  const service = flow.mode === "service";
  const program =
    accountRoute?.programLabel || accountRoute?.command || "登录程序";
  const external = flow.stage === "external";
  const done = ["confirmed", "returned"].includes(flow.stage);
  return (
    <section
      className="onboarding-account-card"
      aria-label={official ? "官方登录交接" : "登录程序交接"}
    >
      <div className="onboarding-heading">
        <span className="onboarding-inline-note">
          {official
            ? "官方流程预览 · 不执行真实登录"
            : "自定义登录预览 · 不执行真实登录"}
        </span>
        <h3>
          {done
            ? service
              ? "设置步骤已返回"
              : "已收到授权结果"
            : service
              ? `在 ${program} 中配置服务`
              : `登录 ${flow.account || "所选账号"}`}
        </h3>
        <p>
          {done
            ? service
              ? "接下来确认模型，再通过请求检查是否可用。"
              : "返回后可确认模型与本次使用方式。"
            : service
              ? "服务选择和账号验证由这个程序提供。"
              : "在账号服务的页面完成登录与授权。"}
        </p>
      </div>
      {device && (
        <div className="account-device-code">
          <span>在授权页面输入此代码</span>
          <code>DEMO-ONLY</code>
          {job.authMethod.expiresInMs && (
            <small>{`演示有效期：${job.authMethod.expiresInMs / 60000} 分钟`}</small>
          )}
        </div>
      )}
      {external ? (
        <div className="onboarding-external">
          <strong>
            {service
              ? `${program} 的交互步骤`
              : `${flow.account || "账号服务"} 的授权页面`}
          </strong>
          <p>
            {service
              ? accountRoute?.inputHint || "按程序提示选择服务并完成配置。"
              : device
                ? "在登录页面输入设备码，再确认授权。"
                : "这里预览离开 Farfold 后的授权步骤。"}
          </p>
          <div className="onboarding-actions">
            <Button
              primary
              onClick={() => act(service ? "settings-returned" : "approve")}
            >
              {service ? "模拟完成程序设置" : "模拟同意授权"}
            </Button>
            <Button onClick={() => act("return")}>返回 Farfold</Button>
          </div>
        </div>
      ) : done ? (
        <Button primary onClick={onComplete}>
          {service ? "返回并检查" : "继续"}
        </Button>
      ) : (
        <>
          {flow.stage === "waiting" && (
            <p className="onboarding-inline-note" role="status">
              {job.authPageError
                ? "登录页面未打开，可以重新打开。"
                : "尚未收到完成结果，可以继续原流程。"}
            </p>
          )}
          <Button primary onClick={() => act("open")}>
            <ArrowSquareOut size={16} />
            {service
              ? flow.stage === "waiting"
                ? "继续服务设置"
                : "打开服务设置"
              : flow.stage === "waiting"
                ? "重新打开登录页"
                : "打开登录页"}
          </Button>
        </>
      )}
      <details className="onboarding-review-details">
        <summary>流程详情与演示结果</summary>
        <p>此处只预览登录步骤，不接收账号、密码或密钥。</p>
        <p>{job.authMethod.label}</p>
        {(accountRoute?.command || job.authMethod.command) && (
          <p>
            <Terminal size={14} />{" "}
            {accountRoute?.command || job.authMethod.command}{" "}
            {(accountRoute?.args || job.authMethod.args || []).join(" ")}
          </p>
        )}
        {accountRoute?.sourceUrl && (
          <a href={accountRoute.sourceUrl} target="_blank" rel="noreferrer">
            官方账号说明
          </a>
        )}
        {!service && (
          <Button
            onClick={() =>
              onPageChange({
                officialHandoff: { ...flow, stage: "waiting" },
                authPageError: true,
              })
            }
          >
            模拟页面未打开
          </Button>
        )}
        <Button onClick={onFailure}>模拟登录或配置失败</Button>
      </details>
    </section>
  );
}
