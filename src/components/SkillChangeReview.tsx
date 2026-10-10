import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { skillManagement } from "../runtime/skill_management_controller";
import type { InventoryOwner } from "../runtime/extension_inventory_controller";
import { SKILL_MANAGEMENT_STRINGS as S } from "../runtime/skill_management_strings";
import { EXTENSION_INVENTORY_STRINGS as I } from "../runtime/extension_inventory_strings";
import "./SkillChangeReview.css";

export function SkillChangeReview({
  agentId,
  owner,
  active,
}: {
  agentId: string;
  owner: InventoryOwner;
  active: boolean;
}) {
  const view = useSyncExternalStore(
    skillManagement.subscribe,
    () => skillManagement.get(agentId),
    () => skillManagement.get(agentId),
  );
  const [closed, setClosed] = useState<string | null>(null);
  const [, refresh] = useState(0);
  const { request, operation: op, review } = view;
  const heading = useRef<HTMLHeadingElement>(null);
  const reopen = useRef<HTMLButtonElement>(null);
  const priorRequest = useRef(request);
  useEffect(() => {
    if (request !== priorRequest.current && active && owner.current())
      heading.current?.focus();
    priorRequest.current = request;
  }, [request, owner, active]);
  useEffect(() => {
    if (closed && active && owner.current()) reopen.current?.focus();
  }, [closed, active, owner]);
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
    active &&
    owner.current() &&
    skillManagement.get(agentId).request === request;
  if (closed === request.requestId)
    return (
      <button
        ref={reopen}
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          if (allowed()) setClosed(null);
        }}
      >
        {S.reopen}
      </button>
    );
  const outcome = op?.outcome;
  const summary = view.trackingReleased
    ? S.trackingReleased
    : view.admissionRejected
      ? S.notDispatched
      : view.unresolved
        ? view.cancelRequested
          ? S.cancelling
          : view.error || op?.state === "pendingCleanup"
            ? S.pending
            : request.action === "inspect"
              ? S.inspect
              : S.waiting
        : request.action === "inspect"
          ? review && skillManagement.canConfirm(owner, review)
            ? null
            : S.retired
          : outcome
            ? S[outcome]
            : S.unknown;
  return (
    <section className="skill-change-review" aria-label={S.heading}>
      <div className="skill-change-header">
        <h5 ref={heading} tabIndex={-1}>
          {S.heading}
        </h5>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (!allowed()) return;
            skillManagement.retire(owner);
            setClosed(request.requestId);
          }}
        >
          {S.close}
        </button>
      </div>
      <strong>{request.target.name}</strong>
      <p>
        {I.origin}：{I.origins[request.target.origin]}
      </p>
      <p className="skill-change-path">{request.cwd}</p>
      {request.target.displayPath && (
        <p className="skill-change-path">
          {S.target}：{request.target.displayPath}
        </p>
      )}
      <p>
        {S.requested}：{request.requestedEnabled ? S.enabled : S.disabled}
      </p>
      {summary && <p role="status">{summary}</p>}
      {view.error && !view.trackingReleased && (
        <p role="status">{S.errors[view.error]}</p>
      )}
      {view.unresolved &&
        (op?.writeDispatched || request.action !== "inspect") && (
          <p>{S.possibleWrite}</p>
        )}
      {review && !view.reviewRetired && (
        <>
          <p className="skill-change-path">
            {S.target}：{review.target.displayPath}
          </p>
          <p>
            {S.reported}：{review.reportedEnabled ? S.enabled : S.disabled}
          </p>
          <p>
            {S.scope}：
            {review.writeScope.kind === "profile" ? S.profile : S.user}
          </p>
          <p className="skill-change-path">
            {review.writeScope.configDisplayPath}
          </p>
          <p>{S.notice}</p>
          <details>
            <summary>{S.details}</summary>
            <p>
              {S.observedAt}：{new Date(review.observedAtMs).toLocaleString()}
            </p>
            <p>
              {S.rules}：{review.rulesBefore} → {review.rulesAfter}
            </p>
            <p>{S.preservation}</p>
            <p>{S.external}</p>
            <p>{S.effects}</p>
            <p>{S.expiry}</p>
          </details>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!active || !skillManagement.canConfirm(owner, review)}
            onClick={() => {
              if (allowed()) skillManagement.confirm(owner, review);
            }}
          >
            {review.requestedEnabled ? S.enable : S.disable}
          </button>
        </>
      )}
      {op?.writeAck === "okOverridden" && <p>{S.overridden}</p>}
      {op &&
        ["ok", "okOverridden"].includes(op.writeAck) &&
        !op.observation && <p>{S.ackOnly}</p>}
      {op?.observation && (
        <>
          <p>
            {S.configuration}：
            {op.observation.configuration === "matchesIntended"
              ? S.configMatch
              : op.observation.configuration === "changed"
                ? S.configChanged
                : S.unverified}
          </p>
          <p>
            {S.reported}：
            {op.observation.reportedEnabled === null
              ? op.observation.skill === "missing"
                ? S.missing
                : S.unverified
              : op.observation.reportedEnabled
                ? S.enabled
                : S.disabled}
          </p>
        </>
      )}
      <p>{S.applicability}</p>
      <div className="agent-extension-actions">
        {view.unresolved && (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!active || view.checking}
              onClick={() => {
                if (allowed())
                  skillManagement.check(agentId, request.requestId);
              }}
            >
              {view.checking ? S.checking : S.status}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!active}
              onClick={() => {
                if (allowed())
                  skillManagement.cancel(agentId, request.requestId);
              }}
            >
              {S.cancel}
            </button>
          </>
        )}
        {!view.unresolved && op?.settled && op.writeDispatched && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!active}
            onClick={() => {
              if (allowed())
                skillManagement.recheck(agentId, request.requestId);
            }}
          >
            {S.recheck}
          </button>
        )}
      </div>
    </section>
  );
}
