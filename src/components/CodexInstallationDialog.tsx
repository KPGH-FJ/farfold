import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  findCodexCandidates,
  listCodexInstallations,
  acceptCodexInstallation,
  recheckCodexInstallation,
  type SavedCodexInstallation,
  inspectCodexInstallation,
  type CodexCandidates,
  type CodexInstallationInspection,
} from "../runtime/codex-installation";
import { CodexConnectionPanel } from "./CodexConnectionPanel";
import { ProviderSettingsDialog } from "./ProviderSettingsDialog";

export function CodexInstallationDialog({ onClose }: { onClose: () => void }) {
  const [candidates, setCandidates] = useState<CodexCandidates | null>(null);
  const [inspection, setInspection] =
    useState<CodexInstallationInspection | null>(null);
  const [saved, setSaved] = useState<SavedCodexInstallation[]>([]);
  const [connectedInstallation, setConnectedInstallation] = useState<
    string | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"detecting" | "checking" | "saving" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);

  async function detect() {
    const ticket = ++operation.current;
    setBusy("detecting");
    setError(null);
    setNotice(null);
    try {
      const [result, registered] = await Promise.all([
        findCodexCandidates(),
        listCodexInstallations(),
      ]);
      if (ticket === operation.current) {
        setCandidates(result);
        setSaved(registered);
      }
    } catch (reason) {
      if (ticket === operation.current) setError(String(reason));
    } finally {
      if (ticket === operation.current) setBusy(null);
    }
  }

  async function inspect(path: string) {
    const ticket = ++operation.current;
    setBusy("checking");
    setInspection(null);
    setError(null);
    setNotice(null);
    try {
      const result = await inspectCodexInstallation(path);
      if (ticket === operation.current) setInspection(result);
    } catch (reason) {
      if (ticket === operation.current) setError(String(reason));
    } finally {
      if (ticket === operation.current) setBusy(null);
    }
  }

  async function chooseFile() {
    const ticket = ++operation.current;
    setBusy("checking");
    setError(null);
    try {
      const selected = await open({
        title: "选择已安装的 Codex 0.143.0 程序或 npm 入口",
        directory: false,
        multiple: false,
      });
      if (ticket === operation.current && typeof selected === "string")
        await inspect(selected);
    } catch (reason) {
      if (ticket === operation.current) setError(String(reason));
    } finally {
      if (ticket === operation.current) setBusy(null);
    }
  }

  async function saveInspection() {
    if (!inspection) return;
    const ticket = ++operation.current;
    setBusy("saving");
    setError(null);
    setNotice(null);
    try {
      const registered = await acceptCodexInstallation(inspection);
      const entries = await listCodexInstallations();
      if (ticket === operation.current) {
        setSaved(entries);
        setInspection(null);
        setNotice(
          `已登记 Codex ${registered.inspection.version} 程序。可连接专属环境配置账号；任务接入仍在开发中。`,
        );
      }
    } catch (reason) {
      if (ticket === operation.current) setError(String(reason));
    } finally {
      if (ticket === operation.current) setBusy(null);
    }
  }

  async function recheck(entry: SavedCodexInstallation, relocate: boolean) {
    const ticket = ++operation.current;
    setBusy("checking");
    setError(null);
    setNotice(null);
    try {
      let path: string | undefined;
      if (relocate) {
        const selected = await open({
          title: "重新定位同一 Codex 安装（构建摘要必须一致）",
          directory: false,
          multiple: false,
        });
        if (ticket !== operation.current || typeof selected !== "string")
          return;
        path = selected;
      }
      const checked = await recheckCodexInstallation(
        entry.installationId,
        path,
      );
      if (ticket === operation.current) {
        setSaved((current) =>
          current.map((item) =>
            item.installationId === checked.installationId ? checked : item,
          ),
        );
        setNotice(
          relocate
            ? "程序已重新定位，原安装身份保留。"
            : "当前程序与已登记的构建一致。账号和任务能力尚未验收。",
        );
      }
    } catch (reason) {
      if (ticket === operation.current) setError(String(reason));
    } finally {
      if (ticket === operation.current) setBusy(null);
    }
  }

  useEffect(() => {
    void detect();
    return () => {
      ++operation.current;
    };
  }, []);

  return (
    <ProviderSettingsDialog
      runtimeName="Codex"
      title="Codex 程序与账号"
      returnFocusSelector="[data-codex-installation-trigger]"
      description="使用你安装的官方 Codex CLI 0.143.0。Farfold 不会安装或升级该程序。"
      closeLocked={busy === "saving"}
      onClose={onClose}
      onRefresh={() => void detect()}
      refreshing={busy === "detecting"}
      refreshDisabled={busy !== null}
    >
      <div className="codex-installation">
        <p className="codex-installation-note">
          工作台支持文本与文件任务、原生审批、Plan 提问、转向和续接。
          冷启动历史以官方接口返回为准，部分命令详情可能无法恢复。
        </p>
        {saved.length > 0 && (
          <CodexConnectionPanel
            installations={saved}
            onConnectionChange={setConnectedInstallation}
          />
        )}
        {saved.length > 0 && (
          <section aria-label="已登记的 Codex 程序">
            <h3>已登记的程序</h3>
            <p>
              以下是保存的安装引用；重新核验后才能确认当前文件是否仍然匹配。
            </p>
            {saved.map((entry) => (
              <div
                key={entry.installationId}
                className="codex-installation-result"
              >
                <p>{entry.inspection.selectedPath}</p>
                <p>
                  Codex {entry.inspection.version} · 上次核验{" "}
                  {new Date(entry.inspection.verifiedAt).toLocaleString()}
                </p>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void recheck(entry, false)}
                >
                  重新核验
                </button>
                <button
                  type="button"
                  disabled={
                    busy !== null ||
                    connectedInstallation === entry.installationId
                  }
                  title={
                    connectedInstallation === entry.installationId
                      ? "请先停止此连接，再重新定位程序"
                      : undefined
                  }
                  onClick={() => void recheck(entry, true)}
                >
                  重新定位…
                </button>
              </div>
            ))}
          </section>
        )}
        {notice && <p role="status">{notice}</p>}
        <div role="status" aria-live="polite">
          {busy === "detecting"
            ? "正在检测常用安装位置…"
            : busy === "checking"
              ? "正在校验所选程序…"
              : busy === "saving"
                ? "正在重新核验并登记程序…"
                : candidates?.paths.length
                  ? "请选择要使用的安装。"
                  : "未检测到程序，可手动选择安装文件。"}
        </div>
        <div className="codex-installation-candidates">
          {candidates?.paths.map((path) => (
            <button
              type="button"
              key={path}
              onClick={() => void inspect(path)}
              disabled={busy !== null}
            >
              {path}
            </button>
          ))}
        </div>
        {candidates?.warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
        <button
          type="button"
          onClick={() => void chooseFile()}
          disabled={busy !== null}
        >
          选择文件…
        </button>
        {error && (
          <p role="alert" className="codex-installation-error">
            {error}
          </p>
        )}
        {inspection && (
          <section
            className="codex-installation-result"
            aria-label="Codex 程序检查结果"
          >
            <h3>Codex {inspection.version} 程序检查通过</h3>
            <p>已核对官方构建摘要和实际版本。账号连接与任务能力尚未验收。</p>
            <p>{inspection.selectedPath}</p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void saveInspection()}
            >
              登记此程序
            </button>
            <details>
              <summary>程序详情</summary>
              <dl>
                <dt>启动方式</dt>
                <dd>
                  {inspection.launch.kind === "npm"
                    ? "npm · 显式 Node 解释器"
                    : "原生程序"}
                </dd>
                <dt>原生程序</dt>
                <dd>{inspection.launch.executable.path}</dd>
                <dt>SHA-256</dt>
                <dd>{inspection.launch.executable.sha256}</dd>
                {inspection.launch.kind === "npm" && (
                  <>
                    <dt>Node 解释器</dt>
                    <dd>{inspection.launch.interpreter.path}</dd>
                  </>
                )}
                <dt>附属文件</dt>
                <dd>{inspection.resources.length} 个已校验</dd>
              </dl>
            </details>
          </section>
        )}
      </div>
    </ProviderSettingsDialog>
  );
}
