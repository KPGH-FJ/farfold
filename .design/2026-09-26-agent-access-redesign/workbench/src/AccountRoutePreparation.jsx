import React, { useState } from "react";
import { ArrowLeft, ArrowSquareOut, Terminal } from "@phosphor-icons/react";
import { Button } from "./ui.jsx";
import { officialAccountProgramConfirmed } from "./official-account-route.js";

export default function AccountRoutePreparation({
  agent,
  route,
  purpose,
  onBack,
  onContinue,
  disabled,
}) {
  const [missing, setMissing] = useState(false);
  const registration = purpose === "registration";
  const confirmed = officialAccountProgramConfirmed(agent, route.id);
  return (
    <section className="account-route-preparation">
      <Button kind="ghost" onClick={onBack}>
        <ArrowLeft size={15} />
        返回账号设置
      </Button>
      <div className="account-entry-heading">
        <h3>
          {route.kind === "terminal" ? "准备登录程序" : "继续官方账号流程"}
        </h3>
        <span>账号服务：{route.accountOwner}</span>
      </div>
      {registration && (
        <p className="access-muted">
          在接下来的官方流程中选择服务。没有账号时，前往该服务的注册入口，再回来继续登录。
        </p>
      )}
      {route.kind === "terminal" && (
        <>
          <p className="access-muted">
            {confirmed
              ? "将使用你已选择的登录程序。"
              : "选择用于登录的本机程序。"}
          </p>
          <div className="setup-current-summary">
            <strong>
              <Terminal size={17} /> {route.programLabel || route.command}
            </strong>
            <small>
              {missing
                ? "未找到程序 · 演示"
                : `${route.command} ${(route.args || []).join(" ")} · 演示候选`}
            </small>
          </div>
        </>
      )}
      {missing ? (
        <div className="account-entry-actions">
          <Button onClick={() => setMissing(false)}>重新查找</Button>
          {route.sourceUrl && (
            <a
              className="access-link"
              href={route.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              查看程序说明
              <ArrowSquareOut size={14} />
            </a>
          )}
        </div>
      ) : (
        <div className="account-entry-actions">
          <Button primary disabled={disabled} onClick={onContinue}>
            {route.kind === "terminal" && !confirmed
              ? "使用此程序并继续"
              : "继续官方流程"}
          </Button>
        </div>
      )}
      {route.kind === "terminal" && (
        <details className="access-review">
          <summary>评审：程序查找</summary>
          <Button onClick={() => setMissing(true)}>模拟未找到程序</Button>
        </details>
      )}
    </section>
  );
}
