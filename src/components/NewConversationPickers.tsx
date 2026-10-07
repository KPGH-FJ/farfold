import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, Plus, X } from "@phosphor-icons/react";
import type { AgentCardModel } from "../runtime/agents";
import type { ConfigOptionView } from "../runtime/session_types";
import {
  getServiceCapabilities,
  listCredentials,
  subscribeCredentialChanges,
  type Credential,
  type ServiceCapability,
} from "../runtime/credentials";
import { uiError } from "../runtime/ui_error";
import { NEW_CONVERSATION_PICKER_STRINGS as S } from "../runtime/new_conversation_picker_strings";
import { ACCESS_STRINGS as A } from "../runtime/access_strings";
import { AgentLogo } from "./AgentLogo";
import { usableAgents } from "./AgentPick";
import type { ServiceChoice } from "./ServicePicker";
import "../new-conversation-pickers.css";

function PickerDialog({
  title,
  titleId,
  children,
  searchField,
  footer,
  busy = false,
  initialFocusRef,
  returnFocusRef,
  onClose,
}: {
  title: string;
  titleId: string;
  children: ReactNode;
  searchField?: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    // A pointer click on macOS need not focus its button. Keep the actual opener.
    const previous = returnFocusRef?.current ?? document.activeElement;
    element?.showModal();
    // React autoFocus runs before showModal, while the input is still hidden.
    initialFocusRef?.current?.focus();
    return () => {
      element?.close();
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !previous.closest("[hidden], [inert]") &&
        previous.getClientRects().length
      )
        previous.focus();
    };
  }, []);
  const content = (
    <dialog
      ref={dialog}
      className="new-choice-dialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label={S.close}
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      {searchField && <div className="new-choice-search">{searchField}</div>}
      <div className="new-choice-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  );
  // The composer moves into its prepared conversation without a React remount.
  // Moving an open native dialog removes its modal state, so keep its DOM host
  // stable while the opener and the preserved draft move between containers.
  return typeof document === "undefined"
    ? content
    : createPortal(content, document.body);
}

export function NewConversationAgentDialog({
  cards,
  picked,
  prepared,
  needsAuth,
  onPick,
  onPrepare,
  onClose,
  returnFocusRef,
}: {
  cards: AgentCardModel[];
  picked: string | null;
  prepared: (id: string) => boolean;
  needsAuth?: (id: string) => boolean;
  onPick: (id: string) => void;
  onPrepare: (id?: string) => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const visible = usableAgents(cards, prepared).filter((card) =>
    card.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <PickerDialog
      title={S.agentTitle}
      titleId="new-agent-choice-title"
      onClose={onClose}
      initialFocusRef={search}
      returnFocusRef={returnFocusRef}
    >
      <input
        ref={search}
        className="new-agent-search"
        aria-label={S.agentSearch}
        placeholder={S.agentSearchPlaceholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="new-agent-choices">
        {visible.map((card) => (
          <button
            key={card.id}
            type="button"
            aria-pressed={card.id === picked}
            onClick={() => {
              if (prepared(card.id)) onPick(card.id);
            }}
          >
            <AgentLogo card={card} />
            <span>
              <strong>{card.name}</strong>
              <small>
                {needsAuth?.(card.id)
                  ? A.needLogin
                  : card.status === "connected"
                    ? A.connected
                    : A.standby}
              </small>
            </span>
            {card.id === picked && <Check size={16} />}
          </button>
        ))}
        {!visible.length && (
          <div className="new-choice-empty">
            <strong>{S.agentEmpty}</strong>
            <p>{S.agentEmptyHint}</p>
          </div>
        )}
      </div>
      <button
        type="button"
        className="new-agent-discover"
        onClick={() => onPrepare()}
      >
        <Plus size={16} />
        {S.addAgent}
      </button>
    </PickerDialog>
  );
}

export interface NewConversationModelChoice {
  service: ServiceChoice | null;
  /** Only an existing-settings option, never an API model id. */
  modelValue: string | null;
}

export function NewConversationModelDialog({
  agent,
  value,
  existingOption,
  readingModels = false,
  onApply,
  onPrepare,
  onManageServices,
  onClose,
  returnFocusRef,
}: {
  agent: AgentCardModel;
  value: NewConversationModelChoice;
  existingOption: ConfigOptionView | null;
  readingModels?: boolean;
  onApply: (choice: NewConversationModelChoice) => Promise<void>;
  onPrepare: () => void;
  onManageServices?: () => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const selectedItem = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState<NewConversationModelChoice>(
    () => ({
      service: value.service ? { ...value.service } : null,
      modelValue: value.modelValue,
    }),
  );
  const [records, setRecords] = useState<Credential[]>([]);
  const [capability, setCapability] = useState<ServiceCapability | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [revision, refresh] = useState(0);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const saving = useRef(false);
  const edited = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => subscribeCredentialChanges(() => refresh((v) => v + 1)), []);
  useEffect(() => {
    if (
      !edited.current &&
      !value.service &&
      typeof existingOption?.currentValue === "string"
    )
      setSelection({ service: null, modelValue: existingOption.currentValue });
  }, [existingOption?.currentValue]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError(false);
    void Promise.all([listCredentials(), getServiceCapabilities(agent.id)])
      .then(([items, info]) => {
        if (!current) return;
        setRecords(items);
        setCapability(info);
      })
      .catch(() => {
        if (current) setLoadError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [agent.id, revision]);
  const services = records.filter(
    (item) =>
      !item.deleting &&
      item.complete &&
      item.models.length > 0 &&
      capability?.apiTypes.includes(item.apiType),
  );
  const options =
    existingOption?.type === "select" ? existingOption.options : [];
  const term = query.trim().toLocaleLowerCase();
  const matches = (...values: string[]) =>
    !term || values.some((text) => text.toLocaleLowerCase().includes(term));
  const visibleOptions = options.filter((model) =>
    matches(model.name, model.value, S.existingTitle(agent.name)),
  );
  const visibleServices = services
    .map((item) => ({
      ...item,
      models: item.models.filter((model) => matches(model, item.label)),
    }))
    .filter((item) => item.models.length > 0);
  const showCurrent =
    options.length === 0 &&
    matches(S.currentModel, S.existingTitle(agent.name));
  useEffect(() => {
    if (!query.trim())
      selectedItem.current?.scrollIntoView({ block: "nearest" });
  }, [query, loading, readingModels, existingOption, selection]);
  const issue = selection.service
    ? loading || loadError
      ? loading
        ? S.loadingServices
        : S.loadFailed
      : services.some(
            (item) =>
              item.id === selection.service!.id &&
              item.revision === selection.service!.revision &&
              item.models.includes(selection.service!.model),
          )
        ? null
        : S.serviceChanged
    : readingModels
      ? S.readingModels
      : selection.modelValue !== null &&
          !options.some((item) => item.value === selection.modelValue)
        ? S.modelChanged
        : null;
  const choose = (next: NewConversationModelChoice) => {
    if (saving.current) return;
    edited.current = true;
    setSelection(next);
    setError(null);
  };
  const apply = async () => {
    if (issue || saving.current) return;
    saving.current = true;
    setApplying(true);
    setError(null);
    try {
      await onApply(selection);
      if (live.current) onClose();
    } catch (reason) {
      if (live.current) setError(uiError(reason, S.applyFailed));
    } finally {
      saving.current = false;
      if (live.current) setApplying(false);
    }
  };
  return (
    <PickerDialog
      title={S.modelTitle}
      titleId="new-model-choice-title"
      busy={applying}
      initialFocusRef={search}
      returnFocusRef={returnFocusRef}
      searchField={
        <input
          ref={search}
          className="new-agent-search"
          aria-label={S.modelSearch}
          placeholder={S.modelSearchPlaceholder}
          value={query}
          disabled={applying}
          onChange={(event) => setQuery(event.target.value)}
        />
      }
      onClose={() => {
        if (!saving.current) onClose();
      }}
      footer={
        <>
          <button
            type="button"
            className="btn btn-text"
            disabled={applying}
            onClick={onPrepare}
          >
            {S.prepare}
          </button>
          {onManageServices && (
            <button
              type="button"
              className="btn btn-text"
              disabled={applying}
              onClick={onManageServices}
            >
              {S.manageServices}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={applying || !!issue}
            onClick={() => void apply()}
          >
            {applying ? S.applying : S.useModel}
          </button>
        </>
      }
    >
      <div className="new-model-groups">
        <h3>{S.existingTitle(agent.name)}</h3>
        <p>{S.existingHint}</p>
        {options.length ? (
          visibleOptions.map((model) => (
            <button
              key={model.value}
              ref={
                !selection.service && selection.modelValue === model.value
                  ? selectedItem
                  : undefined
              }
              type="button"
              aria-pressed={
                !selection.service && selection.modelValue === model.value
              }
              className={
                !selection.service && selection.modelValue === model.value
                  ? "selected"
                  : ""
              }
              disabled={applying}
              onClick={() => choose({ service: null, modelValue: model.value })}
            >
              <span>{model.name}</span>
              {!selection.service && selection.modelValue === model.value && (
                <Check size={16} />
              )}
            </button>
          ))
        ) : (
          <>
            {showCurrent && (
              <button
                ref={
                  !selection.service && selection.modelValue === null
                    ? selectedItem
                    : undefined
                }
                type="button"
                aria-pressed={
                  !selection.service && selection.modelValue === null
                }
                className={
                  !selection.service && selection.modelValue === null
                    ? "selected"
                    : ""
                }
                disabled={applying || readingModels}
                onClick={() => choose({ service: null, modelValue: null })}
              >
                <span>{S.currentModel}</span>
                {!selection.service && selection.modelValue === null && (
                  <Check size={16} />
                )}
              </button>
            )}
            {readingModels && <p role="status">{S.readingModels}</p>}
            {value.service && <p>{S.modelsAfterSource}</p>}
          </>
        )}
        <h3>{S.savedServices}</h3>
        {loading ? (
          <p role="status">{S.loadingServices}</p>
        ) : loadError ? (
          <p role="alert">
            {S.loadFailed}{" "}
            <button
              type="button"
              className="btn btn-text"
              onClick={() => refresh((v) => v + 1)}
            >
              {S.retry}
            </button>
          </p>
        ) : services.length ? (
          visibleServices.map((item) => (
            <section key={item.id}>
              <small>{item.label}</small>
              {item.models.map((model) => {
                const selected =
                  selection.service?.id === item.id &&
                  selection.service.model === model &&
                  selection.service.revision === item.revision;
                return (
                  <button
                    key={model}
                    ref={selected ? selectedItem : undefined}
                    type="button"
                    aria-pressed={selected}
                    className={selected ? "selected" : ""}
                    disabled={applying}
                    onClick={() =>
                      choose({
                        service: {
                          id: item.id,
                          revision: item.revision,
                          model,
                        },
                        modelValue: null,
                      })
                    }
                  >
                    <span>{model}</span>
                    {selected && <Check size={16} />}
                  </button>
                );
              })}
            </section>
          ))
        ) : (
          <p>
            {capability?.apiTypes.length
              ? S.noServices
              : capability?.unavailableReason || S.servicesUnavailable}
          </p>
        )}
        {term &&
          !loading &&
          !loadError &&
          !readingModels &&
          !visibleOptions.length &&
          !visibleServices.length &&
          !showCurrent && <p role="status">{S.modelEmpty}</p>}
        {issue && !loading && !readingModels && <p role="alert">{issue}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      <p className="new-choice-help">{S.fixedAfterSend}</p>
    </PickerDialog>
  );
}
