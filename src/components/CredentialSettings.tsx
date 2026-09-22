import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { authMethods, type AgentCardModel } from "../runtime/agents";
import {
  listCredentials,
  saveCredential,
  grantCredential,
  revokeCredential,
  deleteCredential,
  providerLinks,
  type Credential,
  type CredentialInput,
} from "../runtime/credentials";
import { STRINGS } from "../runtime/strings";
const S = STRINGS.credentials;
const blank: CredentialInput = {
  id: null,
  label: "",
  provider: "",
  endpoint: "",
  apiType: "",
  key: "",
};

function GrantForm({
  item,
  cards,
  busy,
  act,
}: {
  item: Credential;
  cards: AgentCardModel[];
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [agentId, setAgent] = useState("");
  const [envName, setEnv] = useState("");
  const [suggested, setSuggested] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    setEnv("");
    setConfirmed(false);
    setConflicts([]);
    setSuggested([]);
    if (agentId)
      void authMethods(agentId)
        .then((info) => {
          if (current)
            setSuggested(
              info.methods.flatMap((m) => (m.envName ? [m.envName] : [])),
            );
        })
        .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [agentId]);
  const grant = async (replace: boolean) => {
    let applied = false;
    const ok = await act(async () => {
      const result = await grantCredential(item.id, agentId, envName, replace);
      setConflicts(result.conflicts);
      applied = result.applied;
      return result.applied;
    });
    if (ok && applied) {
      setConfirmed(false);
      setConflicts([]);
    }
  };
  return (
    <div className="custom-form">
      <label>
        {S.target}
        <select
          className="custom-input"
          value={agentId}
          disabled={busy}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="">{S.chooseAgent}</option>
          {cards
            .filter((c) => c.status === "installed" || c.status === "connected")
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        {STRINGS.repair.envName}
        <input
          className="custom-input"
          value={envName}
          list={`env-${item.id}`}
          disabled={busy}
          onChange={(e) => {
            setEnv(e.target.value);
            setConfirmed(false);
            setConflicts([]);
          }}
          spellCheck={false}
        />
      </label>
      <datalist id={`env-${item.id}`}>
        {suggested.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <div className="auth-note">
        {suggested.length ? S.declared : S.explicit}
      </div>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(e) => {
            setConfirmed(e.target.checked);
            setConflicts([]);
          }}
        />
        {S.compatibility}
      </label>
      {conflicts.length > 0 && (
        <div role="alert">
          {S.conflict}：{conflicts.join("、")}。{S.restoreHint}
        </div>
      )}
      <button
        type="button"
        className="btn btn-ghost"
        disabled={
          busy ||
          !agentId ||
          !confirmed ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)
        }
        onClick={() => void grant(conflicts.length > 0)}
      >
        {conflicts.length ? S.replaceSource : S.authorize}
      </button>
    </div>
  );
}

export function CredentialSettings({ cards }: { cards: AgentCardModel[] }) {
  const [items, setItems] = useState<Credential[]>([]);
  const [form, setForm] = useState<CredentialInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setDelete] = useState<string | null>(null);
  const [grantFor, setGrantFor] = useState<string | null>(null);
  const refresh = async () => setItems(await listCredentials());
  useEffect(() => {
    void refresh().catch(() => setError(S.readFailed));
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const outcome = await fn();
      await refresh();
      if (outcome !== false) setNote(S.reconnectHint);
      return true;
    } catch {
      setError(S.failed);
      await refresh().catch(() => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!form) return;
    const ok = await act(() => saveCredential(form));
    setForm((prev) => (ok ? null : prev ? { ...prev, key: "" } : null));
  };
  return (
    <section className="credential-settings" aria-label={S.heading}>
      <div className="s-h">{S.heading}</div>
      <div className="s-sub">{S.description}</div>
      {error && (
        <div className="ac-error" role="alert">
          {error}
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(refresh)}
          >
            {STRINGS.common.retry}
          </button>
        </div>
      )}
      {note && (
        <div className="auth-note" role="status">
          {note}
        </div>
      )}
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        onClick={() => {
          setForm({ ...blank });
          setError(null);
        }}
      >
        {S.add}
      </button>
      {form && (
        <form
          className="agent-card custom-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            {S.label}
            <input
              autoFocus
              className="custom-input"
              value={form.label}
              disabled={busy}
              maxLength={300}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </label>
          <label>
            {S.provider}
            <select
              className="custom-input"
              value={form.provider}
              disabled={busy}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
            >
              <option value="">{S.unspecified}</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
              <option value="other">{S.other}</option>
            </select>
          </label>
          <label>
            {S.endpoint}
            <input
              type="url"
              className="custom-input"
              value={form.endpoint}
              disabled={busy}
              maxLength={300}
              placeholder="https://…"
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
            />
          </label>
          <label>
            {S.apiType}
            <input
              className="custom-input"
              value={form.apiType}
              disabled={busy}
              maxLength={300}
              onChange={(e) => setForm({ ...form, apiType: e.target.value })}
            />
          </label>
          <label>
            {S.secret}
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              className="custom-input"
              value={form.key}
              disabled={busy}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
          </label>
          {form.id && <div className="auth-note">{S.rotateHint}</div>}
          <div className="auth-note">{S.metadataHint}</div>
          <div className="ac-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !form.label.trim() || !form.key.trim()}
            >
              {busy ? S.saving : STRINGS.repair.saveKey}
            </button>
            <button
              type="button"
              className="btn btn-text"
              disabled={busy}
              onClick={() => setForm(null)}
            >
              {S.cancel}
            </button>
          </div>
        </form>
      )}
      {items.map((item) => (
        <div className="agent-card" key={item.id}>
          <div className="ac-head">
            <strong>{item.label}</strong>
          </div>
          <div className="ac-facts">
            {[item.provider, item.endpoint, item.apiType]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {item.deleting && <div role="alert">{S.deletePending}</div>}
          <div className="auth-note">
            {item.grants.length ? S.usedBy : S.noGrants}
          </div>
          {item.grants.map((g) => (
            <div className="ac-actions" key={`${g.agentId}:${g.envName}`}>
              <span>
                {cards.find((c) => c.id === g.agentId)?.name ?? g.agentId} ·{" "}
                {g.envName}
              </span>
              <button
                type="button"
                className="btn btn-text"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    revokeCredential(item.id, g.agentId, g.envName),
                  )
                }
              >
                {S.revoke}
              </button>
            </div>
          ))}
          <div className="ac-actions">
            {!item.deleting && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    setForm({ ...item, key: "" });
                    setGrantFor(null);
                  }}
                >
                  {S.rotate}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() =>
                    setGrantFor(grantFor === item.id ? null : item.id)
                  }
                >
                  {S.authorize}
                </button>
              </>
            )}
            <button
              type="button"
              className="btn btn-text"
              disabled={busy}
              onClick={() => {
                if (confirmDelete === item.id || item.deleting)
                  void act(() => deleteCredential(item.id)).then((ok) => {
                    if (ok) setDelete(null);
                  });
                else setDelete(item.id);
              }}
            >
              {item.deleting
                ? STRINGS.common.retry
                : confirmDelete === item.id
                  ? S.confirmDelete
                  : S.delete}
            </button>
            {confirmDelete === item.id && (
              <button
                type="button"
                className="btn btn-text"
                onClick={() => setDelete(null)}
              >
                {S.cancel}
              </button>
            )}
          </div>
          {confirmDelete === item.id && (
            <div className="auth-note">{S.deleteHint}</div>
          )}
          {grantFor === item.id && !item.deleting && (
            <GrantForm item={item} cards={cards} busy={busy} act={act} />
          )}
          {providerLinks[item.provider] && (
            <div className="ac-actions">
              <button
                type="button"
                className="btn btn-text"
                onClick={() =>
                  void openUrl(providerLinks[item.provider].api).catch(() =>
                    setError(S.linkFailed),
                  )
                }
              >
                {S.apiPortal}
              </button>
              {providerLinks[item.provider].subscription && (
                <button
                  type="button"
                  className="btn btn-text"
                  onClick={() =>
                    void openUrl(
                      providerLinks[item.provider].subscription!,
                    ).catch(() => setError(S.linkFailed))
                  }
                >
                  {S.subscription}
                </button>
              )}
              <span className="auth-note">{S.billingSeparate}</span>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
