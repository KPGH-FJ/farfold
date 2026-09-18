import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { STRINGS } from "../runtime/strings";

interface StatusBarProps {
  connectedCount: number;
}

export function StatusBar({ connectedCount }: StatusBarProps) {
  const [version, setVersion] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <footer className="statusbar">
      <div className="seg">
        <span>{STRINGS.statusbar.agentsConnected(connectedCount)}</span>
        <span>{STRINGS.statusbar.sessions(0)}</span>
      </div>
      <div className="seg">
        <span>{version ? STRINGS.statusbar.version(version) : ""}</span>
      </div>
    </footer>
  );
}
