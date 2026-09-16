import { useEffect, useState } from "react";
import { ArrowsLeftRight, HardDrives, Power } from "@phosphor-icons/react";
import type {
  ManagedRuntimeConnectionSelection,
  ManagedRuntimeProduct,
} from "../runtime/managed-runtime-installation";
import {
  inspectRuntimeCapabilities,
  runtimeCapabilityRows,
  runtimeRetentionRows,
  type RuntimeAuthoritySnapshot,
} from "../runtime/runtime-capability";
import { ManagedRuntimeInstallationDialog } from "./ManagedRuntimeInstallationDialog";
import type { OpenCodeAcpStatus } from "../runtime/opencode-acp";

export type RuntimeProduct = "pi" | "opencode" | "codex";

interface RuntimeChooserProps {
  value: RuntimeProduct;
  disabled: boolean;
  running: boolean;
  providerStatus: string;
  lifeModelEnabled: boolean;
  onChange: (runtime: RuntimeProduct) => void;
  onDisconnect?: () => void;
  disconnectDisabled?: boolean;
  usesOpenCodeAcp?: boolean;
  acpStatus?: OpenCodeAcpStatus | null;
  onManagedRuntimeConnection?: (
    connection: ManagedRuntimeConnectionSelection,
  ) => void;
}

export function RuntimeChooser({
  value,
  disabled,
  running,
  providerStatus,
  lifeModelEnabled,
  onChange,
  onDisconnect,
  disconnectDisabled = false,
  usesOpenCodeAcp = false,
  acpStatus,
  onManagedRuntimeConnection,
}: RuntimeChooserProps) {
  const [snapshot, setSnapshot] = useState<RuntimeAuthoritySnapshot | null>(
    null,
  );
  const [installationOpen, setInstallationOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    if (value === "codex" || usesOpenCodeAcp) return;
    void inspectRuntimeCapabilities(value)
      .then((result) => {
        if (!cancelled) setSnapshot(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [value, running, lifeModelEnabled, usesOpenCodeAcp]);
  const current = snapshot?.runtime.productId === value ? snapshot : null;
  const installationRuntime: ManagedRuntimeProduct =
    value === "opencode" ? "opencode_acp" : "pi";
  const rows = usesOpenCodeAcp
    ? acpStatus?.running
      ? [
          `${acpStatus.agentName ?? "OpenCode"} ${acpStatus.agentVersion ?? "版本未返回"}`,
          `ACP ${acpStatus.protocolVersion ?? "未确认"}`,
          `原生提问：${acpStatus.questionBridge ? "已协商" : "未协商"}`,
          `历史加载：${acpStatus.loadSession ? "已协商" : "未协商"}`,
          "LifeModel 来源与使用：未接入",
        ]
      : ["OpenCode ACP · 尚未连接", "LifeModel 来源与使用：未接入"]
    : value === "codex"
      ? ["原生文本与文件任务", "LifeModel 来源与使用：未接入"]
      : runtimeCapabilityRows(current);
  const retentionRows = usesOpenCodeAcp
    ? []
    : runtimeRetentionRows(value, current);
  return (
    <div className="runtime-chooser">
      <label>
        <ArrowsLeftRight size={13} aria-hidden="true" />
        <span className="sr-only">Agent Runtime</span>
        <select
          value={value}
          disabled={disabled}
          data-codex-installation-trigger
          onChange={(event) => {
            const selected = event.target.value;
            if (
              selected === "pi" ||
              selected === "opencode" ||
              selected === "codex"
            )
              onChange(selected);
          }}
          aria-label="选择 Agent Runtime"
        >
          <option value="pi">Pi</option>
          <option value="opencode">OpenCode</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      {value !== "codex" && (
        <button
          type="button"
          className="runtime-installation-button"
          disabled={disabled || running}
          title={
            running
              ? "请先停止当前 Runtime，再检查本机安装"
              : "检查本机 Runtime 安装"
          }
          onClick={() => setInstallationOpen(true)}
        >
          <HardDrives size={14} aria-hidden="true" />
          本机安装
        </button>
      )}
      {running && onDisconnect && (
        <button
          type="button"
          className="runtime-installation-button"
          disabled={disabled || disconnectDisabled}
          aria-label={`断开 ${value === "opencode" ? "OpenCode" : value} 连接`}
          title="断开空闲 Runtime 连接"
          onClick={onDisconnect}
        >
          <Power size={14} aria-hidden="true" />
        </button>
      )}
      <div
        className="runtime-capabilities"
        role="status"
        aria-label="Runtime 状态"
      >
        {error ? (
          <span className="unverified" title={error}>
            运行组件检查失败
          </span>
        ) : (
          rows.map((row) => <span key={row}>{row}</span>)
        )}
        {retentionRows.slice(0, 3).map((row) => (
          <span key={row}>{row}</span>
        ))}
        <span>{running ? "进程已运行" : "进程未运行"}</span>
        <span>模型请求：{providerStatus}</span>
        <span>LifeModel：{lifeModelEnabled ? "已启用" : "已关闭"}</span>
      </div>
      {installationOpen && value !== "codex" && (
        <ManagedRuntimeInstallationDialog
          runtime={installationRuntime}
          onSaved={onManagedRuntimeConnection}
          onClose={() => setInstallationOpen(false)}
        />
      )}
    </div>
  );
}
