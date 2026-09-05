import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  CheckCircle,
  DownloadSimple,
  ShieldCheck,
  Warning,
  X,
} from "@phosphor-icons/react";
import {
  activateManagedUpdate,
  cancelPreparedManagedUpdate,
  checkManagedUpdate,
  discardManagedUpdateRecovery,
  downloadManagedUpdate,
  getManagedUpdateRecoverySnapshot,
  getManagedUpdateSnapshot,
  prepareManagedUpdate,
  requestManagedUpdateRollback,
  type ManagedUpdateBlocker,
  type ManagedUpdateRecoverySnapshot,
  type ManagedUpdateSnapshot,
} from "../runtime/managed-update";

const blockerLabels: Record<ManagedUpdateBlocker, string> = {
  release_infrastructure_unconfigured: "当前构建没有配置发布端点与签名公钥",
  release_infrastructure_invalid: "当前构建的发布配置无效",
  host_storage_recovery: "Host 存储处于恢复模式",
  active_turns: "仍有 Agent Turn 正在运行",
  pending_interactions: "仍有 Runtime 权限或交互等待处理",
  pi_runtime_not_stopped: "Pi Runtime 尚未停止",
  open_code_runtime_not_stopped: "OpenCode Runtime 尚未停止",
  post_commit_recovery_retained: "当前版本的回滚点尚未接受或使用",
};

type UpdateAction =
  | "refresh"
  | "check"
  | "download"
  | "prepare"
  | "cancel"
  | "activate"
  | "rollback"
  | "discard";

interface UpdateDialogProps {
  onClose: () => void;
}

export function UpdateDialog({ onClose }: UpdateDialogProps) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState<ManagedUpdateSnapshot | null>(null);
  const [recovery, setRecovery] =
    useState<ManagedUpdateRecoverySnapshot | null>(null);
  const [busy, setBusy] = useState<UpdateAction | null>("refresh");
  const [error, setError] = useState<string | null>(null);
  const [rollbackConfirmation, setRollbackConfirmation] = useState("");
  const [discardConfirmation, setDiscardConfirmation] = useState("");

  async function refresh() {
    setBusy("refresh");
    setError(null);
    try {
      const [nextSnapshot, nextRecovery] = await Promise.all([
        getManagedUpdateSnapshot(),
        getManagedUpdateRecoverySnapshot(),
      ]);
      setSnapshot(nextSnapshot);
      setRecovery(nextRecovery);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    void refresh();
    requestAnimationFrame(() => closeButton.current?.focus());
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (!panel.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", trapFocus);
    return () => {
      window.removeEventListener("keydown", trapFocus);
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);

  async function runSnapshotAction(
    action: UpdateAction,
    operation: () => Promise<ManagedUpdateSnapshot>,
  ) {
    setBusy(action);
    setError(null);
    try {
      setSnapshot(await operation());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function activate() {
    const token = snapshot?.candidate?.candidateToken;
    if (!token) return;
    setBusy("activate");
    setError(null);
    try {
      await activateManagedUpdate(token);
    } catch (reason) {
      setError(String(reason));
      setBusy(null);
    }
  }

  async function rollback() {
    if (!recovery?.operationId) return;
    setBusy("rollback");
    setError(null);
    try {
      await requestManagedUpdateRollback(
        recovery.operationId,
        rollbackConfirmation,
      );
    } catch (reason) {
      setError(String(reason));
      setBusy(null);
    }
  }

  async function discard() {
    if (!recovery?.operationId) return;
    setBusy("discard");
    setError(null);
    try {
      const nextRecovery = await discardManagedUpdateRecovery(
        recovery.operationId,
        discardConfirmation,
      );
      const nextSnapshot = await getManagedUpdateSnapshot();
      setRecovery(nextRecovery);
      setSnapshot(nextSnapshot);
      setDiscardConfirmation("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  const candidate = snapshot?.candidate ?? null;
  const disabled = busy !== null;
  const configurationLabel = !snapshot
    ? "正在读取发布状态"
    : snapshot.configuration === "configured"
      ? "已配置签名发布通道"
      : snapshot.configuration === "invalid"
        ? "发布配置无效"
        : "发布通道未配置";

  return (
    <div
      className="settings-overlay update-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !disabled) onClose();
      }}
    >
      <section
        ref={panel}
        className="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !disabled) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header>
          <div>
            <span className="settings-eyebrow">Signed release · macOS</span>
            <h2 id="update-dialog-title">
              <ArrowClockwise size={20} /> Farfold 更新与恢复
            </h2>
            <p>更新、候选验证、回滚点和恢复授权都由同一个 Host 状态决定。</p>
          </div>
          <button
            ref={closeButton}
            className="settings-close"
            onClick={onClose}
            disabled={disabled}
            aria-label="关闭更新与恢复"
          >
            <X size={18} />
          </button>
        </header>

        <div className="update-dialog-body">
          <section className="update-status-card">
            <div className="update-card-heading">
              <div>
                <span>当前版本</span>
                <strong>{snapshot?.currentVersion ?? "读取中…"}</strong>
              </div>
              <span
                className={`update-configuration ${snapshot?.configuration ?? "loading"}`}
              >
                {configurationLabel}
              </span>
            </div>
            {snapshot?.blockers.length ? (
              <ul className="update-blockers">
                {snapshot.blockers.map((blocker) => (
                  <li key={blocker}>
                    <Warning size={14} /> {blockerLabels[blocker]}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="update-clear">
                <ShieldCheck size={15} /> 当前 Host 状态允许进入更新检查。
              </p>
            )}
            <div className="update-actions">
              <button onClick={() => void refresh()} disabled={disabled}>
                <ArrowClockwise size={15} /> 刷新状态
              </button>
              <button
                className="primary"
                onClick={() =>
                  void runSnapshotAction("check", checkManagedUpdate)
                }
                disabled={disabled || !snapshot?.checkEnabled}
              >
                检查更新
              </button>
            </div>
          </section>

          {candidate && (
            <section className="update-candidate-card">
              <div className="update-card-heading">
                <div>
                  <span>候选更新</span>
                  <strong>
                    {candidate.currentVersion} → {candidate.version}
                  </strong>
                </div>
                <span className="update-target">{candidate.target}</span>
              </div>
              {candidate.notes && (
                <p className="update-notes">{candidate.notes}</p>
              )}
              <ol className="update-verification-steps">
                <VerificationStep label="更新信息已获取" complete />
                <VerificationStep
                  label="制品签名与边界"
                  complete={candidate.artifactVerified}
                />
                <VerificationStep
                  label="Bundle、Runtime 与清单"
                  complete={candidate.bundlePreflightVerified}
                />
                <VerificationStep
                  label="隔离 Host / Runtime smoke"
                  complete={candidate.sideBySideSmokeVerified}
                />
                <VerificationStep
                  label="回滚单元"
                  complete={candidate.activationRecoveryPrepared}
                />
              </ol>
              {candidate.candidateHostSchemaVersion !== null && (
                <p className="update-candidate-fact">
                  候选 Host schema v{candidate.candidateHostSchemaVersion} ·
                  executable{" "}
                  {candidate.candidateMainExecutableSha256?.slice(0, 12)}…
                </p>
              )}
              <div className="update-actions">
                {!candidate.artifactVerified && (
                  <button
                    className="primary"
                    onClick={() =>
                      void runSnapshotAction("download", () =>
                        downloadManagedUpdate(candidate.candidateToken),
                      )
                    }
                    disabled={disabled || !snapshot?.downloadEnabled}
                  >
                    <DownloadSimple size={15} /> 下载并验证
                  </button>
                )}
                {candidate.sideBySideSmokeVerified &&
                  !candidate.activationRecoveryPrepared && (
                    <button
                      className="primary"
                      onClick={() =>
                        void runSnapshotAction("prepare", () =>
                          prepareManagedUpdate(candidate.candidateToken),
                        )
                      }
                      disabled={disabled || !snapshot?.prepareActivationEnabled}
                    >
                      准备回滚单元
                    </button>
                  )}
                {candidate.activationRecoveryPrepared && (
                  <>
                    <button
                      onClick={() =>
                        void runSnapshotAction("cancel", () =>
                          cancelPreparedManagedUpdate(candidate.candidateToken),
                        )
                      }
                      disabled={
                        disabled || !snapshot?.cancelPreparedActivationEnabled
                      }
                    >
                      取消准备
                    </button>
                    <button
                      className="primary"
                      onClick={() => void activate()}
                      disabled={disabled || !snapshot?.activateEnabled}
                    >
                      激活并重启
                    </button>
                  </>
                )}
              </div>
            </section>
          )}

          {recovery?.rollbackAvailable && recovery.operationId && (
            <section className="update-recovery-card">
              <div className="update-card-heading">
                <div>
                  <span>已保留回滚点</span>
                  <strong>
                    {recovery.toVersion} → {recovery.fromVersion}
                  </strong>
                </div>
                <ShieldCheck size={20} />
              </div>
              <p>
                回滚会在冷启动恢复更新前的 Host
                快照，并把当前数据库完整保留为失败版本归档。
                接受当前版本会永久删除这一个恢复点，并解除下一次更新阻塞。
              </p>
              <label>
                输入 <code>{recovery.requiredConfirmation}</code> 请求回滚
                <input
                  value={rollbackConfirmation}
                  onChange={(event) =>
                    setRollbackConfirmation(event.target.value)
                  }
                  disabled={disabled}
                  spellCheck={false}
                />
              </label>
              <button
                className="danger"
                onClick={() => void rollback()}
                disabled={
                  disabled ||
                  rollbackConfirmation !== recovery.requiredConfirmation
                }
              >
                回滚并重启
              </button>
              <label>
                输入 <code>{recovery.requiredDiscardConfirmation}</code>{" "}
                接受当前版本
                <input
                  value={discardConfirmation}
                  onChange={(event) =>
                    setDiscardConfirmation(event.target.value)
                  }
                  disabled={disabled}
                  spellCheck={false}
                />
              </label>
              <button
                onClick={() => void discard()}
                disabled={
                  disabled ||
                  !recovery.discardEnabled ||
                  discardConfirmation !== recovery.requiredDiscardConfirmation
                }
              >
                接受当前版本并删除回滚点
              </button>
            </section>
          )}

          {busy && (
            <p className="update-progress">正在执行：{actionLabel(busy)}</p>
          )}
          {error && (
            <p className="update-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function VerificationStep({
  label,
  complete,
}: {
  label: string;
  complete: boolean;
}) {
  return (
    <li className={complete ? "complete" : "pending"}>
      <CheckCircle size={15} weight={complete ? "fill" : "regular"} />
      {label}
    </li>
  );
}

function actionLabel(action: UpdateAction) {
  return {
    refresh: "读取状态",
    check: "检查签名元数据",
    download: "下载并验证候选",
    prepare: "创建回滚单元",
    cancel: "取消回滚准备",
    activate: "交换应用并重启",
    rollback: "安排冷启动回滚",
    discard: "删除已授权恢复点",
  }[action];
}
