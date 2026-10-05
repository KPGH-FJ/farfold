import { useEffect, useId, useRef, useState } from "react";
import { authKeySave } from "../runtime/agents";
import {
  listCredentials,
  subscribeCredentialChanges,
  type Credential,
} from "../runtime/credentials";
import { STRINGS } from "../runtime/strings";
import { METHOD_API_KEY_STRINGS as S } from "../runtime/method_api_key_strings";
import {
  useAccessPrimary,
  type AgentAccessPrimary,
} from "../runtime/access_primary";

export function isMethodCredential(item: Credential, provider: string) {
  return (
    item.purpose === "authentication" &&
    item.provider === provider &&
    !!item.revision &&
    !item.deleting &&
    item.endpoint === "" &&
    item.apiType === "" &&
    item.models.length === 0 &&
    item.grants.length === 0
  );
}

/** Key input stays in this mounted form; authentication only receives a reference. */
export function MethodApiKeySection({
  agentId,
  methodId,
  provider,
  cwd,
  source,
  disabled,
  onAcquire,
  onStart,
  startLabel = STRINGS.agents.auth.start,
  onPrimaryChange,
}: {
  agentId: string;
  methodId: string;
  provider: string;
  cwd: string;
  source?: string;
  disabled: boolean;
  onAcquire: () => (() => void) | null;
  onStart: (credential: Pick<Credential, "id" | "revision">) => void;
  startLabel?: string;
  onPrimaryChange?: (action: AgentAccessPrimary | null) => void;
}) {
  const selectId = useId();
  const labelId = useId();
  const keyId = useId();
  const hintId = useId();
  const [items, setItems] = useState<Credential[]>([]);
  const [selected, setSelected] = useState<{
    id: string;
    revision: string;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const owner = useRef(0);
  useEffect(
    () => subscribeCredentialChanges(() => refresh((value) => value + 1)),
    [],
  );
  useEffect(() => {
    setSelected(null);
    setLabel("");
    setKey("");
    setAdding(false);
    setNote(null);
    owner.current++;
    return () => {
      owner.current++;
    };
  }, [agentId, methodId, provider, cwd, source]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void listCredentials()
      .then((records) => {
        if (current) {
          setItems(records);
          setLoading(false);
          if (!records.some((item) => isMethodCredential(item, provider)))
            setAdding(true);
        }
      })
      .catch(() => {
        if (current) {
          setError(S.loadFailed);
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [provider, revision]);
  const choices = items.filter((item) => isMethodCredential(item, provider));
  const credential = choices.find(
    (item) => item.id === selected?.id && item.revision === selected.revision,
  );
  const blocked = disabled || busy || !!source || loading || !!error;
  const save = async () => {
    if (blocked || !label.trim() || !key.trim()) return;
    const release = onAcquire();
    if (!release) return;
    const ticket = ++owner.current;
    setBusy(true);
    setNote(null);
    try {
      const result = await authKeySave({
        agentId,
        methodId,
        cwd,
        source,
        expectedProvider: provider,
        label: label.trim(),
        key,
      });
      if (ticket !== owner.current) return;
      setItems((records) => [
        ...records.filter((item) => item.id !== result.id),
        result,
      ]);
      setSelected({ id: result.id, revision: result.revision });
      setLabel("");
      setKey("");
      setAdding(false);
      setNote(S.saved);
    } catch {
      if (ticket === owner.current) setNote(S.failed);
    } finally {
      release();
      if (ticket === owner.current) setBusy(false);
    }
  };
  const begin = () => {
    if (!blocked && credential)
      onStart({ id: credential.id, revision: credential.revision });
  };
  useAccessPrimary(
    {
      id: JSON.stringify([
        agentId,
        methodId,
        provider,
        cwd,
        source,
        adding ? "save" : "verify",
        credential?.id,
        credential?.revision,
      ]),
      label: adding ? (busy ? STRINGS.credentials.saving : S.save) : startLabel,
      disabled:
        blocked || (adding ? !label.trim() || !key.trim() : !credential),
      run: adding ? () => void save() : begin,
    },
    onPrimaryChange,
  );
  return (
    <section
      className="agent-method-key"
      aria-label={STRINGS.credentials.secret}
    >
      {!adding && (
        <>
          <label htmlFor={selectId} className="auth-note">
            {S.savedKey}
          </label>
          <select
            id={selectId}
            className="custom-input"
            value={credential?.id ?? ""}
            disabled={blocked}
            onChange={(event) => {
              const item = choices.find(
                (choice) => choice.id === event.target.value,
              );
              setSelected(
                item ? { id: item.id, revision: item.revision } : null,
              );
              setNote(null);
            }}
          >
            <option value="">{choices.length ? S.chooseKey : S.noKeys}</option>
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </>
      )}
      {selected && !credential && (
        <p className="auth-note" role="status">
          {S.changed}
        </p>
      )}
      {error && (
        <div role="alert">
          {error}
          <button
            className="btn btn-text"
            onClick={() => refresh((value) => value + 1)}
          >
            {STRINGS.service.retry}
          </button>
        </div>
      )}
      {!adding && (
        <button
          className="btn btn-ghost"
          disabled={blocked}
          onClick={() => setAdding(true)}
        >
          {S.add}
        </button>
      )}
      {adding && (
        <div>
          <label className="auth-note" htmlFor={labelId}>
            {S.label}
          </label>
          <input
            id={labelId}
            className="custom-input"
            value={label}
            placeholder={S.labelHint}
            disabled={blocked}
            onChange={(event) => setLabel(event.target.value)}
          />
          <label className="auth-note" htmlFor={keyId}>
            {STRINGS.credentials.secret}
          </label>
          <input
            id={keyId}
            className="custom-input"
            type="password"
            autoComplete="off"
            aria-describedby={hintId}
            value={key}
            disabled={blocked}
            onChange={(event) => setKey(event.target.value)}
          />
          <div className="auth-actions">
            {!onPrimaryChange && (
              <button
                className="btn btn-ghost"
                disabled={blocked || !label.trim() || !key.trim()}
                onClick={() => void save()}
              >
                {busy ? STRINGS.credentials.saving : S.save}
              </button>
            )}
            <button
              className="btn btn-text"
              disabled={busy}
              onClick={() => {
                setKey("");
                setLabel("");
                setAdding(false);
                setNote(null);
              }}
            >
              {STRINGS.access.cancel}
            </button>
          </div>
        </div>
      )}
      <p id={hintId} className="auth-note agent-field-hint">
        {S.hint}
      </p>
      {note && (
        <p className="auth-note" role="status">
          {note}
        </p>
      )}
      {!adding && !onPrimaryChange && (
        <button
          className="btn btn-primary"
          disabled={blocked || !credential}
          onClick={begin}
        >
          {startLabel}
        </button>
      )}
    </section>
  );
}
