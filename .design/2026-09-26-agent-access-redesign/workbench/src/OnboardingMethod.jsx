import React from "react";
import { ComputerTower, Key, Plugs, CheckCircle } from "@phosphor-icons/react";
import { agentServiceFormats } from "./service-access.js";
import { accountCapabilities } from "./account-capabilities.js";

export default function OnboardingMethod({ agent, value, onChange }) {
  const routes = accountCapabilities(agent).routes;
  const options = [
    {
      id: "existing",
      title: "沿用这台电脑上的设置",
      description: "使用 Agent 已有的账号或模型服务",
      Icon: ComputerTower,
    },
    {
      id: "account",
      title: routes.some((route) => route.purpose === "service")
        ? "设置账号与模型服务"
        : "登录账号",
      description: "在 Agent 提供的流程中登录，或先创建账号",
      Icon: Key,
    },
    ...(agentServiceFormats(agent).length
      ? [
          {
            id: "api",
            title: "使用 API 配置",
            description: "选择已保存的服务，或添加一个新服务",
            Icon: Plugs,
          },
        ]
      : []),
  ];
  return (
    <>
      <div className="onboarding-heading">
        <h3>你想如何使用 {agent.name}？</h3>
        <p>已经在这台电脑上配置过，可以直接沿用。</p>
      </div>
      <div
        className="onboarding-options"
        role="group"
        aria-label="选择使用方式"
      >
        {options.map(({ id, title, description, Icon }) => (
          <button
            className="onboarding-option"
            type="button"
            key={id}
            aria-pressed={value === id}
            onClick={() => onChange(id)}
          >
            <Icon size={22} />
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            {value === id && <CheckCircle size={20} />}
          </button>
        ))}
      </div>
    </>
  );
}
