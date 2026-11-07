import { isHttpInput } from "../runtime/mcp_add_types";
import { MCP_REMOVE_STRINGS as REMOVE } from "../runtime/mcp_remove_strings";
import { SKILL_PREFERENCE_REMOVE_STRINGS as SKILL_REMOVE } from "../runtime/skill_preference_remove_strings";
import {
  MCP_ADD_STRINGS as ADD,
  MCP_HTTP_ADD_STRINGS as HTTP,
} from "../runtime/mcp_add_strings";
import "./McpAddForm.css";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { skillManagement } from "../runtime/skill_management_controller";
import type { InventoryOwner } from "../runtime/extension_inventory_controller";
import { SKILL_MANAGEMENT_STRINGS as SKILLS } from "../runtime/skill_management_strings";
import { EXTENSION_INVENTORY_STRINGS as I } from "../runtime/extension_inventory_strings";
import { MCP_MANAGEMENT_STRINGS as MCP } from "../runtime/mcp_management_strings";
import "./SkillChangeReview.css";
import type { ExtensionChangeRequest } from "../runtime/extension_management_types";
import type { SkillChangeScope } from "../runtime/skill_management_types";

function stringsForTarget(target: ExtensionChangeRequest["target"]) {
  return !("kind" in target)
    ? SKILLS
    : target.kind === "skillPreferenceRemoval"
      ? SKILL_REMOVE
      : target.kind === "mcpRemoval"
        ? REMOVE
        : target.kind === "mcpAddition"
          ? target.transport === "streamableHttp"
            ? HTTP
            : ADD
          : MCP;
}

function WriteScope({ scope }: { scope: Readonly<SkillChangeScope> }) {
  return (
    <>
      <p>
        {SKILLS.scope}：
        {scope.kind === "profile" ? SKILLS.profile : SKILLS.user}
      </p>
      <p className="skill-change-path">{scope.configDisplayPath}</p>
    </>
  );
}

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
  const priorClosed = useRef(closed);
  useEffect(() => {
    if (
      (request !== priorRequest.current ||
        (priorClosed.current !== null && closed === null)) &&
      active &&
      owner.current()
    )
      heading.current?.focus();
    priorRequest.current = request;
    priorClosed.current = closed;
  }, [request, closed, owner, active]);
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
        {stringsForTarget(request.target).reopen}
      </button>
    );
  const isAddition =
    "kind" in request.target && request.target.kind === "mcpAddition";
  const isRemoval =
    "kind" in request.target &&
    ["mcpRemoval", "skillPreferenceRemoval"].includes(request.target.kind);
  const isSkillRemoval =
    "kind" in request.target &&
    request.target.kind === "skillPreferenceRemoval";
  const R = isSkillRemoval ? SKILL_REMOVE : REMOVE;
  const S = stringsForTarget(request.target);
  const prior =
    view.originalOperation?.requestId !== op?.requestId
      ? view.originalOperation
      : null;
  const outcome = op?.outcome;
  const refusedWithoutReview =
    request.action === "inspect" &&
    op?.state === "failed" &&
    op.settled &&
    op.review === null &&
    !op.writeDispatched &&
    op.writeAck === "none" &&
    op.code !== null &&
    view.error === op.code;
  const summary = view.trackingReleased
    ? S.trackingReleased
    : view.admissionRejected ||
        ((isAddition || isRemoval) &&
          request.action === "inspect" &&
          outcome === "notDispatched")
      ? S.notDispatched
      : view.unresolved
        ? view.cancelRequested
          ? S.cancelling
          : view.error || op?.state === "pendingCleanup"
            ? S.pending
            : request.action === "inspect"
              ? S.inspect
              : isRemoval && request.action === "recheck"
                ? R.checkingResult
                : S.waiting
        : request.action === "inspect"
          ? refusedWithoutReview ||
            (review && skillManagement.canConfirm(owner, review))
            ? null
            : S.retired
          : outcome
            ? isRemoval &&
              request.action === "recheck" &&
              ["unknown", "notDispatched"].includes(outcome)
              ? R.checkUnknown
              : S[outcome]
            : S.unknown;
  const readback =
    !view.unresolved &&
    view.originalOperation?.settled &&
    view.originalOperation.writeDispatched ? (
      <button
        type="button"
        className="btn btn-ghost"
        disabled={!active}
        onClick={() => {
          if (allowed()) skillManagement.recheck(agentId, request.requestId);
        }}
      >
        {S.recheck}
      </button>
    ) : null;
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
      {"origin" in request.target && (
        <p>
          {I.origin}：{I.origins[request.target.origin]}
        </p>
      )}
      <p className="skill-change-path">{request.cwd}</p>
      {"displayPath" in request.target && request.target.displayPath && (
        <p className="skill-change-path">
          {S.target}：{request.target.displayPath}
        </p>
      )}
      <p>
        {S.requested}：
        {isRemoval
          ? R.remove
          : request.requestedEnabled
            ? S.enabled
            : S.disabled}
      </p>
      {isRemoval && "transport" in request.target && (
        <p>{I.transport[request.target.transport]}</p>
      )}
      {view.confirmedScope &&
        (view.unresolved || view.trackingReleased || op?.writeDispatched) && (
          <WriteScope scope={view.confirmedScope} />
        )}
      {prior && (
        <div className="agent-extension-progress">
          <p>
            {isRemoval && request.action === "recheck"
              ? R.original
              : SKILLS.priorOperation}
          </p>
          <p>{prior.target.name}</p>
          <p className="skill-change-path">
            {SKILLS.priorDirectory}：{prior.cwd}
          </p>
          {view.originalWriteScope && (
            <WriteScope scope={view.originalWriteScope} />
          )}
          <p role="status">
            {!prior.outcome || prior.outcome === "unknown"
              ? "kind" in prior.target &&
                ["mcpRemoval", "skillPreferenceRemoval"].includes(
                  prior.target.kind,
                )
                ? stringsForTarget(prior.target).unknown
                : SKILLS.priorUnknown
              : stringsForTarget(prior.target)[prior.outcome]}
          </p>
          {readback}
        </div>
      )}
      {summary && <p role="status">{summary}</p>}
      {view.error && !view.trackingReleased && (
        <p role="status">
          {(S.errors as Partial<Record<string, string>>)[view.error] ??
            S.errors.unavailable}
        </p>
      )}
      {view.unresolved &&
        (op?.writeDispatched || request.action !== "inspect") && (
          <p>{S.possibleWrite}</p>
        )}
      {review && !view.reviewRetired && (
        <>
          {"displayPath" in review.target && (
            <p className="skill-change-path">
              {S.target}：{review.target.displayPath}
            </p>
          )}
          {isAddition && (
            <div className="mcp-add-review">
              <p>{ADD.absent}</p>
              {view.additionInput ? (
                isHttpInput(view.additionInput) ? (
                  <>
                    <p>
                      {HTTP.address}：
                      <code>{JSON.stringify(view.additionInput.url)}</code>
                    </p>
                    <p>{ADD.quotedValues}</p>
                  </>
                ) : (
                  <>
                    <p>
                      {ADD.executable}：
                      <code>
                        {JSON.stringify(view.additionInput.executablePath)}
                      </code>
                    </p>
                    <p>{ADD.arguments}</p>
                    <p>{ADD.quotedValues}</p>
                    {view.additionInput.args.length ? (
                      <ol>
                        {view.additionInput.args.map((arg, i) => (
                          <li key={i}>
                            <code>{JSON.stringify(arg)}</code>
                            {arg === "" && `（${ADD.emptyArgument}）`}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>{ADD.noArguments}</p>
                    )}
                  </>
                )
              ) : (
                <p role="alert">{ADD.inputMissing}</p>
              )}
            </div>
          )}
          {"configuredEnabled" in review && !isAddition && (
            <p>
              {isSkillRemoval ? SKILL_REMOVE.configured : MCP.configured}：
              {review.configuredEnabled ? S.enabled : S.disabled}
            </p>
          )}
          {!isAddition && (
            <p>
              {S.reported}：{review.reportedEnabled ? S.enabled : S.disabled}
            </p>
          )}
          <WriteScope scope={review.writeScope} />
          {"parentHandling" in review && (
            <p>{R.parentHandling[review.parentHandling]}</p>
          )}
          <p>{S.notice}</p>
          <details>
            <summary>{S.details}</summary>
            <p>
              {S.observedAt}：{new Date(review.observedAtMs).toLocaleString()}
            </p>
            {"rulesBefore" in review && (
              <p>
                {SKILLS.rules}：{review.rulesBefore} → {review.rulesAfter}
              </p>
            )}
            <p>{S.preservation}</p>
            <p>{S.external}</p>
            <p>{S.effects}</p>
            <p>{S.expiry}</p>
          </details>
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              !active ||
              (isAddition && !view.additionInput) ||
              !skillManagement.canConfirm(owner, review)
            }
            onClick={() => {
              if (allowed() && (!isAddition || view.additionInput))
                skillManagement.confirm(owner, review);
            }}
          >
            {isRemoval
              ? R.confirm
              : isAddition
                ? ADD.confirm
                : review.requestedEnabled
                  ? S.enable
                  : S.disable}
          </button>
        </>
      )}
      {op?.writeAck === "okOverridden" && <p>{S.overridden}</p>}
      {op &&
        ["ok", "okOverridden"].includes(op.writeAck) &&
        !op.observation && <p>{S.ackOnly}</p>}
      {op?.observation && (
        <>
          {"configuredEnabled" in op.observation && (
            <p>
              {isSkillRemoval ? SKILL_REMOVE.configured : MCP.configured}：
              {op.observation.configuredEnabled === null
                ? isRemoval && op.observation.configuration === "matching"
                  ? R.configurationAbsent
                  : S.unverified
                : op.observation.configuredEnabled
                  ? S.enabled
                  : S.disabled}
            </p>
          )}
          <p>
            {S.configuration}：
            {["matchesIntended", "matching"].includes(
              op.observation.configuration,
            )
              ? S.configMatch
              : ["changed", "different"].includes(op.observation.configuration)
                ? S.configChanged
                : S.unverified}
          </p>
          <p>
            {S.reported}：
            {op.observation.reportedEnabled === null
              ? "mcp" in op.observation && op.observation.mcp === "absent"
                ? REMOVE.missing
                : ("skill" in op.observation
                      ? op.observation.skill
                      : op.observation.mcp) === "missing"
                  ? S.missing
                  : S.unverified
              : op.observation.reportedEnabled
                ? S.enabled
                : S.disabled}
          </p>
          {"parentOutcome" in op.observation && (
            <>
              {"mcp" in op.observation && op.observation.mcp === "present" && (
                <p>{REMOVE.present}</p>
              )}
              <p>
                {R.parent}：
                {op.observation.parentOutcome === null
                  ? S.unverified
                  : R.parentOutcomes[op.observation.parentOutcome]}
              </p>
            </>
          )}
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
        {!prior && readback}
      </div>
    </section>
  );
}
