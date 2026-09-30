import React from "react";
import {
  ArrowLeft,
  ArrowSquareOut,
  Globe,
  UserCircle,
} from "@phosphor-icons/react";
import { Button } from "./ui.jsx";

function accountAddress(value) {
  try {
    const address = new URL(value);
    return address.protocol === "https:" &&
      !address.username &&
      !address.password
      ? address
      : null;
  } catch {
    return null;
  }
}

export default function AccountRegistration({
  agent,
  route,
  onChange,
  onBack,
  onLogin,
  loginDisabled = false,
}) {
  const options = [route?.registration, ...(route?.registrationOptions || [])]
    .filter(
      (option) =>
        option?.status === "verified-entry" &&
        option.id &&
        option.owner &&
        accountAddress(option.url),
    )
    .filter(
      (option, index, all) =>
        all.findIndex((item) => item.id === option.id) === index,
    );
  const saved =
    agent.registrationPortal?.open &&
    agent.registrationPortal.routeId === route?.id
      ? agent.registrationPortal
      : null;
  const selected =
    options.find((option) => option.id === saved?.optionId) ||
    (options.length === 1 ? options[0] : null);
  const page =
    saved?.optionId === selected?.id &&
    ["choose", "external", "returned"].includes(saved?.page)
      ? saved.page
      : "choose";
  const locked = !!agent.accessJob;
  const fixedAccount =
    route?.purpose === "login" ||
    route?.interaction?.serviceSelection === "fixed-account";
  const owner = route?.accountOwner || "所选账号";
  const address = selected ? accountAddress(selected.url) : null;
  const guide = accountAddress(
    route?.registration?.sourceUrl || route?.sourceUrl,
  );
  const update = (nextPage, option = selected) => {
    if (locked || !option) return;
    onChange({
      ...agent,
      registrationPortal: {
        open: true,
        routeId: route.id,
        optionId: option.id,
        page: nextPage,
      },
    });
  };

  return (
    <section aria-label="创建账号" className="onboarding-registration">
      <Button kind="ghost" onClick={onBack}>
        <ArrowLeft size={15} />
        返回登录
      </Button>
      <div className="onboarding-heading">
        <h3>创建账号</h3>
        <p>
          {selected
            ? `${selected.owner}账号`
            : options.length
              ? "选择要创建的账号"
              : fixedAccount
                ? `在 ${owner} 的登录流程中创建账号`
                : `先在 ${route?.programLabel || route?.command || "该 Agent"} 中选择模型服务`}
        </p>
      </div>

      {!options.length ? (
        <div className="onboarding-account-card">
          <div className="access-inline">
            <Button
              primary
              disabled={locked || loginDisabled}
              onClick={onLogin}
            >
              {fixedAccount ? "打开登录页" : "打开服务设置"}
            </Button>
            {guide && (
              <a
                className="access-link"
                href={guide.href}
                target="_blank"
                rel="noreferrer"
              >
                官方账号说明
                <ArrowSquareOut size={14} />
              </a>
            )}
          </div>
        </div>
      ) : page === "choose" ? (
        <>
          {options.length > 1 && (
            <div
              className="onboarding-options"
              role="group"
              aria-label="注册账号服务"
            >
              {options.map((option) => (
                <Button
                  key={option.id}
                  className="onboarding-option"
                  aria-pressed={selected?.id === option.id}
                  disabled={locked}
                  onClick={() => update("choose", option)}
                >
                  <UserCircle size={22} />
                  <span>
                    <strong>{option.owner}</strong>
                    <small>{accountAddress(option.url).hostname}</small>
                  </span>
                </Button>
              ))}
            </div>
          )}
          <div className="account-entry-actions">
            <Button
              primary
              disabled={locked || !selected}
              onClick={() => update("external")}
            >
              <ArrowSquareOut size={15} />
              前往创建账号
            </Button>
          </div>
        </>
      ) : (
        <div className="onboarding-account-card" aria-live="polite">
          <div className="access-inline">
            <Globe size={22} />
            <strong>{address.hostname}</strong>
          </div>
          {page === "external" ? (
            <>
              <span className="access-muted">{address.href}</span>
              <p className="onboarding-inline-note">
                注册页面预览 · 未打开网站
              </p>
              <div className="account-entry-actions">
                <Button
                  primary
                  disabled={locked}
                  onClick={() => update("returned")}
                >
                  <ArrowLeft size={15} />
                  返回 Farfold
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>继续登录，以确认账号授权。</p>
              <div className="account-entry-actions">
                <Button
                  primary
                  disabled={locked || loginDisabled}
                  onClick={onLogin}
                >
                  继续登录
                </Button>
                <Button disabled={locked} onClick={() => update("external")}>
                  重新打开注册页
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
