import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import appIconUrl from "../../assets/app-icon.svg";
import {
  previewPortableImport,
  requestRecoveryRestore,
  type PortableImportPreview,
  type RequestedRecoveryRestore,
} from "../runtime/host-storage";
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
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restorePreview, setRestorePreview] =
    useState<PortableImportPreview | null>(null);
  const [restoreRequest, setRestoreRequest] =
    useState<RequestedRecoveryRestore | null>(null);
  const status = bootstrap.phase === "recovery" ? bootstrap.status : null;
  const activation =
    bootstrap.phase === "recovery" ? bootstrap.activation : null;
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

  async function chooseRestoreSource() {
    setRestoreError(null);
    setRestoreRequest(null);
    try {
      const selected = await open({
        title: "选择 Farfold 可移植备份",
        multiple: false,
        directory: false,
        filters: [{ name: "Farfold 可移植备份", extensions: ["sqlite3"] }],
      });
      if (typeof selected !== "string") return;
      setRestoreBusy(true);
      const preview = await previewPortableImport(selected);
      if (!preview.compatible) {
        throw new Error("该备份与当前 Farfold 版本不兼容。");
      }
      setRestorePreview(preview);
    } catch (error) {
      setRestorePreview(null);
      setRestoreError(String(error));
    } finally {
      setRestoreBusy(false);
    }
  }

  async function confirmRestore() {
    if (!restorePreview || restoreBusy) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      setRestoreRequest(await requestRecoveryRestore(restorePreview));
    } catch (error) {
      setRestoreError(String(error));
    } finally {
      setRestoreBusy(false);
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
            : bootstrap.phase === "unavailable"
              ? "无法验证 Host 状态"
              : "已进入只读恢复模式"}
        </h1>
        <p className="host-recovery-summary">
          {bootstrap.phase === "checking"
            ? "在确认 Host 数据库可以安全使用之前，工作区与 Agent Runtime 不会启动。"
            : bootstrap.phase === "unavailable"
              ? "Host 状态与激活结果不可验证。工作区和 Agent Runtime 保持关闭，请重新读取诊断或完整重启 Farfold。"
              : "工作区、Agent Runtime、新 Prompt、权限回复、删除和 LifeModel 注入均已阻断。现有数据不会被自动重置或覆盖。"}
        </p>
        {reason && <pre className="host-recovery-reason">{reason}</pre>}
        {activation && activation.phase !== "idle" && (
          <div className="host-recovery-activation-result" role="status">
            <strong>
              {activation.phase === "rolled_back"
                ? "恢复候选未通过，原数据库已回到原位"
                : activation.phase === "rejected"
                  ? "恢复请求已拒绝"
                  : "恢复候选已激活，但 Host 仍需恢复"}
            </strong>
            {activation.reason && <span>{activation.reason}</span>}
          </div>
        )}
        {status && <RecoveryFacts status={status} />}
        {status && (
          <section className="host-recovery-restore" aria-label="显式恢复">
            <div>
              <strong>从可移植备份恢复</strong>
              <span>
                先验证备份内容与
                SHA-256，再单独确认。恢复只会在下次冷启动执行，当前异常数据库会保留为
                recovery-source archive。
              </span>
            </div>
            {!restoreRequest && (
              <button
                type="button"
                disabled={restoreBusy}
                onClick={() => void chooseRestoreSource()}
              >
                {restoreBusy && !restorePreview ? "正在验证…" : "选择备份"}
              </button>
            )}
            {restorePreview && !restoreRequest && (
              <div className="host-recovery-restore-preview">
                <dl>
                  <div>
                    <dt>文件</dt>
                    <dd title={restorePreview.path}>{restorePreview.path}</dd>
                  </div>
                  <div>
                    <dt>Host schema</dt>
                    <dd>{restorePreview.hostSchemaVersion}</dd>
                  </div>
                  <div>
                    <dt>内容</dt>
                    <dd>
                      {restorePreview.contents.sessionCount} 个 Session ·{" "}
                      {restorePreview.contents.workingCopyCount} 个 Working Copy
                      · LifeModel{" "}
                      {restorePreview.policy.includesLifeModel
                        ? "包含"
                        : "不包含"}
                    </dd>
                  </div>
                  <div>
                    <dt>SHA-256</dt>
                    <dd title={restorePreview.sha256}>
                      {restorePreview.sha256}
                    </dd>
                  </div>
                </dl>
                <button
                  type="button"
                  className="primary"
                  disabled={restoreBusy}
                  onClick={() => void confirmRestore()}
                >
                  {restoreBusy ? "正在安排…" : "安排恢复并保留当前数据库"}
                </button>
              </div>
            )}
            {restoreRequest && (
              <div className="host-recovery-restore-ready" role="status">
                <strong>恢复已安全暂存</strong>
                <span>
                  请完整退出并重新打开
                  Farfold。冷启动验证成功后才会激活；失败则返回当前恢复状态。
                </span>
                <code title={restoreRequest.activation.stagedPath}>
                  {restoreRequest.activation.sha256}
                </code>
              </div>
            )}
            {restoreError && (
              <p className="host-recovery-action-error" role="alert">
                {restoreError}
              </p>
            )}
          </section>
        )}
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
            恢复不会导入 Provider 凭据或 Runtime
            原生历史。显式重置仍未开放；Farfold
            不会为通过启动检查而自动删除数据。
          </p>
        )}
      </section>
    </main>
  );
}
