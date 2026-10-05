import { useEffect, useId, useRef, useState, type RefObject } from "react";
import {
  CaretDown,
  Eye,
  EyeSlash,
  Key,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";
import type { AgentCardModel } from "../runtime/agents";
import {
  ApiRequestScope,
  deleteCredential,
  fetchApiModels,
  getServiceCapabilities,
  listCredentials,
  preservesLegacyService,
  revokeCredential,
  saveCredential,
  type Credential,
  type CredentialInput,
  type ServiceCapability,
} from "../runtime/credentials";
import { uiError } from "../runtime/ui_error";
import { STRINGS } from "../runtime/strings";
import { ApiTestPanel } from "./ApiTestPanel";
import { AgentLogo } from "./AgentLogo";
import { ACCESS_STRINGS as A } from "../runtime/access_strings";
import { API_EDITOR_STRINGS as E } from "../runtime/api_editor_strings";
import {
  credentialDraft,
  credentialDraftForSave,
  credentialDraftChanged,
  credentialEndpointIssue,
  credentialKeyIssue,
  credentialSaveIssue,
  modelCandidates,
  validCredentialModel,
} from "../runtime/credential_editor";
import "../api-settings.css";
import {
  credentialImpact,
  useStoredConversationIndex,
} from "../runtime/conversation_impacts";
import { CREDENTIAL_IMPACT_STRINGS as I } from "../runtime/credential_impact_strings";
import { ACCOUNT_GUIDE_STRINGS as G } from "../runtime/account_guide_strings";
import { ApiAccountGuide } from "./ApiAccountGuide";
const S = STRINGS.credentials;
const formats = Object.entries(S.formats);
const isFormat = (value: string) => formats.some(([id]) => id === value);
const formatName = (value: string) =>
  formats.find(([id]) => id === value)?.[1] ?? value;
const normalizedEndpoint = (value: string) => value.trim().replace(/\/+$/, "");
type Capability = { card: AgentCardModel; capability: ServiceCapability };

function Dialog({
  title,
  busy,
  onClose,
  children,
  compact = false,
  active = true,
  returnFocusRef,
  fallbackFocusRef,
}: {
  active?: boolean;
  compact?: boolean;
  title: string;
  busy: boolean;
  onClose: (opener?: HTMLElement) => void;
  children: React.ReactNode;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = ref.current;
    const previous = returnFocusRef?.current ?? document.activeElement;
    if (active) element?.showModal();
    else element?.close();
    if (active)
      element
        ?.querySelector<HTMLInputElement>(
          'input:not([disabled]):not([type="hidden"])',
        )
        ?.focus();
    return () => {
      element?.close();
      // Wait until nested discard dialogs have also closed before returning
      // focus. A newly opened dialog or hidden Settings page keeps ownership.
      queueMicrotask(() => {
        const target =
          previous instanceof HTMLElement && previous.isConnected
            ? previous
            : fallbackFocusRef?.current;
        if (
          !(target instanceof HTMLElement) ||
          !target.isConnected ||
          target.closest("[hidden], [inert]") ||
          !target.getClientRects().length
        )
          return;
        const modal = Array.from(
          document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
        );
        if (modal.some((dialog) => !dialog.contains(target))) return;
        target.focus();
      });
    };
  }, [active]);
  return (
    <dialog
      className={`api-dialog${compact ? " api-dialog-compact" : ""}`}
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="api-icon-button"
          aria-label={S.close}
          disabled={busy}
          onClick={(event) => onClose(event.currentTarget)}
        >
          <X size={22} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

function Editor({
  item,
  onClose,
  onSaved,
  active,
  returnFocusRef,
  fallbackFocusRef,
}: {
  active: boolean;
  item: Credential | null;
  onClose: () => void;
  onSaved: (value: Credential) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const [original] = useState(() => credentialDraft(item));
  const [draft, setDraft] = useState<CredentialInput>(() =>
    credentialDraft(item),
  );
  const [guide, setGuide] = useState<"provider" | "prepare" | null>(null);
  const guideTrigger = useRef<HTMLButtonElement | null>(null);
  const guideWasOpen = useRef(false);
  useEffect(() => {
    if (!guide && guideWasOpen.current) guideTrigger.current?.focus();
    guideWasOpen.current = guide !== null;
  }, [guide]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const cancelTrigger = useRef<HTMLButtonElement | null>(null);
  const discardReturn = useRef<HTMLElement | null>(null);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [modelInput, setModelInput] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  const modelErrorId = useId();
  const showModelError = (message: string) => {
    setModelError(message);
    modelRef.current?.focus();
    modelRef.current?.scrollIntoView({ block: "center" });
  };
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const savePending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [cancellingRead, setCancellingRead] = useState(false);
  const fetchTicket = useRef(0);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [fetchScope] = useState(() => new ApiRequestScope());
  // Returning to an earlier source is not renewed consent to use its key.
  const [keySourceChanged, setKeySourceChanged] = useState(false);
  const [endpointTouched, setEndpointTouched] = useState(false);
  const endpointHintId = useId();
  const endpointErrorId = useId();
  const saveHintId = useId();
  const sameSavedSource =
    item != null &&
    normalizedEndpoint(draft.endpoint) === normalizedEndpoint(item.endpoint) &&
    draft.apiType === item.apiType;
  const retainingKey = sameSavedSource && !keySourceChanged;
  const endpointIssue = credentialEndpointIssue(draft.endpoint);
  const showEndpointIssue =
    !!endpointIssue && (endpointTouched || !!draft.endpoint.length);
  const ready =
    !endpointIssue &&
    isFormat(draft.apiType) &&
    !credentialKeyIssue(draft.key, retainingKey);
  const preservingLegacy =
    preservesLegacyService(item, draft) &&
    (!keySourceChanged || draft.key.trim() !== "");
  const saveIssue = credentialSaveIssue(draft, {
    retainingKey,
    preservingLegacy,
    pendingModel: modelInput,
  });
  const affectsExisting =
    item != null &&
    (!sameSavedSource ||
      item.models.some((model) => !draft.models.includes(model)));
  const change = <K extends keyof CredentialInput>(
    key: K,
    value: CredentialInput[K],
  ) => {
    const sourceChanged =
      (key === "endpoint" &&
        normalizedEndpoint(String(value)) !==
          normalizedEndpoint(draft.endpoint)) ||
      (key === "apiType" && value !== draft.apiType);
    fetchScope.invalidate();
    fetchTicket.current++;
    setCancellingRead(false);
    setFetching(false);
    setFetchNote(null);
    if (key === "endpoint" || key === "apiType" || key === "key") {
      setFetchedModels(null);
      setSelectedModels([]);
    }
    if (sourceChanged && (item != null || draft.key !== ""))
      setKeySourceChanged(true);
    setDraft((previous) => ({
      ...previous,
      [key]: value,
      ...(sourceChanged ? { key: "" } : {}),
    }));
    setRevision((value) => value + 1);
    setError(null);
  };
  useEffect(() => () => fetchScope.invalidate(), [fetchScope]);
  const addModel = () => {
    const value = modelInput.trim();
    if (!validCredentialModel(value)) {
      showModelError(E.modelInvalid);
      return;
    }
    setModelError(null);
    change("models", [...new Set([...draft.models, value])]);
    setModelInput("");
  };
  const fetchModels = () => {
    if (!ready || fetching || saving) return;
    setFetching(true);
    fetchTicket.current++;
    setFetchNote(null);
    void fetchScope.run(
      (requestId) =>
        fetchApiModels({
          requestId,
          source: { kind: "draft", input: draft },
          model: null,
        }),
      (result) => {
        setFetching(false);
        setFetchNote(result.message);
        if (result.status === "success") {
          setFetchedModels([...new Set(result.models)]);
          setSelectedModels([]);
          setModelQuery("");
        }
      },
      (reason) => {
        setFetching(false);
        setFetchNote(uiError(reason, S.testFailed));
      },
    );
  };
  const cancelRead = async () => {
    if (!fetching || cancellingRead) return;
    const ticket = fetchTicket.current;
    setCancellingRead(true);
    try {
      const confirmed = await fetchScope.cancel();
      if (fetchTicket.current !== ticket) return;
      if (confirmed) {
        fetchScope.invalidate();
        setFetching(false);
      } else setFetchNote(S.cancelFailed);
    } catch {
      if (fetchTicket.current === ticket) setFetchNote(S.cancelFailed);
    } finally {
      if (fetchTicket.current === ticket) setCancellingRead(false);
    }
  };
  const save = async () => {
    if (savePending.current || saveIssue) return;
    const input = credentialDraftForSave(draft, modelInput);
    if (!input) {
      showModelError(A.pendingModel);
      return;
    }
    savePending.current = true;
    setSaving(true);
    setError(null);
    fetchScope.invalidate();
    setFetching(false);
    try {
      onSaved(await saveCredential(input));
    } catch (reason) {
      savePending.current = false;
      setError(uiError(reason, S.failed));
      setSaving(false);
    }
  };
  const requestClose = (opener?: HTMLElement) => {
    if (savePending.current) return;
    if (credentialDraftChanged(draft, original, modelInput)) {
      discardReturn.current =
        opener ??
        (document.activeElement instanceof HTMLElement &&
        document.activeElement.closest(".api-dialog")
          ? document.activeElement
          : cancelTrigger.current);
      setConfirmDiscard(true);
    } else onClose();
  };
  const candidates = modelCandidates(
    fetchedModels ?? [],
    draft.models,
    modelQuery,
  );
  if (guide)
    return (
      <Dialog
        compact
        active={active}
        title={guide === "provider" ? G.selectApi : G.apiTitle}
        busy={false}
        returnFocusRef={returnFocusRef}
        fallbackFocusRef={fallbackFocusRef}
        onClose={() => setGuide(null)}
      >
        <ApiAccountGuide
          stage={guide}
          provider={draft.provider}
          onProvider={(value) => change("provider", value)}
          onContinue={() => {
            if (draft.provider.trim()) setGuide("prepare");
          }}
          onReturn={() => setGuide(null)}
        />
      </Dialog>
    );
  return (
    <>
      <Dialog
        active={active}
        title={item ? S.editTitle : S.createTitle}
        busy={saving}
        returnFocusRef={returnFocusRef}
        fallbackFocusRef={fallbackFocusRef}
        onClose={requestClose}
      >
        <div className="api-dialog-body">
          <p className="api-muted">{S.formHint}</p>
          <div className="api-account-help">
            <button
              ref={guideTrigger}
              className="btn btn-ghost"
              disabled={saving}
              onClick={() => {
                if (savePending.current) return;
                fetchScope.invalidate();
                setFetching(false);
                setGuide(draft.provider.trim() ? "prepare" : "provider");
              }}
            >
              {E.accountHelp}
            </button>
            <p>{E.accountHint}</p>
          </div>
          {item && !item.complete && (
            <p role="status" className="api-muted">
              {S.legacyEditHint}
            </p>
          )}
          {affectsExisting && (
            <p role="status" className="api-muted">
              {S.editImpact}
            </p>
          )}
          <fieldset disabled={saving}>
            <div className="api-field-grid">
              <label className="api-field">
                <span>{S.label}</span>
                <input
                  autoFocus
                  value={draft.label}
                  onChange={(event) => change("label", event.target.value)}
                  placeholder={S.labelPlaceholder}
                  maxLength={160}
                />
              </label>
              <label className="api-field">
                <span>{S.provider}</span>
                <input
                  value={draft.provider}
                  onChange={(event) => change("provider", event.target.value)}
                  placeholder={S.providerPlaceholder}
                  maxLength={160}
                />
              </label>
              <label className="api-field api-field-wide">
                <span>{S.endpoint}</span>
                <input
                  type="url"
                  value={draft.endpoint}
                  aria-invalid={showEndpointIssue || undefined}
                  aria-describedby={
                    showEndpointIssue
                      ? `${endpointHintId} ${endpointErrorId}`
                      : endpointHintId
                  }
                  onBlur={() => setEndpointTouched(true)}
                  onChange={(event) => change("endpoint", event.target.value)}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                  autoCapitalize="off"
                />
                <small id={endpointHintId}>{S.endpointHint}</small>
                {showEndpointIssue && (
                  <span
                    id={endpointErrorId}
                    className="api-field-error"
                    aria-live="polite"
                  >
                    {endpointIssue}
                  </span>
                )}
              </label>
              <label className="api-field">
                <span>{S.apiType}</span>
                <span className="api-select-wrap">
                  <select
                    value={draft.apiType}
                    onChange={(event) => change("apiType", event.target.value)}
                  >
                    {!isFormat(draft.apiType) && (
                      <option value={draft.apiType}>{S.needsSetup}</option>
                    )}
                    {formats.map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <CaretDown size={14} aria-hidden="true" />
                </span>
                <small>{S.formatHint}</small>
              </label>
              <label className="api-field">
                <span>{S.secret}</span>
                <div className="api-secret">
                  <input
                    type={showKey ? "text" : "password"}
                    value={draft.key}
                    onChange={(event) => change("key", event.target.value)}
                    placeholder={
                      retainingKey ? S.keepSecret : S.secretPlaceholder
                    }
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                  />
                  <button
                    type="button"
                    className="api-icon-button"
                    onClick={() => setShowKey((value) => !value)}
                    aria-label={showKey ? S.hideKey : S.showKey}
                  >
                    {showKey ? <EyeSlash size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                {keySourceChanged && !draft.key.trim() && (
                  <small>{S.changedSource}</small>
                )}
              </label>
            </div>
            <section className="api-model-editor" aria-label={S.models}>
              <div className="api-section-heading">
                <h3>
                  {S.models}{" "}
                  <span className="api-model-count">{draft.models.length}</span>
                </h3>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={cancellingRead || (!ready && !fetching)}
                  onClick={() => {
                    if (fetching) void cancelRead();
                    else fetchModels();
                  }}
                >
                  {cancellingRead
                    ? S.cancelling
                    : fetching
                      ? E.cancelRead
                      : S.fetchModels}
                </button>
              </div>
              <p className="api-muted">{S.modelsHint}</p>
              <div className="api-model-input">
                <input
                  ref={modelRef}
                  aria-invalid={!!modelError}
                  aria-describedby={modelError ? modelErrorId : undefined}
                  aria-label={S.modelPlaceholder}
                  placeholder={S.modelPlaceholder}
                  value={modelInput}
                  maxLength={256}
                  onChange={(event) => {
                    setModelInput(event.target.value);
                    setModelError(null);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault();
                      addModel();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!modelInput.trim()}
                  onClick={addModel}
                >
                  {S.addModel}
                </button>
              </div>
              {modelError && (
                <p role="alert" id={modelErrorId} className="api-error">
                  {modelError}
                </p>
              )}
              <div className="api-model-tags">
                {draft.models.map((model) => (
                  <span key={model}>
                    {model}
                    <button
                      type="button"
                      className="api-icon-button"
                      aria-label={`${S.removeModel} ${model}`}
                      onClick={() =>
                        change(
                          "models",
                          draft.models.filter((value) => value !== model),
                        )
                      }
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
              {!draft.models.length && (
                <p className="api-muted">{S.noModels}</p>
              )}
              {fetchNote && (
                <p role="status" className="api-muted">
                  {fetchNote}
                </p>
              )}
              {fetchedModels !== null && (
                <div className="api-model-catalog">
                  <div className="api-section-heading">
                    <strong>{A.fetchedModels(fetchedModels.length)}</strong>
                    <button
                      type="button"
                      className="btn btn-text"
                      onClick={() => setFetchedModels(null)}
                    >
                      {A.closeList}
                    </button>
                  </div>
                  <input
                    aria-label={A.searchModels}
                    placeholder={A.searchModels}
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                  <div className="api-model-candidates">
                    {candidates.map((model) => (
                      <label key={model}>
                        <input
                          type="checkbox"
                          checked={selectedModels.includes(model)}
                          onChange={(event) =>
                            setSelectedModels((previous) =>
                              event.target.checked
                                ? [...previous, model]
                                : previous.filter((value) => value !== model),
                            )
                          }
                        />
                        <span>{model}</span>
                      </label>
                    ))}
                    {!candidates.length && (
                      <p className="api-muted">{A.noModelCandidates}</p>
                    )}
                  </div>
                  <div className="api-model-selection">
                    <small>{E.modelScope}</small>
                    <button
                      type="button"
                      className="btn btn-text"
                      disabled={!candidates.length}
                      onClick={() =>
                        setSelectedModels((previous) => [
                          ...new Set([...previous, ...candidates]),
                        ])
                      }
                    >
                      {A.selectVisible}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!selectedModels.length}
                      onClick={() => {
                        change("models", [
                          ...new Set([
                            ...draft.models,
                            ...selectedModels.filter((model) =>
                              fetchedModels.includes(model),
                            ),
                          ]),
                        ]);
                        setSelectedModels([]);
                        setFetchedModels(null);
                      }}
                    >
                      {A.addSelectedModels(selectedModels.length)}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </fieldset>
          <ApiTestPanel
            source={{ kind: "draft", input: draft }}
            models={draft.models}
            contextKey={String(revision)}
            disabled={!ready || saving}
          />
          {error && (
            <p role="alert" className="api-error">
              {error}
            </p>
          )}
        </div>
        <footer className="api-editor-footer">
          <span
            id={saveHintId}
            className="api-save-feedback"
            aria-live="polite"
          >
            {saveIssue && <span>{saveIssue}</span>}
            <small>{E.noTestRequired}</small>
          </span>
          <button
            type="button"
            ref={cancelTrigger}
            className="btn btn-ghost"
            disabled={saving}
            onClick={(event) => requestClose(event.currentTarget)}
          >
            {S.cancel}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !!saveIssue}
            aria-describedby={saveHintId}
            onClick={() => void save()}
          >
            {saving ? S.saving : S.save}
          </button>
        </footer>
      </Dialog>
      {confirmDiscard && (
        <Dialog
          active={active}
          title={A.discardTitle}
          busy={false}
          compact
          returnFocusRef={discardReturn}
          onClose={() => setConfirmDiscard(false)}
        >
          <div className="api-dialog-body">
            <p className="api-muted">{A.discardHint}</p>
          </div>
          <footer>
            <button
              className="btn btn-ghost"
              onClick={() => setConfirmDiscard(false)}
            >
              {S.cancel}
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              {A.discardChanges}
            </button>
          </footer>
        </Dialog>
      )}
    </>
  );
}

function LegacyGrants({
  item,
  cards,
  onChanged,
}: {
  item: Credential;
  cards: AgentCardModel[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!item.grants.length) return null;
  const revoke = async (agentId: string, envName: string) => {
    if (busy) return;
    setBusy(`${agentId}:${envName}`);
    setError(null);
    try {
      await revokeCredential(item.id, agentId, envName);
      onChanged();
    } catch (reason) {
      setError(uiError(reason, S.failed));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="api-legacy-grants" aria-label={S.legacyGrants}>
      <p>{S.legacyHint}</p>
      <ul>
        {item.grants.map((grant) => (
          <li key={`${grant.agentId}:${grant.envName}`}>
            <span>
              {cards.find((card) => card.id === grant.agentId)?.name ??
                S.unknownAgent}{" "}
              · {grant.envName}
            </span>
            <button
              className="btn btn-ghost"
              disabled={busy != null}
              onClick={() => void revoke(grant.agentId, grant.envName)}
            >
              {busy === `${grant.agentId}:${grant.envName}`
                ? S.revoking
                : S.revoke}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="api-error">
          {error}
        </p>
      )}
    </section>
  );
}

export function CredentialSettings({
  cards,
  active = true,
}: {
  cards: AgentCardModel[];
  active?: boolean;
}) {
  const [items, setItems] = useState<Credential[]>([]);
  const addTrigger = useRef<HTMLButtonElement | null>(null);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const deleteTrigger = useRef<HTMLElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ item: Credential | null } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<Credential | null>(null);
  const impactIndex = useStoredConversationIndex(deleting?.id ?? null);
  const impact =
    deleting && impactIndex.rows
      ? credentialImpact(impactIndex.rows, deleting.id)
      : null;
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [testId, setTestId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [capabilities, setCapabilities] = useState<Capability[] | null>(null);
  const lifetime = useRef(0);
  const load = () => {
    const request = ++lifetime.current;
    setLoading(true);
    setError(null);
    void listCredentials()
      .then((value) => {
        if (lifetime.current === request) setItems(value);
      })
      .catch((reason) => {
        if (lifetime.current === request)
          setError(uiError(reason, S.readFailed));
      })
      .finally(() => {
        if (lifetime.current === request) setLoading(false);
      });
  };
  useEffect(() => {
    load();
    return () => {
      lifetime.current += 1;
    };
  }, []);
  const cardKey = cards.map((card) => `${card.id}:${card.name}`).join("\n");
  useEffect(() => {
    let active = true;
    void Promise.allSettled(
      cards.map(async (card) => ({
        card,
        capability: await getServiceCapabilities(card.id),
      })),
    )
      .then((value) => {
        if (active) {
          const available = value.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          );
          setCapabilities(available.length || !cards.length ? available : null);
        }
      })
      .catch(() => {
        if (active) setCapabilities(null);
      });
    return () => {
      active = false;
    };
    // Recheck when registrations change, not on every status update.
  }, [cardKey]);
  const remove = async () => {
    if (!deleting || deleteBusy || !impact || impactIndex.error) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteCredential(deleting.id);
      setItems((current) => current.filter((item) => item.id !== deleting.id));
      setDeleting(null);
    } catch (reason) {
      setDeleteError(uiError(reason, S.failed));
      load();
    } finally {
      setDeleteBusy(false);
    }
  };
  const search = query.trim().toLocaleLowerCase();
  const filteredItems = items.filter((item) =>
    `${item.label} ${item.provider} ${item.models.join(" ")}`
      .toLocaleLowerCase()
      .includes(search),
  );
  return (
    <section className="api-settings" hidden={!active}>
      <div className="api-page-heading">
        <div>
          <h1>{S.heading}</h1>
          <p>{S.description}</p>
        </div>
        <button
          ref={addTrigger}
          className="btn btn-primary"
          onClick={(event) => {
            editorTrigger.current = event.currentTarget;
            setEditor({ item: null });
          }}
        >
          <Plus size={16} />
          {S.add}
        </button>
      </div>
      {(items.length > 2 || query !== "") && (
        <div className="api-search">
          <MagnifyingGlass size={17} aria-hidden="true" />
          <input
            type="search"
            aria-label={S.search}
            placeholder={S.searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="api-icon-button"
              aria-label={S.clearSearch}
              onClick={() => setQuery("")}
            >
              <X size={16} />
            </button>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="api-page-message">
          <span>{error}</span>
          <button className="btn btn-ghost" onClick={load}>
            {S.retry}
          </button>
        </div>
      )}
      {loading && (
        <p role="status" className="api-muted">
          {S.loading}
        </p>
      )}
      {!loading && !error && !items.length && (
        <div className="api-empty">
          <Key size={32} />
          <h3>{G.apiEmpty}</h3>
          <p>{G.apiEmptyHint}</p>
          <button
            className="btn btn-primary"
            onClick={(event) => {
              editorTrigger.current = event.currentTarget;
              setEditor({ item: null });
            }}
          >
            <Plus size={16} />
            {G.apiAdd}
          </button>
        </div>
      )}
      {!loading && !error && !!items.length && !filteredItems.length && (
        <div className="api-empty" role="status">
          <MagnifyingGlass size={32} />
          <h3>{S.noSearchResults}</h3>
          <p>{S.searchHint}</p>
          <button className="btn btn-ghost" onClick={() => setQuery("")}>
            {S.clearSearch}
          </button>
        </div>
      )}
      <div className="api-records">
        {filteredItems.map((item) => {
          const authenticationKey = item.purpose === "authentication";
          const complete = item.complete;
          const compatible = capabilities
            ?.filter(({ capability }) =>
              capability.apiTypes.includes(item.apiType),
            )
            .map(({ card }) => card);
          return (
            <article className="api-record" key={item.id}>
              <div className="api-record-top">
                <div className="api-record-icon">
                  <Key size={22} />
                </div>
                <div className="api-record-title">
                  <h3>{item.label}</h3>
                  <p>
                    {[
                      item.provider === "other"
                        ? S.customProvider
                        : item.provider,
                      authenticationKey
                        ? S.authenticationKey
                        : formatName(item.apiType),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <span className={`api-state ${item.deleting ? "failed" : ""}`}>
                  {item.deleting
                    ? S.deletePending
                    : authenticationKey || complete
                      ? S.saved
                      : S.needsSetup}
                </span>
              </div>
              {!authenticationKey && (
                <>
                  <p className="api-base-url">{item.endpoint}</p>
                  <div className="api-model-tags">
                    {item.models.map((model) => (
                      <span key={model}>{model}</span>
                    ))}
                  </div>
                </>
              )}
              <p className="api-compatibility">
                {authenticationKey ? (
                  S.authenticationKeyHint
                ) : !complete ? (
                  S.incompleteHint
                ) : compatible == null ? (
                  S.capabilityFailed
                ) : compatible.length ? (
                  <>
                    {S.compatible}
                    {compatible.map((card) => (
                      <span key={card.id} className="api-compatible-agent">
                        <AgentLogo card={card} />
                        {card.name}
                      </span>
                    ))}
                  </>
                ) : (
                  S.noCompatible
                )}
              </p>
              <div className="api-record-actions">
                {!authenticationKey && (
                  <>
                    <button
                      className="btn btn-ghost"
                      disabled={item.deleting}
                      onClick={(event) => {
                        editorTrigger.current = event.currentTarget;
                        setTestId(null);
                        setEditor({ item });
                      }}
                    >
                      {S.edit}
                    </button>
                    <button
                      className="btn btn-ghost"
                      disabled={item.deleting || !complete}
                      aria-expanded={testId === item.id}
                      onClick={() =>
                        setTestId((current) =>
                          current === item.id ? null : item.id,
                        )
                      }
                    >
                      {S.test}
                      <CaretDown size={13} aria-hidden="true" />
                    </button>
                  </>
                )}
                <button
                  className="btn btn-ghost api-delete"
                  onClick={(event) => {
                    deleteTrigger.current = event.currentTarget;
                    setTestId(null);
                    setDeleteError(null);
                    setDeleting(item);
                  }}
                >
                  {item.deleting ? S.retry : S.delete}
                </button>
              </div>
              <LegacyGrants item={item} cards={cards} onChanged={load} />
              {!authenticationKey && testId === item.id && (
                <ApiTestPanel
                  source={{ kind: "saved", id: item.id }}
                  models={item.models}
                  contextKey={item.revision}
                />
              )}
            </article>
          );
        })}
      </div>
      <div className="api-page-explainer">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>
          <strong>{G.apiBoundary}</strong>
          <p>{G.apiBoundaryHint}</p>
        </div>
      </div>
      {editor && (
        <Editor
          active={active}
          item={editor.item}
          returnFocusRef={editorTrigger}
          fallbackFocusRef={addTrigger}
          onClose={() => setEditor(null)}
          onSaved={(item) => {
            setItems((current) =>
              current.some((value) => value.id === item.id)
                ? current.map((value) => (value.id === item.id ? item : value))
                : [...current, item],
            );
            setEditor(null);
          }}
        />
      )}
      {deleting && (
        <Dialog
          active={active}
          title={
            deleting.purpose === "authentication"
              ? S.confirmDeleteAuthenticationKey
              : S.confirmDelete
          }
          busy={deleteBusy}
          returnFocusRef={deleteTrigger}
          fallbackFocusRef={addTrigger}
          onClose={() => setDeleting(null)}
        >
          <div className="api-dialog-body">
            <h3>{deleting.label}</h3>
            <p className="api-muted">
              {deleting.purpose === "authentication"
                ? S.deleteAuthenticationKeyHint
                : S.deleteHint}
            </p>
            {!impact && !impactIndex.error && <p role="status">{I.loading}</p>}
            {impactIndex.error && (
              <div role="alert">
                <p>{I.failed}</p>
                <button className="btn btn-ghost" onClick={impactIndex.retry}>
                  {I.retry}
                </button>
              </div>
            )}
            {impact && (
              <section className="api-delete-impact">
                <h4>
                  {impact.affected.length
                    ? I.heading(impact.affected.length)
                    : I.empty}
                </h4>
                {impact.affected.length > 0 && (
                  <>
                    <p>{I.hint}</p>
                    <ul>
                      {impact.affected.map((row) => (
                        <li key={row.id}>
                          <span>{row.title || I.untitled}</span>
                          {row.archived && <small>{I.archived}</small>}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {impact.unknown > 0 && <p>{I.unknown(impact.unknown)}</p>}
              </section>
            )}
            {deleteError && (
              <p role="alert" className="api-error">
                {deleteError}
              </p>
            )}
          </div>
          <footer>
            <button
              className="btn btn-ghost"
              disabled={deleteBusy}
              onClick={() => setDeleting(null)}
            >
              {S.cancel}
            </button>
            <button
              className="btn api-danger"
              disabled={deleteBusy || !impact || impactIndex.error}
              onClick={() => void remove()}
            >
              {deleteBusy ? S.deleting : S.delete}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
