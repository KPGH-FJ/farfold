import { invoke } from "@tauri-apps/api/core";
import { archiveActivity } from "./archive_activity";
import { draftPersistence, hasUnsentWork } from "./drafts";
import type { IndexRow } from "./sessions";
import { hasActiveTools, type ThreadState } from "./session_types";
import { STRINGS } from "./strings";

export function archiveBlockReason(
  key: string,
  state: ThreadState | undefined,
  needsAttention: (state: ThreadState) => boolean,
) {
  if (state?.stopping) return "stopping" as const;
  if (state?.stopUnconfirmed || state?.uncertainPrompt)
    return "unconfirmed" as const;
  if (state?.submitting) return "submitting" as const;
  if (state?.configuring) return "configuring" as const;
  if (state?.reconnecting) return "reconnecting" as const;
  if (state && needsAttention(state)) return "attention" as const;
  if (state && (state.running || hasActiveTools(state)))
    return "running" as const;
  if (state?.queued.length) return "queued" as const;
  if (hasUnsentWork(key)) return "unsent" as const;
  return null;
}

/** Check existing state without storing directory aliases or changing the index. */
export async function archiveIndexRow(
  rowId: string,
  archived: boolean,
  row: IndexRow | undefined,
  blocked: (key: string) => unknown,
): Promise<void> {
  let expectedCwd: string | undefined;
  if (archived) {
    if (blocked(rowId)) throw new Error(STRINGS.repair.archiveBusy);
    let canonicalKey: string | undefined;
    if (row?.nativeSessionId) {
      try {
        const value = await invoke<{ cwd?: unknown } | null>("agent_work_get", {
          cwd: row.cwd,
        });
        if (
          typeof value?.cwd !== "string" ||
          !value.cwd.startsWith("/") ||
          value.cwd.includes("\0")
        )
          throw new Error(STRINGS.repair.archiveDirectoryUnknown);
        expectedCwd = value.cwd;
        canonicalKey = `${row.agentId}:${value.cwd}:${row.nativeSessionId}`;
      } catch {
        // Failure cannot establish which live state or saved input belongs here.
        throw new Error(STRINGS.repair.archiveDirectoryUnknown);
      }
    }
    await draftPersistence.flush();
    // Input and running state may have changed while either operation waited.
    if (blocked(rowId) || (canonicalKey && blocked(canonicalKey)))
      throw new Error(STRINGS.repair.archiveBusy);
  } else await archiveActivity.touch(rowId);
  await invoke("session_meta_archive", {
    sessionId: rowId,
    archived,
    ...(expectedCwd ? { expectedCwd } : {}),
  });
}
