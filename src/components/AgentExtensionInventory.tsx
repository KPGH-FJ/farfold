import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { extensionCapabilities } from "../runtime/extension_inventory";
import {
  extensionInventory,
  type InventoryOwner,
} from "../runtime/extension_inventory_controller";
import {
  extensionFailure,
  validInventoryDirectory,
  type ExtensionCapabilities,
  type ExtensionCode,
} from "../runtime/extension_inventory_types";
import { EXTENSION_INVENTORY_STRINGS as S } from "../runtime/extension_inventory_strings";
import "./AgentExtensionInventory.css";

/** Inline in the existing AgentDetails dialog; no separate modal or Agent UI. */
export function AgentExtensionInventory({
  agentId,
  selection,
  active,
  blocked = false,
}: {
  agentId: string;
  selection: object | null;
  active: boolean;
  blocked?: boolean;
}) {
  const [cwd, setCwd] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [folderError, setFolderError] = useState(false);
  const [revision, setRevision] = useState(0);
  const capabilityKey = useMemo(
    () => ({}),
    [agentId, selection, active, blocked, revision],
  );
  const liveCapability = useRef(capabilityKey);
  liveCapability.current = capabilityKey;
  const [capability, setCapability] = useState<{
    key: object;
    value?: ExtensionCapabilities;
    error?: ExtensionCode;
    waiting?: boolean;
  } | null>(null);
  const liveOwner = useRef<InventoryOwner | null>(null);
  const owner = useMemo(() => {
    const value: InventoryOwner = {
      agentId,
      token: {},
      current: () =>
        active && !blocked && selection !== null && liveOwner.current === value,
    };
    return value;
  }, [agentId, selection, active, blocked, cwd, revision]);
  liveOwner.current = owner;
  useEffect(() => {
    liveOwner.current = owner;
    return () => {
      if (liveOwner.current === owner) liveOwner.current = null;
      extensionInventory.retire(owner);
    };
  }, [owner]);
  useEffect(() => {
    if (!active || blocked || !selection) return;
    let current = true;
    const accepted = () => current && liveCapability.current === capabilityKey;
    setCapability({ key: capabilityKey, waiting: true });
    const timer = setTimeout(() => {
      if (accepted()) setCapability({ key: capabilityKey, error: "timedOut" });
    }, 10000);
    void Promise.resolve()
      .then(() => (accepted() ? extensionCapabilities(agentId) : null))
      .then(
        (value) => {
          clearTimeout(timer);
          if (accepted() && value) setCapability({ key: capabilityKey, value });
        },
        (reason) => {
          clearTimeout(timer);
          if (accepted())
            setCapability({
              key: capabilityKey,
              error: extensionFailure(reason) ?? "unavailable",
            });
        },
      );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [agentId, selection, active, blocked, capabilityKey]);
  useEffect(() => {
    setChoosing(false);
    setFolderError(false);
  }, [owner]);
  const view = useSyncExternalStore(
    extensionInventory.subscribe,
    () => extensionInventory.get(agentId),
    () => extensionInventory.get(agentId),
  );
  const cap = capability?.key === capabilityKey ? capability : null;
  const available =
    !blocked && cap?.value?.mcpInventory.availability === "available";
  const selectDirectory = async () => {
    if (!owner.current() || choosing || view.unresolved) return;
    setChoosing(true);
    setFolderError(false);
    try {
      const result = await open({ directory: true, multiple: false });
      if (!owner.current()) return;
      if (typeof result === "string" && validInventoryDirectory(result))
        setCwd(result);
      else if (result !== null) setFolderError(true);
    } catch {
      if (owner.current()) setFolderError(true);
    } finally {
      if (owner.current()) setChoosing(false);
    }
  };
  const unresolved = view.unresolved;
  const ticket = cap?.value?.selectionId ?? null;
  const ticketRejected =
    view.error === "selectionChanged" && view.selectionId === ticket;
  const request = view.request;
  const stale =
    view.stale ||
    !active ||
    !selection ||
    view.result?.cwd !== cwd ||
    !available;
  const reason = !selection
    ? "entryUnverified"
    : (cap?.error ?? cap?.value?.mcpInventory.reason);
  return (
    <section className="agent-extension-inventory" aria-label={S.heading}>
      <h4>{S.heading}</h4>
      <p>{S.unavailableLists}</p>
      <h5>{S.mcp}</h5>
      {(cap?.waiting || (active && !blocked && selection && !cap)) && (
        <p role="status">{S.capabilityChecking}</p>
      )}
      {reason && <p role="status">{S.errors[reason]}</p>}
      <div className="agent-extension-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!active || blocked || !selection || !!cap?.waiting}
          onClick={() => {
            if (owner.current()) {
              extensionInventory.retire(owner);
              setRevision((r) => r + 1);
            }
          }}
        >
          {S.capabilityRetry}
        </button>
        {available && (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!active || choosing || unresolved}
              onClick={() => void selectDirectory()}
            >
              {S.chooseDirectory}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                !active ||
                choosing ||
                unresolved ||
                !cwd ||
                !ticket ||
                ticketRejected
              }
              onClick={() => {
                if (owner.current() && available && ticket && !ticketRejected)
                  extensionInventory.begin(owner, cwd, ticket);
              }}
            >
              {view.result ? S.queryAgain : S.query}
            </button>
          </>
        )}
      </div>
      {cwd && (
        <p className="agent-extension-directory">
          <strong>{S.directory}</strong>
          <span>{cwd}</span>
        </p>
      )}
      {folderError && <p role="alert">{S.chooseFailed}</p>}
      {unresolved && request && (
        <div className="agent-extension-progress" role="status">
          <p>
            {view.cancellationRequested
              ? S.cancelling
              : view.error || view.operation?.state === "pendingCleanup"
                ? S.pending
                : S.reading}
          </p>
          <p className="agent-extension-directory">{request.cwd}</p>
          {view.error && view.error !== "cancelled" && (
            <p>{S.errors[view.error]}</p>
          )}
          <div className="agent-extension-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!active || view.checking}
              onClick={() => {
                if (active && liveOwner.current === owner)
                  extensionInventory.check(agentId, request.requestId);
              }}
            >
              {view.checking ? S.checking : S.status}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!active}
              onClick={() => {
                if (active && liveOwner.current === owner)
                  extensionInventory.cancel(agentId, request.requestId);
              }}
            >
              {S.cancel}
            </button>
          </div>
        </div>
      )}
      {!unresolved && view.trackingReleased ? (
        <p role="status">{S.trackingReleased}</p>
      ) : !unresolved && view.error ? (
        <p role="status">{S.errors[view.error]}</p>
      ) : null}
      {view.result && (
        <div className="agent-extension-result">
          {stale && (
            <p role="status" className="auth-note">
              {S.stale}
            </p>
          )}
          <p className="agent-extension-directory">{view.result.cwd}</p>
          <p>
            {S.observed}：
            <time>
              {Number.isNaN(
                new Date(view.result.snapshot.observedAtMs).valueOf(),
              )
                ? S.timeUnavailable
                : new Date(view.result.snapshot.observedAtMs).toLocaleString()}
            </time>
          </p>
          <p>{S.source}</p>
          {view.result.snapshot.items.length === 0 ? (
            <p>{S.empty}</p>
          ) : (
            <ul className="agent-extension-items">
              {view.result.snapshot.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.name ?? S.unnamed}</strong>
                  <span>{S.transport[item.transport]}</span>
                  <span>{item.reportedEnabled ? S.enabled : S.disabled}</span>
                  <span>
                    {S.auth}：{S.authentication[item.reportedAuth]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <details>
        <summary>{S.details}</summary>
        <p>{S.scope}</p>
        <p>{S.limits}</p>
        <p>{S.sideEffects}</p>
      </details>
    </section>
  );
}
