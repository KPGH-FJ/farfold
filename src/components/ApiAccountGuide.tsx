import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";

export function ApiAccountGuide({
  stage,
  provider,
  onProvider,
  onContinue,
  onReturn,
}: {
  stage: "provider" | "prepare";
  provider: string;
  onProvider: (value: string) => void;
  onContinue: () => void;
  onReturn: () => void;
}) {
  return (
    <>
      <div className="api-dialog-body api-account-guide">
        {stage === "provider" ? (
          <label className="api-field">
            <span>{G.provider}</span>
            <input
              autoFocus
              value={provider}
              maxLength={256}
              placeholder={G.providerPlaceholder}
              onChange={(event) => onProvider(event.target.value)}
            />
            <small>{G.providerHint}</small>
          </label>
        ) : (
          <>
            <div className="api-guide-heading">
              <h3>{provider.trim() || R.apiPreparationTitle}</h3>
              <span>{G.apiKind}</span>
            </div>
            <h4>{G.prepareKey}</h4>
            <ol>
              {R.apiPreparation.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p>{R.apiPreparationHint}</p>
            <p className="api-muted">{G.destination}</p>
          </>
        )}
        <p className="api-muted">{G.kept}</p>
      </div>
      <footer>
        {stage === "provider" ? (
          <>
            <button className="btn btn-ghost" onClick={onReturn}>
              {G.backConfig}
            </button>
            <button
              className="btn btn-primary"
              disabled={!provider.trim()}
              onClick={onContinue}
            >
              {G.continue}
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={onReturn}>
            {G.fillConfig}
          </button>
        )}
      </footer>
    </>
  );
}
