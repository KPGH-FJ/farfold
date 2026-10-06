import { useEffect, useId, useState } from "react";
import { ShieldCheckIcon, StopCircleIcon } from "@phosphor-icons/react";
import type { BrowserSharingModel } from "../runtime/browser_sharing";
import type { BrowserWorkspaceState } from "../runtime/browser_workspace";
import {
  BROWSER_SHARING_STRINGS as S,
  browserSharingUnavailableReason,
} from "../runtime/browser_sharing_strings";

export interface BrowserShareControlsProps {
  sharing: BrowserSharingModel;
  page: BrowserWorkspaceState | null;
  onViewRequest?: () => void;
}

export function BrowserShareControls({
  sharing,
  page,
  onViewRequest,
}: BrowserShareControlsProps) {
  const [reviewedPage, setReviewedPage] = useState<string | null>(null);
  const pageKey = JSON.stringify([page?.taskKey, page?.label, page?.revision]);
  const expanded = reviewedPage === pageKey;
  const scopeId = useId();
  const phase = sharing.info?.phase;
  useEffect(
    () => setReviewedPage(null),
    [
      page?.taskKey,
      page?.label,
      page?.revision,
      phase,
      sharing.pendingRequest?.requestId,
    ],
  );
  const busy = sharing.operation !== null;
  const canStop = phase === "shared" || phase === "stop_failed";
  const canAllow =
    sharing.ready &&
    phase === "unshared" &&
    page?.phase === "ready" &&
    sharing.info?.label === page.label &&
    !sharing.pendingRequest;
  const status =
    phase === "stop_failed"
      ? S.stopFailed
      : phase === "stopping" || sharing.operation === "stop"
        ? S.stopping
        : sharing.queryState === "no_session"
          ? S.noSession
          : sharing.queryState === "disconnected"
            ? S.connectionLost
            : sharing.queryState === "inactive"
              ? S.inactive
              : sharing.queryState === "failed"
                ? S.statusFailed
                : sharing.queryState === "checking"
                  ? S.checking
                  : sharing.pendingRequest
                    ? S.confirmInChat
                    : phase === "shared"
                      ? S.shared
                      : phase === "preparing"
                        ? S.preparing
                        : phase === "unavailable"
                          ? browserSharingUnavailableReason(
                              sharing.info?.reason,
                            )
                          : !page || page.phase === "closed"
                            ? S.noPage
                            : S.unshared;
  return (
    <div className="browser-share-controls">
      <div className="browser-share-toggle">
        <button
          type="button"
          className="btn btn-ghost"
          aria-expanded={!canStop && expanded}
          aria-controls={!canStop ? scopeId : undefined}
          disabled={busy || !sharing.ready || (!canStop && !canAllow)}
          onClick={() =>
            canStop
              ? void sharing.stop()
              : setReviewedPage((value) => (value === pageKey ? null : pageKey))
          }
        >
          {canStop ? (
            <StopCircleIcon size={16} aria-hidden="true" />
          ) : (
            <ShieldCheckIcon size={16} aria-hidden="true" />
          )}
          {sharing.operation === "stop"
            ? S.stopping
            : phase === "stop_failed"
              ? S.retryStop
              : canStop
                ? S.stop
                : S.permission}
        </button>
        <span className="browser-share-status" role="status" title={status}>
          {status}
        </span>
        {onViewRequest && (
          <button
            type="button"
            className={`btn btn-text browser-share-request${sharing.pendingRequest ? "" : " is-idle"}`}
            disabled={!sharing.pendingRequest}
            aria-hidden={!sharing.pendingRequest || undefined}
            tabIndex={sharing.pendingRequest ? undefined : -1}
            onClick={onViewRequest}
          >
            {S.viewRequest}
          </button>
        )}
      </div>
      {expanded && canAllow && (
        <div
          className="browser-share-scope"
          id={scopeId}
          onKeyDown={(event) => {
            if (event.key === "Escape") setReviewedPage(null);
          }}
        >
          <p>{S.manualScope}</p>
          <p className="browser-read-request-url">{page?.url}</p>
          <p>{S.retained}</p>
          <div className="ap-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void sharing.allow()}
            >
              {busy ? S.allowing : S.allow}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setReviewedPage(null)}
            >
              {S.cancel}
            </button>
          </div>
        </div>
      )}
      {sharing.error && (
        <div className="browser-share-error" role="alert">
          <span>{sharing.error}</span>
          <button
            type="button"
            className="btn btn-text"
            disabled={busy}
            onClick={() => void sharing.refresh()}
          >
            {S.refresh}
          </button>
        </div>
      )}
    </div>
  );
}
