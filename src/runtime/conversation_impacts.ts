import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { IndexRow } from "./sessions";

/** Reads Farfold's existing index, including archived conversations, never Agent history. */
export function useStoredConversationIndex(owner: string | null) {
  const [result, setResult] = useState<{
    owner: string;
    rows: IndexRow[];
  } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setResult(null);
    setError(false);
    if (owner)
      void invoke<IndexRow[]>("session_index_list")
        .then((rows) => {
          if (!Array.isArray(rows)) throw Error("Invalid index response");
          if (current) setResult({ owner, rows });
        })
        .catch(() => {
          if (current) setError(true);
        });
    return () => {
      current = false;
    };
  }, [owner, revision]);
  return {
    rows: result?.owner === owner ? result.rows : null,
    error,
    retry: () => setRevision((value) => value + 1),
  };
}

export function credentialImpact(rows: IndexRow[], credentialId: string) {
  const affected: IndexRow[] = [];
  let unknown = 0;
  for (const row of rows) {
    const config = row.configOptions as {
      _farfoldService?: { kind?: string; identity?: { id?: string } };
    } | null;
    const source = config?._farfoldService;
    if (
      source?.kind === "configured" &&
      typeof source.identity?.id === "string"
    ) {
      if (source.identity.id === credentialId) affected.push(row);
    } else if (source?.kind !== "existing") unknown++;
  }
  return { affected, unknown };
}
