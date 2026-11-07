import { useState, useSyncExternalStore } from "react";
import { composerDrafts } from "../runtime/drafts";
import { REDESIGN as R } from "../runtime/redesign_strings";

export function PreservedDrafts({
  onRestore,
}: {
  onRestore: (key: string) => Promise<void>;
}) {
  useSyncExternalStore(
    composerDrafts.subscribe,
    composerDrafts.revision,
    composerDrafts.revision,
  );
  const saved = composerDrafts.preserved();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!saved.length) return null;
  return (
    <details className="preserved-drafts">
      <summary>{R.savedDrafts(saved.length)}</summary>
      <p>{R.savedDraftHint}</p>
      {error && <p role="alert">{error}</p>}
      {saved.map(([key, draft]) => (
        <article key={key}>
          <div>
            <strong>
              {draft.text.slice(0, 60) ||
                R.attachmentCount(draft.attachments.length)}
            </strong>
            <small>
              {draft.savedChoice?.cwd || R.noFolder} ·{" "}
              {R.attachmentCount(draft.attachments.length)}
            </small>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy !== null}
            onClick={async () => {
              if (!composerDrafts.canRestorePreserved(key, draft)) return;
              setBusy(key);
              setError("");
              try {
                await onRestore(key);
              } catch (reason) {
                setError(
                  reason instanceof Error ? reason.message : R.saveFailed,
                );
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === key ? R.restoringDraft : R.restoreDraft}
          </button>
        </article>
      ))}
    </details>
  );
}
