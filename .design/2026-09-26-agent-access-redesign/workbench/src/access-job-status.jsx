import React from "react";
import { CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { Button } from "./ui.jsx";
import {
  cancelAgentJob,
  confirmAgentJobStopped,
  continueAgentJob,
  checkAuthenticationJob,
  endAuthenticationJob,
  resolveAuthenticationJob,
} from "./access-jobs.js";
export default function AccessJobStatus({
  agent,
  onChange,
  onOpenTest,
  compact = false,
  onCancel,
  cancelLabel,
}) {
  const job = agent.accessJob;
  if (
    !job &&
    compact &&
    agent.lastAccessResult?.status === "passed" &&
    agent.lastAccessResult.type !== "test"
  )
    return null;
  if (!job)
    return agent.lastAccessResult ? (
      <p
        role="status"
        className={`access-result ${agent.lastAccessResult.status === "passed" ? "access-success" : "access-warning"}`}
      >
        {agent.lastAccessResult.message}
        {agent.lastAccessResult.type === "test" && onOpenTest && (
          <Button onClick={() => onOpenTest(agent.lastAccessResult.id)}>
            查看测试对话
          </Button>
        )}
      </p>
    ) : null;
  return (
    <div
      className={`access-job ${compact ? "access-job-compact" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div>
        {["unknown", "approval"].includes(job.status) ? (
          <WarningCircle size={19} />
        ) : (
          <CircleNotch size={19} className="spin" />
        )}
        <span>
          <strong>
            {job.type === "auth" &&
            job.status === "waiting" &&
            job.authMethod?.manual
              ? job.accountActionPurpose === "registration"
                ? "等待完成注册与登录"
                : "等待完成账号设置"
              : job.label}
          </strong>

          {job.waitNotice && <small>仍在等待登录结果。</small>}
          {job.status === "unknown" && job.resultCheckNotice && (
            <small>{job.resultCheckNotice}</small>
          )}
        </span>
      </div>
      <div className="access-inline">
        {job.type === "test" && onOpenTest && (
          <Button onClick={() => onOpenTest(job.id)}>查看测试对话</Button>
        )}
        {job.status === "approval" && job.type !== "test" && (
          <Button onClick={() => onChange(continueAgentJob(agent, job.id))}>
            允许继续
          </Button>
        )}
        {!["unknown", "cancelling"].includes(job.status) && (
          <Button onClick={onCancel || (() => onChange(cancelAgentJob(agent)))}>
            {cancelLabel ||
              (job.status === "approval" ? "拒绝并取消" : "取消操作")}
          </Button>
        )}
        {job.type === "auth" && job.status === "unknown" && (
          <>
            <Button
              onClick={() => onChange(checkAuthenticationJob(agent, job.id))}
            >
              检查登录结果
            </Button>
            <Button
              onClick={() => onChange(endAuthenticationJob(agent, job.id))}
            >
              结束此次登录
            </Button>
          </>
        )}
        {job.status === "unknown" && (
          <details>
            <summary>评审：模拟后续确认</summary>
            <Button
              onClick={() => onChange(confirmAgentJobStopped(agent, job.id))}
            >
              模拟收到结束确认
            </Button>
            {job.type === "auth" && (
              <Button
                onClick={() =>
                  onChange(resolveAuthenticationJob(agent, job.id))
                }
              >
                模拟收到迟到的登录完成结果
              </Button>
            )}
          </details>
        )}
        {job.type === "auth" && job.status === "waiting" && (
          <details>
            <summary>评审：长时间等待</summary>
            <Button
              onClick={() =>
                onChange({ ...agent, accessJob: { ...job, waitNotice: true } })
              }
            >
              模拟等待超过一分钟
            </Button>
          </details>
        )}
      </div>
    </div>
  );
}
