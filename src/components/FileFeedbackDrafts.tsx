import { useState } from "react";
import { fileFeedbackDrafts, useFileFeedbackEntries } from "../runtime/drafts";
import {
  FEEDBACK_STRINGS as S,
  fileFeedbackText,
} from "../runtime/feedback_strings";

/** Unsent user feedback remains reachable even if the Agent cannot replay its artifact. */
export function FileFeedbackDrafts({
  threadKey,
  path,
  excludeContentId,
}: {
  threadKey: string;
  path?: string;
  excludeContentId?: string;
}) {
  const saved = useFileFeedbackEntries(threadKey);
  const [message, setMessage] = useState<string | null>(null);
  const entries = Object.entries(saved).filter(
    ([, entry]) =>
      entry.text.trim() &&
      (!path || entry.path === path) &&
      (excludeContentId === undefined || entry.contentId !== excludeContentId),
  );
  if (!entries.length) return message ? <p role="status">{message}</p> : null;
  return (
    <details className="file-feedback-drafts">
      <summary>{path ? S.previous : S.saved(entries.length)}</summary>
      <p>{S.retained}</p>
      {entries.map(([key, entry], index) => (
        <section key={key}>
          <strong>
            {entry.path} · {S.version(index)}
          </strong>
          <pre>{fileFeedbackText(entry)}</pre>
          <div className="ac-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                const current = fileFeedbackDrafts.entries(threadKey)[key];
                if (
                  current &&
                  fileFeedbackDrafts.take(
                    threadKey,
                    key,
                    fileFeedbackText(current),
                  )
                )
                  setMessage(S.added);
              }}
            >
              {S.add}
            </button>
            <button
              type="button"
              className="btn btn-text"
              onClick={() => {
                const current = fileFeedbackDrafts.entries(threadKey)[key];
                if (current)
                  void navigator.clipboard
                    .writeText(fileFeedbackText(current))
                    .then(() => setMessage(S.copied))
                    .catch(() => setMessage(S.copyFailed));
              }}
            >
              {S.copy}
            </button>
          </div>
        </section>
      ))}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
