import React from "react";
import { ArrowLeft, Check, Robot } from "@phosphor-icons/react";
import { Button, Modal } from "./ui.jsx";
import "./onboarding.css";

const STAGES = ["程序", "账号与服务", "模型与确认"];

export default function OnboardingLayout({
  agent,
  step,
  intent,
  children,
  onBack,
  onNavigate,
  programReady = false,
  onClose,
  onNext,
  nextLabel,
  nextDisabled,
  showNext = true,
  busy = false,
}) {
  const current = step === "program" ? 0 : step === "review" ? 2 : 1;
  return (
    <Modal
      className="agent-redesign-modal"
      wide
      title={`接入 ${agent.name}`}
      titleContent={
        <span className="onboarding-title">
          {agent.icon ? (
            <img src={agent.icon} width={28} height={28} alt="" />
          ) : (
            <Robot size={28} aria-hidden="true" />
          )}
          <span>接入 {agent.name}</span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {!busy && onBack && (
            <Button kind="ghost" onClick={onBack}>
              <ArrowLeft size={15} aria-hidden="true" />
              上一步
            </Button>
          )}
          <div className="onboarding-footer-actions">
            <Button kind="ghost" onClick={onClose}>
              {busy ? "暂离并保留进度" : "暂时返回"}
            </Button>
            {!busy && showNext && nextLabel && (
              <Button primary disabled={nextDisabled} onClick={onNext}>
                {nextLabel}
              </Button>
            )}
          </div>
        </>
      }
    >
      <div className="onboarding-layout" data-intent={intent}>
        <ol className="onboarding-progress" aria-label="接入进度">
          {STAGES.map((label, index) => (
            <li
              key={label}
              className={index < current ? "complete" : ""}
              aria-current={index === current ? "step" : undefined}
            >
              <span className="onboarding-progress-mark" aria-hidden="true">
                {index < current ? <Check size={13} /> : index + 1}
              </span>
              {onNavigate ? (
                <button
                  type="button"
                  disabled={busy || (index > 0 && !programReady)}
                  aria-current={index === current ? "step" : undefined}
                  onClick={() =>
                    onNavigate(["program", "account", "model"][index])
                  }
                >
                  {label}
                </button>
              ) : (
                <span>{label}</span>
              )}
            </li>
          ))}
        </ol>
        <p className="agent-demo-banner">
          演示接入流程 · 不安装程序、不登录真实账号、不发送请求
        </p>
        <div className="onboarding-content">{children}</div>
      </div>
    </Modal>
  );
}
