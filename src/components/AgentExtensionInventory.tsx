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
  type InventoryKind,
} from "../runtime/extension_inventory_types";
import { EXTENSION_INVENTORY_STRINGS as S } from "../runtime/extension_inventory_strings";
import "./AgentExtensionInventory.css";
import { AgentExtensionInventoryResult } from "./AgentExtensionInventoryResult";
import { SkillChangeReview } from "./SkillChangeReview";
import { MCP_MANAGEMENT_STRINGS as M } from "../runtime/mcp_management_strings";
import { skillManagement } from "../runtime/skill_management_controller";

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
  const [kind, setKind] = useState<InventoryKind>("mcp");
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
  }, [agentId, selection, active, blocked, cwd, revision, kind]);
  liveOwner.current = owner;
  useEffect(() => {
    liveOwner.current = owner;
    return () => {
      if (liveOwner.current === owner) liveOwner.current = null;
      extensionInventory.retire(owner);
      skillManagement.retire(owner);
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
  const managementView = useSyncExternalStore(
    skillManagement.subscribe,
    () => skillManagement.get(agentId),
    () => skillManagement.get(agentId),
  );
  const cap = capability?.key === capabilityKey ? capability : null;
  const selectedCapability =
    kind === "mcp" ? cap?.value?.mcpInventory : cap?.value?.skillsInventory;
  const available =
    !blocked && selectedCapability?.availability === "available";
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
  const result = view.results[kind];
  const managementAvailable =
    kind === "mcp"
      ? cap?.value?.mcpEnablement?.availability === "available"
      : cap?.value?.skillEnablement.availability === "available";
  useEffect(() => {
    skillManagement.retireInspectionForResult(owner, result);
  }, [owner, result]);
  const stale =
    result?.stale || !active || !selection || result?.cwd !== cwd || !available;
  const reason = !selection
    ? "entryUnverified"
    : (cap?.error ?? selectedCapability?.reason);
  return (
    <section className="agent-extension-inventory" aria-label={S.heading}>
      <h4>{S.heading}</h4>
      <p>{S.unavailableLists}</p>
      <label className="agent-extension-kind">
        <span>{S.kind}</span>
        <select
          aria-label={S.kind}
          value={kind}
          disabled={!active || blocked}
          onChange={(event) => {
            if (active && !blocked && liveOwner.current === owner)
              setKind(event.target.value as InventoryKind);
          }}
        >
          <option value="mcp">{S.mcp}</option>
          <option value="skills">{S.skills}</option>
        </select>
      </label>
      <h5>{kind === "mcp" ? S.mcp : S.skills}</h5>
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
                  extensionInventory.begin(owner, cwd, ticket, kind);
              }}
            >
              {kind === "mcp"
                ? result
                  ? S.queryAgain
                  : S.query
                : result
                  ? S.skillQueryAgain
                  : S.skillQuery}
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
            {S.queryKind}：{request.kind === "mcp" ? S.mcp : S.skills}
          </p>
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
        <p role="status">
          {request?.kind === "skills" ? S.skills : S.mcp}：
          <span>{S.trackingReleased}</span>
        </p>
      ) : !unresolved && view.error ? (
        <p role="status">
          {request?.kind === "skills" ? S.skills : S.mcp}：
          <span>{S.errors[view.error]}</span>
        </p>
      ) : null}
      {result && (
        <AgentExtensionInventoryResult
          result={result}
          stale={!!stale}
          management={
            managementAvailable
              ? {
                  enabled: active && !blocked && !managementView.unresolved,
                  inspect: (item, requestedEnabled) => {
                    const current = () =>
                      owner.current() &&
                      liveCapability.current === capabilityKey &&
                      managementAvailable &&
                      extensionInventory.isCurrentResult(owner, result);
                    if (current())
                      skillManagement.inspect({
                        owner,
                        result,
                        item,
                        requestedEnabled,
                        current,
                        changed: () => extensionInventory.markStale(result),
                      });
                  },
                }
              : undefined
          }
        />
      )}
      <SkillChangeReview
        agentId={agentId}
        owner={owner}
        active={active && !blocked}
      />
      <details>
        <summary>{S.details}</summary>
        <p>{kind === "mcp" ? S.scope : S.skillScope}</p>
        <p>
          {kind === "mcp"
            ? managementAvailable
              ? M.limits
              : S.limits
            : managementAvailable
              ? S.skillManagementLimits
              : S.skillLimits}
        </p>
        <p>{S.sideEffects}</p>
      </details>
    </section>
  );
}
