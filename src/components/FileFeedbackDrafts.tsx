import { useState } from "react";
import {
  fileFeedbackDrafts,
  useFileFeedbackEntries,
  type FileFeedbackDestination,
  type FileFeedbackDraftEntry,
  type SavedFileFeedback,
} from "../runtime/drafts";
import {
  FEEDBACK_STRINGS as S,
  fileFeedbackText,
} from "../runtime/feedback_strings";

function renderEntries(
  entries: FileFeedbackDraftEntry[],
  setMessage: (value: string) => void,
  add?: (threadKey: string, key: string, entry: SavedFileFeedback) => boolean,
) {
  return entries.map(([threadKey, key, entry], index) => (
    <section key={JSON.stringify([threadKey, key])}>
      <strong>
        {entry.path} · {S.version(index)}
      </strong>
      <pre>{fileFeedbackText(entry)}</pre>
      <div className="ac-actions">
        {add && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              const current = fileFeedbackDrafts.entries(threadKey)[key];
              if (current && add(threadKey, key, current)) setMessage(S.added);
            }}
          >
            {S.add}
          </button>
        )}
        <button
          type="button"
          className="btn btn-text"
          onClick={async () => {
            if (fileFeedbackDrafts.entries(threadKey)[key] !== entry) return;
            try {
              await navigator.clipboard.writeText(fileFeedbackText(entry));
              setMessage(S.copied);
            } catch {
              setMessage(S.copyFailed);
            }
          }}
        >
          {S.copy}
        </button>
      </div>
    </section>
  ));
}

/** Opinions stay with their saved owner when there is no reachable input. */
export function UnavailableOwnerFileFeedback({
  entries,
}: {
  entries: FileFeedbackDraftEntry[];
}) {
  const [message, setMessage] = useState<string | null>(null);
  if (!entries.length) return null;
  return (
    <details className="file-feedback-drafts">
      <summary>{S.unavailableOwner(entries.length)}</summary>
      <p>{S.unavailableOwnerHint}</p>
      {renderEntries(entries, setMessage)}
      {message && <p role="status">{message}</p>}
    </details>
  );
}

/** Unsent user feedback remains reachable even if the Agent cannot replay its artifact. */
export function FileFeedbackDrafts({
  threadKey,
  path,
  excludeContentId,
  feedbackDestination,
}: {
  feedbackDestination?: FileFeedbackDestination;
  threadKey: string;
  path?: string;
  excludeContentId?: string;
}) {
  const saved = useFileFeedbackEntries(threadKey);
  const [message, setMessage] = useState<string | null>(null);
  const entries = Object.entries(saved)
    .filter(
      ([, entry]) =>
        entry.text.trim() &&
        (!path || entry.path === path) &&
        (excludeContentId === undefined ||
          entry.contentId !== excludeContentId),
    )
    .map<FileFeedbackDraftEntry>(([key, entry]) => [threadKey, key, entry]);
  if (!entries.length) return message ? <p role="status">{message}</p> : null;
  return (
    <details className="file-feedback-drafts">
      <summary>{path ? S.previous : S.saved(entries.length)}</summary>
      <p>{S.retained}</p>
      {renderEntries(entries, setMessage, (owner, key, entry) =>
        fileFeedbackDrafts.take(
          owner,
          key,
          fileFeedbackText(entry),
          feedbackDestination,
        ),
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
