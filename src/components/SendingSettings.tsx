import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useWorkPolicy } from "../runtime/work_policy";
import { newConversationChoice } from "../runtime/drafts";
import type { AgentCardModel } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import { COMPOSER_CONTROLS as S } from "../runtime/composer_strings";
import { SENDING_STRINGS as P } from "../runtime/sending_strings";
import { useStoredConversationIndex } from "../runtime/conversation_impacts";

function LocationRow({
  cwd,
  label,
  count,
  currentDraft,
  onPause,
  onResult,
}: {
  cwd: string;
  label: string;
  count: number;
  currentDraft: boolean;
  onPause: () => void;
  onResult: (message: string) => void;
}) {
  const work = useWorkPolicy(cwd);
  const paused = work.locationEnabled === false;
  return (
    <div className="sending-location-row">
      <div>
        <strong>{label}</strong>
        <small>
          {paused
            ? `${S.paused} · `
            : work.locationEnabled === undefined && work.legacyPaused
              ? `${P.legacy} · `
              : ""}
          {P.count(count)}
          {currentDraft ? ` · ${P.currentDraft}` : ""}
        </small>
        {work.error && (
          <p role="alert" className="ac-error">
            {work.error}
            <button className="btn btn-text" onClick={work.retry}>
              {STRINGS.common.retry}
            </button>
          </p>
        )}
      </div>
      <button
        className="btn btn-ghost"
        disabled={!work.ready || work.saving}
        onClick={async () => {
          if (!paused) onPause();
          else if (await work.setLocation(true)) onResult(P.resumed(label));
        }}
      >
        {work.saving ? P.saving : paused ? S.resume : S.pause}
      </button>
    </div>
  );
}

export function SendingSettings({
  defaultCwd,
  onClose,
}: {
  agents: AgentCardModel[];
  defaultCwd: string | null;
  onClose: () => void;
}) {
  const index = useStoredConversationIndex("sending-settings");
  const [paths, setPaths] = useState<string[] | null>(null);
  const [readError, setReadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const owner = useRef<string | null>(null);
  owner.current = selected;
  const work = useWorkPolicy(selected);
  const draftCwd = newConversationChoice.cwd ?? defaultCwd;
  useEffect(() => {
    let active = true;
    setPaths(null);
    setReadError(false);
    void invoke<{
      projects?: Record<string, unknown>;
      locations?: Record<string, boolean>;
    } | null>("settings_get", { key: "agentWorkPolicy.v1" })
      .then((value) => {
        if (active)
          setPaths([
            ...Object.keys(value?.projects ?? {}),
            ...Object.keys(value?.locations ?? {}),
          ]);
      })
      .catch(() => {
        if (active) setReadError(true);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const failed = readError || index.error;
  const ready = paths !== null && index.rows !== null && !failed;
  const scopes = [
    ...new Set(
      [
        defaultCwd,
        draftCwd,
        ...(paths ?? []),
        ...(index.rows ?? []).map((row) => row.cwd),
      ].filter((path): path is string => Boolean(path)),
    ),
  ];
  const label = (path: string) => (path === defaultCwd ? S.ordinary : path);
  const affected = (index.rows ?? []).filter((row) => row.cwd === selected);
  return (
    <>
      <section className="sending-settings" aria-label={P.title}>
        {failed ? (
          <div role="alert" className="ac-error">
            <p>{P.readFailed}</p>
            <button
              className="btn btn-ghost"
              onClick={() => {
                index.retry();
                setRevision((value) => value + 1);
              }}
            >
              {STRINGS.common.retry}
            </button>
          </div>
        ) : !ready ? (
          <p role="status">{P.loading}</p>
        ) : selected ? (
          <>
            <h3>{label(selected)}</h3>
            <p>{P.future}</p>
            <ul className="sending-impact-list">
              {draftCwd === selected && <li>{P.currentDraft}</li>}
              {affected.map((row) => (
                <li key={row.id}>
                  <span>{row.title || P.untitled}</span>
                  {row.archived && <small>{P.archived}</small>}
                </li>
              ))}
              {draftCwd !== selected && !affected.length && <li>{P.empty}</li>}
            </ul>
            <p>{P.retained}</p>
            {work.error && (
              <p role="alert" className="ac-error">
                {work.error}
                <button className="btn btn-text" onClick={work.retry}>
                  {STRINGS.common.retry}
                </button>
              </p>
            )}
          </>
        ) : (
          <>
            <p>{P.detail}</p>
            {result && <p role="status">{result}</p>}
            <div className="sending-location-list">
              {scopes.map((cwd) => (
                <LocationRow
                  key={cwd}
                  cwd={cwd}
                  label={label(cwd)}
                  count={
                    (index.rows ?? []).filter((row) => row.cwd === cwd).length
                  }
                  currentDraft={draftCwd === cwd}
                  onPause={() => {
                    setResult("");
                    setSelected(cwd);
                  }}
                  onResult={setResult}
                />
              ))}
            </div>
            <p className="general-caption">{P.resumeHint}</p>
          </>
        )}
      </section>
      <footer>
        {ready && selected ? (
          <>
            <button
              className="btn btn-ghost"
              disabled={work.saving}
              onClick={() => setSelected(null)}
            >
              {P.back}
            </button>
            <button
              className="btn btn-primary"
              disabled={!work.ready || work.saving}
              onClick={async () => {
                const target = selected;
                if (
                  (await work.setLocation(false)) &&
                  owner.current === target
                ) {
                  setResult(P.paused(label(target)));
                  setSelected(null);
                }
              }}
            >
              {work.saving ? P.saving : S.pause}
            </button>
          </>
        ) : (
          <button className="btn btn-ghost" onClick={onClose}>
            {P.done}
          </button>
        )}
      </footer>
    </>
  );
}
