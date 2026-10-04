import { GlobeIcon } from "@phosphor-icons/react";
import type { BrowserSharingModel } from "../runtime/browser_sharing";
import { BROWSER_SHARING_STRINGS as S } from "../runtime/browser_sharing_strings";

export interface BrowserReadRequestProps {
  sharing: BrowserSharingModel;
  onViewPage?: () => void;
}

/** This card responds only to a real, still-pending tool call. */
export function BrowserReadRequest({
  sharing,
  onViewPage,
}: BrowserReadRequestProps) {
  const request = sharing.pendingRequest;
  if (!request)
    return sharing.error ? (
      <div className="browser-share-error" role="alert">
        <p>{sharing.error}</p>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void sharing.refresh()}
        >
          {S.refresh}
        </button>
      </div>
    ) : sharing.notice ? (
      <p className="browser-share-status" role="status">
        {sharing.notice}
      </p>
    ) : null;
  const busy = sharing.operation !== null;
  return (
    <section
      className="approval browser-read-request"
      aria-label={S.requestTitle}
      aria-busy={busy}
    >
      <div className="browser-read-request-heading ap-title">
        <GlobeIcon size={18} aria-hidden="true" />
        {S.requestTitle}
      </div>
      <p className="ap-sub">{S.requestScope}</p>
      <p className="browser-read-request-url">{request.url}</p>
      <p className="ap-sub">{S.retained}</p>
      {sharing.error && (
        <div className="browser-share-error" role="alert">
          <p>{sharing.error}</p>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void sharing.refresh()}
          >
            {S.refresh}
          </button>
        </div>
      )}
      <div className="ap-actions browser-read-request-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !sharing.ready}
          onClick={() => void sharing.respond(request.requestId, true)}
        >
          {sharing.operation === "allow" ? S.allowing : S.allowAndContinue}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || !sharing.ready}
          onClick={() => void sharing.respond(request.requestId, false)}
        >
          {sharing.operation === "deny" ? S.denying : S.deny}
        </button>
        {onViewPage && (
          <button type="button" className="btn btn-text" onClick={onViewPage}>
            {S.viewPage}
          </button>
        )}
      </div>
    </section>
  );
}
