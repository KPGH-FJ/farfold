import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { HostActivationNotice } from "./components/HostActivationNotice";
import { HostRecoveryScreen } from "./components/HostRecoveryScreen";
import { Workspace } from "./components/Workspace";
import {
  loadHostStorageBootstrap,
  type HostStorageBootstrap,
} from "./runtime/host-storage";
import { traceAfterPaint } from "./runtime/performance-trace";

export default function App() {
  const [bootstrap, setBootstrap] = useState<HostStorageBootstrap>({
    phase: "checking",
  });

  useEffect(() => {
    if (bootstrap.phase === "ready") traceAfterPaint("shell_ready");
  }, [bootstrap.phase]);

  useEffect(() => {
    let cancelled = false;
    void loadHostStorageBootstrap().then((result) => {
      if (!cancelled) setBootstrap(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function retryStorageStatus() {
    setBootstrap({ phase: "checking" });
    void loadHostStorageBootstrap().then(setBootstrap);
  }

  if (bootstrap.phase !== "ready") {
    return (
      <HostRecoveryScreen
        bootstrap={bootstrap}
        onRetry={retryStorageStatus}
        onReveal={revealItemInDir}
      />
    );
  }

  return (
    <>
      <Workspace />
      <HostActivationNotice
        status={bootstrap.activation}
        onReveal={revealItemInDir}
      />
    </>
  );
}
