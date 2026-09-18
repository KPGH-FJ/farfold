import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { STRINGS } from "../runtime/strings";
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

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => {
        if (!cancelled) setVersion("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        <div>{STRINGS.general.version}</div>
        <span className="gv">{STRINGS.statusbar.version(version)}</span>
      </div>

      {updateOpen && <UpdateDialog onClose={() => setUpdateOpen(false)} />}
    </>
  );
}
