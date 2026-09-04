import { useState } from "react";
import type { HostStorageActivationStatus } from "../runtime/host-storage";

interface HostActivationNoticeProps {
  status: HostStorageActivationStatus;
  onReveal: (path: string) => Promise<void>;
}

export function HostActivationNotice({
  status,
  onReveal,
}: HostActivationNoticeProps) {
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (dismissed || status.phase === "idle") return null;

  const reset = status.phase === "reset";
  const restored = status.phase === "activated";
  const passed = restored || reset;
  const sourcePath =
    status.recoverySourceArchivePath ?? status.rollbackPath ?? null;
  const title = reset
    ? "Host 已显式重置"
    : restored
      ? status.recoverySourceArchivePath
        ? "恢复已验证并激活"
        : "导入已验证并激活"
      : status.phase === "rolled_back"
        ? "候选未通过，已回到原状态"
        : "候选已拒绝";

  async function reveal() {
    if (!sourcePath) return;
    setError(null);
    try {
      await onReveal(sourcePath);
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <aside
      className={`host-activation-notice ${passed ? "passed" : "warning"}`}
      aria-label="Host 激活结果"
    >
      <div>
        <strong>{title}</strong>
        <span>
          {status.reason ??
            (reset
              ? "已创建空的 Host 状态；原异常数据库已保留。项目文件、Provider 凭据和 Runtime 原生历史未被删除。"
              : status.recoverySourceArchivePath
                ? "原恢复数据库已保留；当前工作区来自所选可移植备份。"
                : "当前工作区已切换到所选可移植备份。")}
        </span>
        {error && <small role="alert">{error}</small>}
      </div>
      {sourcePath && (
        <button type="button" onClick={() => void reveal()}>
          在 Finder 中显示保留文件
        </button>
      )}
      <button type="button" onClick={() => setDismissed(true)}>
        知道了
      </button>
    </aside>
  );
}
