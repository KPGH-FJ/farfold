import { useLayoutEffect, useRef, useState } from "react";
import type { KnownHistoryReader } from "../runtime/known_history_import";
import { IMPORT_STRINGS as S } from "../runtime/import_strings";
import { chooseDirectory } from "../runtime/dialogs";
import { renderHistoryPreviewBody } from "./HistoryPreviewBody";

export function KnownHistoryImport({
  reader,
  busy,
  initialCwd,
  current,
  run,
  release,
  read,
  add,
}: {
  reader: KnownHistoryReader;
  busy: boolean;
  initialCwd: string | null;
  current: () => boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  release: () => Promise<void>;
  read: (id: string, cwd: string, interested: () => boolean) => Promise<void>;
  add: () => Promise<void>;
}) {
  const [id, setId] = useState("");
  // Only an explicitly chosen lookup folder is reused, never the app default.
  const [cwd, setCwd] = useState(initialCwd);
  const lifetime = useRef({ alive: false });
  useLayoutEffect(() => {
    const owner = { alive: true };
    lifetime.current = owner;
    return () => {
      owner.alive = false;
      reader.retire();
    };
  }, [reader]);
  const interest = () => {
    const owner = lifetime.current;
    return () => owner.alive && current();
  };
  const preview = reader.preview;
  return (
    <div>
      <p>{S.knownHint}</p>
      <label className="history-search">
        {S.knownId}
        <input
          aria-label={S.knownId}
          value={id}
          disabled={busy}
          autoComplete="off"
          onChange={(event) => {
            reader.reset();
            setId(event.target.value);
          }}
        />
      </label>
      <p>
        {S.knownFolder}：{cwd ?? S.knownFolderMissing}
      </p>
      <div className="history-search">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => {
            const interested = interest();
            void run(async () => {
              if (!interested()) return;
              const next = await chooseDirectory(cwd ?? undefined);
              if (!next || !interested()) return;
              await release();
              if (interested()) setCwd(next);
            });
          }}
        >
          {S.chooseLocation}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          // Native disabling drops the initiating keyboard focus in WebKit.
          // Retain this anchor while busy; the action remains guarded below.
          disabled={!id.trim() || !cwd}
          aria-disabled={busy || undefined}
          style={busy ? { opacity: 0.55, cursor: "default" } : undefined}
          onMouseDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onClick={() => {
            if (busy) return;
            const interested = interest();
            if (cwd)
              void run(async () => {
                if (!interested()) return;
                await release();
                if (interested()) await read(id.trim(), cwd, interested);
              });
          }}
        >
          {S.knownRead}
        </button>
      </div>
      {reader.state.error && <p role="alert">{reader.state.error}</p>}
      {reader.state.saved?.nativeSessionId === id.trim() && (
        <p role="status">{S.knownAdded}</p>
      )}
      {preview && (
        <div className="history-preview">
          <h3>{S.preview}</h3>
          {renderHistoryPreviewBody(preview)}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              const interested = interest();
              void run(async () => {
                if (interested()) await add();
              });
            }}
          >
            {S.knownAdd}
          </button>
        </div>
      )}
    </div>
  );
}
