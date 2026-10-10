import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StorageRestore } from "/src/components/StorageRestore";
import shared from "/src/runtime/fixtures/storage-restore-v1.json";
import "/src/styles.css";
const mode = new URLSearchParams(location.search).get("mode") ?? "valid";
const snapshot = structuredClone(shared["unsentWork.v1"]);
if (mode === "invalid")
  snapshot.feedback["fixture-thread"]["area.pdf"].anchor.right = 0;
if (mode === "unknown")
  Object.assign(snapshot.feedback["fixture-thread"]["area.png"].anchor, {
    foreignSecret: "CONTROLLED_UNKNOWN_FIELD",
  });
(window as any).calls = [];
(window as any).blocks = [];
(window as any).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: unknown) => {
    (window as any).calls.push({ cmd, args });
    if (cmd === "plugin:dialog|open") return "/controlled/candidate.sqlite3";
    if (cmd === "storage_recovery_restore_preview")
      return {
        id: "a".repeat(48),
        sourcePath: "/controlled/candidate.sqlite3",
        values: {
          "unsentWork.v1": JSON.stringify(snapshot),
          "agentSetup.v1": null,
        },
      };
    throw Error("Unexpected controlled restore command " + cmd);
  },
};
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main style={{ padding: 24, maxWidth: 760 }}>
      <StorageRestore
        keys={["unsentWork.v1"]}
        disabled={false}
        onBlockChange={(v) => (window as any).blocks.push(v)}
      />
    </main>
  </StrictMode>,
);
