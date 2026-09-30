import { useEffect, useState } from "react";
import {
  ApiRequestScope,
  testApi,
  type ApiResult,
  type ApiSource,
} from "../runtime/credentials";
import { STRINGS } from "../runtime/strings";
import { uiError } from "../runtime/ui_error";
const S = STRINGS.credentials;

export function ApiTestPanel({
  source,
  models,
  contextKey,
  disabled = false,
}: {
  source: ApiSource;
  models: string[];
  contextKey: string;
  disabled?: boolean;
}) {
  const [scope] = useState(() => new ApiRequestScope());
  const [model, setModel] = useState(models[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const effectiveModel = models.includes(model) ? model : (models[0] ?? "");
  useEffect(() => {
    scope.invalidate();
    setBusy(false);
    setCancelling(false);
    setResult(null);
    setError(null);
    return () => scope.invalidate();
  }, [scope, contextKey, effectiveModel]);
  const start = () => {
    if (busy || disabled || !effectiveModel) return;
    setBusy(true);
    setError(null);
    setResult(null);
    void scope.run(
      (requestId) => testApi({ requestId, source, model: effectiveModel }),
      (value) => {
        setResult(value);
        setBusy(false);
        setCancelling(false);
      },
      (reason) => {
        setError(uiError(reason, S.testFailed));
        setBusy(false);
        setCancelling(false);
      },
    );
  };
  const cancel = async () => {
    setCancelling(true);
    setError(null);
    try {
      if (!(await scope.cancel())) {
        setError(S.cancelFailed);
        setCancelling(false);
      }
    } catch {
      setError(S.cancelFailed);
      setCancelling(false);
    }
  };
  return (
    <section className="api-test-panel" aria-label={S.test}>
      <div className="api-test-heading">
        <h3>{S.test}</h3>
        {result?.latencyMs != null && (
          <span>{S.elapsed(result.latencyMs)}</span>
        )}
      </div>
      <p>{S.testHint}</p>
      <div className="api-test-controls">
        <label className="api-field">
          <span>{S.selectModel}</span>
          <select
            value={effectiveModel}
            onChange={(event) => setModel(event.target.value)}
            disabled={busy || disabled}
          >
            {!models.length && <option value="">{S.noModels}</option>}
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        {busy ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {cancelling ? S.cancelling : S.cancelTest}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled || !effectiveModel}
            onClick={start}
          >
            {S.startTest}
          </button>
        )}
      </div>
      <div
        aria-live="polite"
        role="status"
        className={`api-test-result ${result?.status ?? ""}`}
      >
        {busy && <p>{cancelling ? S.cancelling : S.testing}</p>}
        {result && <p>{result.message}</p>}
        {error && <p className="api-error">{error}</p>}
        {result?.responseText && (
          <pre aria-label={S.response}>{result.responseText}</pre>
        )}
      </div>
      <small>{S.testScope}</small>
    </section>
  );
}
