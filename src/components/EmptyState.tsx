import appIconUrl from "../../assets/app-icon.svg";
import { STRINGS } from "../runtime/strings";

interface EmptyStateProps {
  hasConnectedAgent: boolean;
  onGoSettings: () => void;
}

export function EmptyState({
  hasConnectedAgent,
  onGoSettings,
}: EmptyStateProps) {
  if (!hasConnectedAgent) {
    return (
      <div className="empty-wrap">
        <div className="empty-col">
          <img className="empty-logo" src={appIconUrl} alt="" />
          <div className="empty-h">{STRINGS.empty.connectTitle}</div>
          <div className="empty-sub">{STRINGS.empty.connectSubtitle}</div>
          <div className="empty-actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={onGoSettings}
            >
              {STRINGS.empty.goSettings}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="empty-wrap">
      <div className="empty-col">
        <div className="empty-h">{STRINGS.empty.readyTitle}</div>
        <div className="empty-sub">{STRINGS.empty.readySubtitle}</div>
        <div className="composer-box disabled">
          <textarea
            className="c-input"
            rows={2}
            disabled
            placeholder={STRINGS.empty.composerPlaceholder}
          />
          <div className="c-row">
            <div className="c-tools" />
            <div className="c-actions">
              <button className="c-send empty" type="button" disabled>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#a8a8a0"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
