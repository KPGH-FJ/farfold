import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { InventoryOwner } from "../runtime/extension_inventory_controller";
import { pluginManagement } from "../runtime/plugin_management_controller";
import { PLUGIN_MANAGEMENT_STRINGS as S } from "../runtime/plugin_management_strings";
import "./SkillChangeReview.css";

export function AgentExtensionPluginChange({
  owner,
  active,
}: {
  owner: InventoryOwner;
  active: boolean;
}) {
  const view = useSyncExternalStore(
    pluginManagement.subscribe,
    () => pluginManagement.get(owner.agentId),
    () => pluginManagement.get(owner.agentId),
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(view.request);
  const [, refresh] = useState(0);
  const { request, operation: op, review } = view;
  const prior =
    view.originalOperation?.requestId !== op?.requestId
      ? view.originalOperation
      : null;
  const live = useRef({ active, owner, request });
  live.current = { active, owner, request };
  useEffect(() => {
    if (request !== previous.current && active && owner.current())
      heading.current?.focus();
    previous.current = request;
  }, [request, active, owner]);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(
      () => refresh((n) => n + 1),
      Math.max(
        0,
        Math.min(300000, review.observedAtMs + review.validForMs - Date.now()),
      ),
    );
    return () => clearTimeout(timer);
  }, [review]);
  if (!request) return null;
  const allowed = () =>
    live.current.active &&
    live.current.owner === owner &&
    live.current.request === request &&
    owner.current() &&
    pluginManagement.get(owner.agentId).request === request;
  const message = view.trackingReleased
    ? S.trackingReleased
    : view.unresolved
      ? view.cancelRequested
        ? S.cancelling
        : view.error || op?.state === "pendingCleanup"
          ? S.pending
          : request.action === "sources"
            ? S.readingSources
            : request.action === "inventory"
              ? S.reading
              : request.action === "inspect"
                ? S.inspect
                : S.waiting
      : ["sources", "inventory"].includes(request.action)
        ? null
        : request.action === "inspect"
          ? review && pluginManagement.canConfirm(owner, review)
            ? null
            : S.retired
          : op?.outcome
            ? op.outcome === "unknown"
              ? S.unknownResult
              : S[op.outcome]
            : S.unknownResult;
  return (
    <section className="skill-change-review" aria-label={S.reviewHeading}>
      <h5 ref={heading} tabIndex={-1}>
        {S.reviewHeading}
      </h5>
      {request.target && (
        <>
          <p>{request.target.name ?? S.unnamed}</p>
          <p>
            {S.marketplace}: {request.target.marketplaceName ?? S.unknown}
          </p>
          <p>
            {S.source}: {S.sources[request.target.source]}
          </p>
          <p>
            {S.version}: {request.target.version ?? S.unknown}
          </p>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {view.error && <p role="status">{S.errors[view.error]}</p>}
      {prior && (
        <div className="agent-extension-progress">
          <p>{S.priorOperation}</p>
          <p>{prior.target?.name ?? S.unnamed}</p>
          <p>
            {S.marketplace}: {prior.target?.marketplaceName ?? S.unknown}
          </p>
          <p>
            {S.priorDirectory}: {prior.cwd}
          </p>
          <p role="status">
            {prior.outcome === "unknown" || !prior.outcome
              ? S.priorUnknownResult
              : S[prior.outcome]}
          </p>
        </div>
      )}
      {view.unresolved && (
        <div className="agent-extension-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!active || view.checking}
            onClick={() => {
              if (allowed())
                pluginManagement.check(owner.agentId, request.requestId);
            }}
          >
            {view.checking ? S.checking : S.status}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!active || view.checking}
            onClick={() => {
              if (allowed())
                pluginManagement.cancel(owner.agentId, request.requestId);
            }}
          >
            {view.error === "unknownRequest" ? S.release : S.cancel}
          </button>
        </div>
      )}
      {review && (
        <>
          <p>{review.target.name ?? S.unnamed}</p>
          <p>
            {S.marketplace}: {review.target.marketplaceName ?? S.unknown}
          </p>
          <p>
            {S.version}: {review.target.version ?? S.unknown}
          </p>
          <p>
            {S.source}: {S.sources[review.target.source]}
          </p>
          <p>
            {S.installPolicy}: {S.policy[review.target.installPolicy]}
          </p>
          <p>
            {S.authPolicy}: {S.authentication[review.target.authPolicy]}
          </p>
          <p>{S.scope}</p>
          <p>{review.install ? S.installNotice : S.removeNotice}</p>
          <p>{S.applicability}</p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!active || !pluginManagement.canConfirm(owner, review)}
            onClick={() => {
              if (allowed()) pluginManagement.confirm(owner, review);
            }}
          >
            {review.install ? S.confirmInstall : S.confirmRemove}
          </button>
        </>
      )}
      {(op?.writeDispatched ||
        view.originalOperation?.writeDispatched ||
        (["install", "remove"].includes(request.action) &&
          view.unresolved)) && <p>{S.possibleWrite}</p>}
      {request.action === "recheck" &&
        view.originalOperation?.writeDispatched && <p>{S.originalWrite}</p>}
      {op?.observation && (
        <>
          <p>
            {op.observation.reportedInstalled ? S.installed : S.notInstalled}
          </p>
          <p>{op.observation.reportedEnabled ? S.enabled : S.disabled}</p>
          <p>{S.applicability}</p>
        </>
      )}
      {view.originalOperation?.settled &&
        view.originalOperation.writeDispatched && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!active || view.unresolved}
            onClick={() => {
              if (allowed())
                pluginManagement.recheck(owner.agentId, request.requestId);
            }}
          >
            {S.recheck}
          </button>
        )}
    </section>
  );
}
