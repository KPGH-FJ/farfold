import { useLayoutEffect, useRef, useState } from "react";
import {
  isReportedArtifactCurrent,
  reportedArtifactFiles,
  type ReportedArtifactFile,
  type ReportedArtifactOrigin,
} from "../runtime/reported_artifacts";
import type { ThreadState } from "../runtime/session_types";
import { REPORTED_ARTIFACT_STRINGS as S } from "../runtime/reported_artifact_strings";
import "./ReportedFilesList.css";

export const REPORTED_FILES_PAGE_SIZE = 50;
const SOURCE_PAGE_SIZE = 20;
export interface ReportedFilesListProps {
  thread: ThreadState;
  scopeId: string | null;
  active: boolean;
  onOpenFile: (entry: ReportedArtifactFile) => void;
  onOpenSource?: (
    entry: ReportedArtifactFile,
    origin: ReportedArtifactOrigin,
  ) => void;
}

function Sources({
  entry,
  active,
  onOpen,
}: {
  entry: ReportedArtifactFile;
  active: boolean;
  onOpen: (origin: ReportedArtifactOrigin) => void;
}) {
  const [offset, setOffset] = useState(0);
  const total = Math.ceil(entry.origins.length / SOURCE_PAGE_SIZE);
  const page = Math.min(offset, total - 1);
  const visible = entry.origins.slice(
    page * SOURCE_PAGE_SIZE,
    (page + 1) * SOURCE_PAGE_SIZE,
  );
  return (
    <details className="reported-file-sources">
      <summary>{S.sources}</summary>
      <ol start={page * SOURCE_PAGE_SIZE + 1}>
        {visible.map((origin, index) => (
          <li key={`${origin.toolItemId}:${origin.source}`}>
            <span>{S.sourceNames[origin.source]}</span>
            <button
              type="button"
              disabled={!active}
              onClick={() => onOpen(origin)}
            >
              {S.sourceRecord(page * SOURCE_PAGE_SIZE + index + 1)}
            </button>
          </li>
        ))}
      </ol>
      {total > 1 && (
        <div className="reported-files-pagination">
          <button
            type="button"
            disabled={!active || page === 0}
            onClick={() => setOffset(Math.max(0, page - 1))}
          >
            {S.previousSources}
          </button>
          <span aria-live="polite">{S.page(page + 1, total)}</span>
          <button
            type="button"
            disabled={!active || page + 1 === total}
            onClick={() => setOffset(Math.min(total - 1, page + 1))}
          >
            {S.nextSources}
          </button>
        </div>
      )}
    </details>
  );
}

/** Passive in-memory list. Only an explicit, still-current action leaves it. */
export function ReportedFilesList({
  thread,
  scopeId,
  active,
  onOpenFile,
  onOpenSource,
}: ReportedFilesListProps) {
  const owner = useRef({ thread, key: thread.key, cwd: thread.cwd, scopeId });
  if (
    owner.current.thread !== thread ||
    owner.current.key !== thread.key ||
    owner.current.cwd !== thread.cwd ||
    owner.current.scopeId !== scopeId
  )
    owner.current = { thread, key: thread.key, cwd: thread.cwd, scopeId };
  const context = owner.current;
  const [location, setLocation] = useState({ owner: context, page: 0 });
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const files = reportedArtifactFiles(thread, scopeId);
  const pages = Math.max(
    1,
    Math.ceil((files?.length ?? 0) / REPORTED_FILES_PAGE_SIZE),
  );
  const page = Math.min(
    location.owner === context ? location.page : 0,
    pages - 1,
  );
  const rendered = { context, page };
  const latest = useRef(rendered);
  latest.current = rendered;
  const current = () =>
    mounted.current && active && latest.current === rendered;
  const allowed = (entry: ReportedArtifactFile) =>
    current() && isReportedArtifactCurrent(thread, scopeId, entry);
  const move = (next: number) => {
    if (current()) setLocation({ owner: context, page: next });
  };
  return (
    <section className="reported-files" aria-label={S.title}>
      <header>
        <strong>{S.title}</strong>
        {files && <span>{S.count(files.length)}</span>}
      </header>
      {files === null ? (
        <p role="status">{S.unavailable}</p>
      ) : files.length === 0 ? (
        <p role="status">{S.empty}</p>
      ) : (
        <>
          <p className="reported-files-note">{S.note}</p>
          <ul className="reported-files-rows">
            {files
              .slice(
                page * REPORTED_FILES_PAGE_SIZE,
                (page + 1) * REPORTED_FILES_PAGE_SIZE,
              )
              .map((entry) => {
                const kinds = [
                  ...new Set(entry.origins.map((origin) => origin.source)),
                ];
                const records = new Set(
                  entry.origins.map((origin) => origin.toolItemId),
                ).size;
                return (
                  <li key={entry.key}>
                    <div className="reported-file-main">
                      <span className="reported-file-path">{entry.path}</span>
                      <button
                        type="button"
                        disabled={!active}
                        aria-label={S.openLabel(entry.path)}
                        onClick={() => {
                          if (allowed(entry)) onOpenFile(entry);
                        }}
                      >
                        {S.open}
                      </button>
                    </div>
                    <p className="reported-file-origin">
                      {kinds.map((kind) => S.sourceNames[kind]).join("、")}
                      {" · "}
                      {S.sourceCount(records)}
                    </p>
                    {onOpenSource && (
                      <Sources
                        key={entry.key}
                        entry={entry}
                        active={active}
                        onOpen={(origin) => {
                          if (allowed(entry) && entry.origins.includes(origin))
                            onOpenSource(entry, origin);
                        }}
                      />
                    )}
                  </li>
                );
              })}
          </ul>
          {pages > 1 && (
            <nav className="reported-files-pagination" aria-label={S.title}>
              <button
                type="button"
                disabled={!active || page === 0}
                onClick={() => move(page - 1)}
              >
                {S.previous}
              </button>
              <span aria-live="polite">{S.page(page + 1, pages)}</span>
              <button
                type="button"
                disabled={!active || page + 1 === pages}
                onClick={() => move(page + 1)}
              >
                {S.next}
              </button>
            </nav>
          )}
        </>
      )}
      <p className="reported-files-note">{S.loaded}</p>
    </section>
  );
}
