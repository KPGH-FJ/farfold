import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import {
  acceptManagedRuntimeInstallation,
  cancelManagedRuntimeInstallation,
  inspectManagedRuntimeInstallation,
  installManagedRuntime,
  listManagedRuntimeInstallations,
  managedRuntimeConnectionSelection,
  managedRuntimeInstallationCandidates,
  managedRuntimeInstallationStatus,
  type ManagedRuntimeCandidateInspection,
  type ManagedRuntimeCandidates,
  type ManagedRuntimeConnectionSelection,
  type ManagedRuntimeInstallationStatus,
  type ManagedRuntimeProduct,
  type ManagedRuntimeSavedInstallation,
} from "../runtime/managed-runtime-installation";
import { ProviderSettingsDialog } from "./ProviderSettingsDialog";

interface Props {
  runtime: ManagedRuntimeProduct;
  onSaved?: (connection: ManagedRuntimeConnectionSelection) => void;
  onClose: () => void;
}

function runtimeName(runtime: ManagedRuntimeProduct): string {
  if (runtime === "pi") return "Pi";
  if (runtime === "opencode_acp") return "OpenCode ACP";
  return "OpenCode";
}

export function ManagedRuntimeInstallationDialog({
  runtime,
  onSaved,
  onClose,
}: Props) {
  const [candidates, setCandidates] = useState<ManagedRuntimeCandidates | null>(
    null,
  );
  const [inspection, setInspection] =
    useState<ManagedRuntimeCandidateInspection | null>(null);
  const [saved, setSaved] = useState<ManagedRuntimeSavedInstallation[]>([]);
  const [installStatus, setInstallStatus] =
    useState<ManagedRuntimeInstallationStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    "detecting" | "checking" | "saving" | "installing" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);
  const name = runtimeName(runtime);
  const hostInstalling =
    installStatus?.phase === "running" || installStatus?.phase === "cancelling";
  const disabled = busy !== null || hostInstalling;

  async function detect() {
    const ticket = ++operation.current;
    setBusy("detecting");
    setError(null);
    setNotice(null);
    try {
      const [result, registered, status] = await Promise.all([
        managedRuntimeInstallationCandidates(runtime),
        listManagedRuntimeInstallations(runtime),
        managedRuntimeInstallationStatus(runtime),
      ]);
      if (ticket === operation.current) {
        setCandidates(result);
        setSaved(registered);
        setInstallStatus(status);
      }
    } catch (reason) {
      if (ticket === operation.current) setError(String(reason));
    } finally {
      if (ticket === operation.current) setBusy(null);
    }
  }

  async function inspect(
    path: string,
    source: ManagedRuntimeCandidateInspection["source"] = "manual",
  ) {
    const ticket = ++operation.current;
    setBusy("checking");
    setError(null);
    setNotice(null);
    setInspection(null);
    try {
      const result = await inspectManagedRuntimeInstallation(
        runtime,
        path,
        source,
      );
      if (ticket === operation.current) setInspection(result);
    } catch (reason) {
      if (ticket === operation.current) setError(String(reason));
    } finally {
      if (ticket === operation.current) setBusy(null);
    }
  }

  async function chooseFile() {
    const selected = await open({
      title: `选择本机 ${name} 程序`,
      directory: false,
      multiple: false,
    });
    if (typeof selected === "string") await inspect(selected);
  }

  async function saveInspection() {
    if (!inspection) return;
    const ticket = ++operation.current;
    setBusy("saving");
    setError(null);
    setNotice(null);
    try {
      const registered = await acceptManagedRuntimeInstallation(
        runtime,
        inspection.selectedPath,
        inspection.source,
      );
      const entries = await listManagedRuntimeInstallations(runtime);
      if (ticket === operation.current) {
        setSaved(entries);
        setInspection(null);
        onSaved?.(managedRuntimeConnectionSelection(registered));
        setNotice(
          `已登记 ${name} ${registered.inspection.observedVersion} 本机安装引用。当前不会替换正在运行的 Runtime。`,
        );
      }
    } catch (reason) {
      if (ticket === operation.current) setError(String(reason));
    } finally {
      if (ticket === operation.current) setBusy(null);
    }
  }

  function useSavedInstallation(entry: ManagedRuntimeSavedInstallation) {
    onSaved?.(managedRuntimeConnectionSelection(entry));
    setNotice(
      `已选择 ${name} ${entry.inspection.observedVersion} 本机安装；当前不会替换正在运行的 Runtime。`,
    );
  }

  async function installRuntime() {
    const ticket = ++operation.current;
    setBusy("installing");
    setError(null);
    setNotice(null);
    try {
      const installed = await installManagedRuntime(runtime);
      const [entries, status] = await Promise.all([
        listManagedRuntimeInstallations(runtime),
        managedRuntimeInstallationStatus(runtime),
      ]);
      if (ticket === operation.current) {
        setSaved(entries);
        setInstallStatus(status);
        setInspection(null);
        onSaved?.(managedRuntimeConnectionSelection(installed));
        setNotice(
          `已安装并登记 ${name} ${installed.inspection.observedVersion} 到 Farfold 管理目录。`,
        );
      }
    } catch (reason) {
      if (ticket === operation.current) {
        setError(String(reason));
        setInstallStatus(await managedRuntimeInstallationStatus(runtime));
      }
    } finally {
      if (ticket === operation.current) setBusy(null);
    }
  }

  async function cancelInstall() {
    setError(null);
    setNotice(null);
    try {
      const status = await cancelManagedRuntimeInstallation(runtime);
      setInstallStatus(status);
      if (status.phase === "idle") {
        setNotice("当前没有正在进行的 Runtime 安装。");
      } else {
        setNotice("已请求取消安装；Host 会停止下载并清理本次临时文件。");
      }
    } catch (reason) {
      setError(String(reason));
    }
  }

  useEffect(() => {
    void detect();
    return () => {
      ++operation.current;
    };
  }, [runtime]);

  useEffect(() => {
    if (busy !== "installing" && !hostInstalling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refreshProgress() {
      try {
        const status = await managedRuntimeInstallationStatus(runtime);
        if (!cancelled) setInstallStatus(status);
      } catch (reason) {
        if (!cancelled) setError(`安装状态暂时无法读取：${String(reason)}`);
      }
      if (!cancelled) timer = setTimeout(() => void refreshProgress(), 500);
    }
    void refreshProgress();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runtime, busy, hostInstalling]);

  return (
    <ProviderSettingsDialog
      runtimeName={name}
      title={`${name} 本机安装`}
      description="检查并登记本机 Runtime 安装，不会覆盖全局程序或改变已有会话的绑定。"
      closeLocked={false}
      refreshing={busy === "detecting"}
      refreshDisabled={disabled}
      onRefresh={() => void detect()}
      onClose={onClose}
    >
      <div className="codex-installation">
        <p className="codex-installation-note">
          OpenCode ACP 可按需安装到 Farfold
          管理目录；候选检查和手动登记不会安装、升级或覆盖全局程序。
        </p>
        {saved.length > 0 && (
          <section aria-label={`已登记的 ${name} 本机安装`}>
            <h3>已登记的安装</h3>
            {saved.map((entry) => (
              <div
                key={entry.installationId}
                className="codex-installation-result"
              >
                <p>{entry.inspection.canonicalPath}</p>
                <p>
                  {entry.inspection.displayName}{" "}
                  {entry.inspection.observedVersion} · SHA-256{" "}
                  {entry.inspection.artifactSha256.slice(0, 12)}…
                </p>
                <p>连接身份：{entry.connectionId}</p>
                {onSaved && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => useSavedInstallation(entry)}
                  >
                    使用此安装
                  </button>
                )}
              </div>
            ))}
          </section>
        )}
        {candidates?.paths.length ? (
          <section aria-label={`${name} 候选程序`}>
            <h3>发现的候选</h3>
            {candidates.paths.map((candidate) => (
              <div
                key={`${candidate.source}:${candidate.path}`}
                className="codex-installation-result"
              >
                <p>{candidate.path}</p>
                <p>来源：{candidate.source}</p>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void inspect(candidate.path, candidate.source)}
                >
                  检查
                </button>
              </div>
            ))}
          </section>
        ) : (
          <p>未发现候选，可手动选择程序文件。</p>
        )}
        {candidates?.warnings.map((warning) => (
          <p key={warning} className="settings-error">
            {warning}
          </p>
        ))}
        {notice && <p role="status">{notice}</p>}
        <button type="button" disabled={disabled} onClick={chooseFile}>
          选择程序…
        </button>
        {runtime === "opencode_acp" && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void installRuntime()}
          >
            安装到 Farfold 管理目录
          </button>
        )}
        {(busy === "installing" || hostInstalling) && (
          <button
            type="button"
            disabled={installStatus?.phase === "cancelling"}
            onClick={() => void cancelInstall()}
          >
            取消安装
          </button>
        )}
        {busy === "checking" && <p role="status">正在检查程序…</p>}
        {(busy === "installing" || hostInstalling) && (
          <p role="status">正在安装并校验固定 OpenCode ACP…</p>
        )}
        {inspection && (
          <div className="codex-installation-result">
            <h3>{inspection.displayName} 候选已检查</h3>
            <p>{inspection.selectedPath}</p>
            <p>
              版本 {inspection.observedVersion} · SHA-256{" "}
              {inspection.artifactSha256.slice(0, 12)}…
            </p>
            <p>
              安装身份：{inspection.runtime.installationId} · 来源：
              {inspection.source}
            </p>
            <p>
              {inspection.compatible
                ? "启动引用：已可生成；当前状态：已检查，尚未启用。"
                : `不兼容：需要 ${inspection.expectedVersion}。`}
            </p>
            {inspection.source !== "bundled" && inspection.compatible && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => void saveInspection()}
              >
                登记本机安装
              </button>
            )}
            {inspection.source === "bundled" && (
              <p>这是随包 Runtime，只用于校验当前包，不登记为本机系统安装。</p>
            )}
          </div>
        )}
        {error && <p className="settings-error">{error}</p>}
      </div>
    </ProviderSettingsDialog>
  );
}
