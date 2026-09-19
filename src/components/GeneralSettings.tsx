/**
 * 设置 · 通用（F-settings-general）：外观 / 自动归档 / 更新 / 诊断 / 版本。
 * 低频默认统一收在这里；会话侧零配置入口。
 */
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { STRINGS } from "../runtime/strings";
import { threads } from "../runtime/sessions";
import type { ThemeMode } from "../runtime/theme";
import { UpdateDialog } from "./UpdateDialog";

interface GeneralSettingsProps {
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
}

export function GeneralSettings({
  themeMode,
  onThemeMode,
}: GeneralSettingsProps) {
  const [version, setVersion] = useState<string>("…");
  const [updateOpen, setUpdateOpen] = useState(false);
  const [archiveDays, setArchiveDays] = useState<number | null>(null);
  const [diagnostics, setDiagnostics] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "done"; path: string }
    | { kind: "error"; error: string }
  >({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => {
        if (!cancelled) setVersion("");
      });
    void invoke<unknown>("settings_get", { key: "autoArchiveDays" })
      .then((value) => {
        if (!cancelled) {
          setArchiveDays(typeof value === "number" ? value : 30);
        }
      })
      .catch(() => {
        if (!cancelled) setArchiveDays(30);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setDays = (days: number) => {
    const clean = Number.isFinite(days) && days >= 0 ? Math.floor(days) : 0;
    setArchiveDays(clean);
    void invoke("settings_set", { key: "autoArchiveDays", value: clean })
      .then(() => threads.refreshIndex())
      .catch(() => {});
  };

  const exportDiagnostics = async () => {
    setDiagnostics({ kind: "busy" });
    try {
      const path = await invoke<string>("export_diagnostics");
      setDiagnostics({ kind: "done", path });
    } catch (error) {
      setDiagnostics({ kind: "error", error: String(error) });
    }
  };

  const appearanceChoice = themeMode === "light" ? "paper" : "system";

  return (
    <>
      <div className="s-h">{STRINGS.general.heading}</div>
      <div className="s-sub">{STRINGS.general.sub}</div>

      <div className="gen-row">
        <div>
          {STRINGS.general.appearance}
          <div className="gd">{STRINGS.general.appearanceDesc}</div>
        </div>
        <div className="gen-choices" role="radiogroup">
          <label className="gen-choice">
            <input
              type="radio"
              name="appearance"
              checked={appearanceChoice === "paper"}
              onChange={() => onThemeMode("light")}
            />
            {STRINGS.general.appearancePaper}
          </label>
          <label className="gen-choice">
            <input
              type="radio"
              name="appearance"
              checked={appearanceChoice === "system"}
              onChange={() => onThemeMode("system")}
            />
            {STRINGS.general.appearanceSystem}
          </label>
        </div>
      </div>

      <div className="gen-row">
        <div>
          {STRINGS.general.autoArchive}
          <div className="gd">{STRINGS.general.autoArchiveDesc}</div>
        </div>
        <div className="gen-choices">
          <input
            type="number"
            min={0}
            className="gen-num"
            value={archiveDays ?? ""}
            onChange={(e) => setDays(Number(e.target.value))}
          />
          <span className="gv">{STRINGS.general.autoArchiveUnit}</span>
        </div>
      </div>

      <div className="gen-row">
        <div>
          {STRINGS.general.update}
          <div className="gd">{STRINGS.general.updateDesc}</div>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setUpdateOpen(true)}
        >
          {STRINGS.general.checkUpdate}
        </button>
      </div>

      <div className="gen-row">
        <div>
          {STRINGS.general.diagnostics}
          <div className="gd">{STRINGS.general.diagnosticsDesc}</div>
          {diagnostics.kind === "done" && (
            <div className="gd">
              {STRINGS.general.diagnosticsDone(diagnostics.path)}
            </div>
          )}
          {diagnostics.kind === "error" && (
            <div className="gd">
              {STRINGS.general.diagnosticsFailed}：{diagnostics.error}
            </div>
          )}
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={diagnostics.kind === "busy"}
          onClick={() => void exportDiagnostics()}
        >
          {diagnostics.kind === "busy"
            ? STRINGS.general.exportingDiagnostics
            : STRINGS.general.exportDiagnostics}
        </button>
      </div>

      <div className="gen-row">
        <div>{STRINGS.general.version}</div>
        <div className="gv">{version || "—"}</div>
      </div>

      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
    </>
  );
}
