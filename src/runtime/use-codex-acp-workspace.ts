import { useEffect, useState } from "react";
import type { HostSessionBinding } from "./host-shadow";
import { type CodexAcpWorkspaceSnapshot } from "./codex-acp-workspace";
import { codexWorkspaceBackend } from "./codex-workspace-backend";
import {
  CodexAcpTranscriptReader,
  type AcpTranscript,
} from "./codex-acp-transcript";

export function useCodexAcpWorkspace(
  enabled: boolean,
  binding: HostSessionBinding | null,
) {
  const [result, setResult] = useState<{
    key: string;
    snapshot: CodexAcpWorkspaceSnapshot | null;
    error: string | null;
    transcript: AcpTranscript | null;
  } | null>(null);
  const key = JSON.stringify(
    binding && [
      binding.farfoldSessionId,
      binding.runtimeProductId,
      binding.installationId,
      binding.runtimeBuildId,
      binding.adapterId,
      binding.connectionId,
      binding.nativeSessionId,
      binding.workingCopyId,
      binding.workingCopyPath,
    ],
  );
  useEffect(() => {
    if (!enabled) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reader = new CodexAcpTranscriptReader();
    const poll = async () => {
      try {
        const backend = codexWorkspaceBackend(binding, () => !canceled);
        const result = await backend.read();
        if (canceled || result.kind !== "acp" || !result.snapshot) return;
        const snapshot = result.snapshot;
        const scoped = codexWorkspaceBackend(
          binding,
          () => !canceled,
          undefined,
          snapshot.scope,
        );
        const transcript = await reader.read(snapshot, () => {
          if (!snapshot.scope) throw new Error("Original scope missing");
          return scoped.historyAcp(snapshot.scope);
        });
        if (!canceled) setResult({ key, snapshot, transcript, error: null });
      } catch {
        if (!canceled)
          setResult({
            key,
            snapshot: null,
            transcript: null,
            error: "Codex ACP 状态无法核对；没有改用旧连接",
          });
      } finally {
        if (!canceled) timer = setTimeout(poll, 400);
      }
    };
    void poll();
    return () => {
      canceled = true;
      reader.retire();
      clearTimeout(timer);
      setResult((current) => (current?.key === key ? null : current));
    };
  }, [enabled, key]);
  return enabled && result?.key === key ? result : null;
}
