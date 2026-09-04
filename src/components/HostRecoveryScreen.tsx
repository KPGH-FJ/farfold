import { useState } from "react";
import appIconUrl from "../../assets/app-icon.svg";
import type {
  HostStorageBootstrap,
  HostStorageStatus,
} from "../runtime/host-storage";

interface HostRecoveryScreenProps {
  bootstrap: Exclude<HostStorageBootstrap, { phase: "ready" }>;
  onRetry: () => void;
  onReveal: (path: string) => Promise<void>;
}

function RecoveryFacts({ status }: { status: HostStorageStatus }) {
  return (
    <dl className="host-recovery-facts">
      <div>
        <dt>数据库</dt>
        <dd title={status.databasePath}>{status.databasePath}</dd>
      </div>
      <div>
        <dt>Schema</dt>
        <dd>{status.schemaVersion ?? "无法安全读取"}</dd>
      </div>
      <div>
        <dt>可用备份</dt>
        <dd title={status.backupPath ?? undefined}>
          {status.backupPath ?? "本次启动未生成迁移备份"}
        </dd>
      </div>
    </dl>
  );
}

export function HostRecoveryScreen({
  bootstrap,
  onRetry,
  onReveal,
}: HostRecoveryScreenProps) {
  const [revealError, setRevealError] = useState<string | null>(null);
  const status = bootstrap.phase === "recovery" ? bootstrap.status : null;
  const reason =
    bootstrap.phase === "unavailable"
      ? bootstrap.reason
      : status?.recoveryReason;

  async function reveal(path: string) {
    setRevealError(null);
    try {
      await onReveal(path);
    } catch (error) {
      setRevealError(String(error));
    }
  }

  return (
    <main className="host-recovery-shell">
      <section className="host-recovery-card" aria-label="Host 恢复模式">
        <img src={appIconUrl} alt="" />
        <span className="host-recovery-eyebrow">Farfold Host</span>
        <h1>
          {bootstrap.phase === "checking"
            ? "正在验证本地状态"
            : "已进入只读恢复模式"}
        </h1>
        <p className="host-recovery-summary">
          {bootstrap.phase === "checking"
            ? "在确认 Host 数据库可以安全使用之前，工作区与 Agent Runtime 不会启动。"
            : "工作区、Agent Runtime、新 Prompt、权限回复、删除和 LifeModel 注入均已阻断。现有数据不会被自动重置或覆盖。"}
        </p>
        {reason && <pre className="host-recovery-reason">{reason}</pre>}
        {status && <RecoveryFacts status={status} />}
        {revealError && (
          <p className="host-recovery-action-error" role="alert">
            {revealError}
          </p>
        )}
        {bootstrap.phase !== "checking" && (
          <div className="host-recovery-actions">
            <button type="button" onClick={onRetry}>
              重新读取诊断
            </button>
            {status && (
              <button
                type="button"
                onClick={() => void reveal(status.databasePath)}
              >
                在 Finder 中显示数据库
              </button>
            )}
            {status?.backupPath && (
              <button
                type="button"
                onClick={() => void reveal(status.backupPath!)}
              >
                在 Finder 中显示备份
              </button>
            )}
          </div>
        )}
        {bootstrap.phase !== "checking" && (
          <p className="host-recovery-note">
            当前切片只提供诊断与安全阻断；验证备份、显式恢复和重置会在后续恢复流程中提供，不会在此自动执行。
          </p>
        )}
      </section>
    </main>
  );
}
