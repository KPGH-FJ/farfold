import { useLayoutEffect, useRef, useState } from "react";
import type { ThreadState } from "../runtime/session_types";
import {
  cancelOfficialReadOnlyCheck,
  officialReadOnlyTarget,
  runOfficialReadOnlyCheck,
  type OfficialReadOnlyReport,
  type OfficialReadOnlyTarget,
} from "../runtime/official_readonly_check";
import {
  OFFICIAL_READONLY_CHECK_STRINGS as S,
  officialReadOnlyCheckError,
} from "../runtime/official_readonly_check_strings";
import { useConnectionPreparation } from "./useConnectionPreparation";

type Attempt = {
  id: string;
  cancelled: boolean;
  cancellation?: Promise<void>;
};
type Status =
  | { kind: "idle" | "checking" | "cancelling" | "cancelled" | "cancelFailed" }
  | { kind: "checked"; report: OfficialReadOnlyReport }
  | { kind: "failed"; message: string };

function requestCancellation(agentId: string, attempt: Attempt): Promise<void> {
  attempt.cancelled = true;
  attempt.cancellation ??= cancelOfficialReadOnlyCheck(
    agentId,
    attempt.id,
  ).catch((error) => {
    attempt.cancellation = undefined;
    throw error;
  });
  return attempt.cancellation;
}

function OfficialReadOnlyAttempt({
  target,
}: {
  target: OfficialReadOnlyTarget;
}) {
  const active = useRef<Attempt | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const { agentId } = target;
  useLayoutEffect(
    () => () => {
      const attempt = active.current;
      active.current = null;
      if (attempt) void requestCancellation(agentId, attempt).catch(() => {});
    },
    [agentId],
  );

  const start = async () => {
    if (active.current) return;
    const attempt: Attempt = { id: crypto.randomUUID(), cancelled: false };
    active.current = attempt;
    setStatus({ kind: "checking" });
    try {
      const report = await runOfficialReadOnlyCheck(target, attempt.id);
      if (active.current === attempt)
        setStatus(
          attempt.cancelled
            ? { kind: "cancelled" }
            : { kind: "checked", report },
        );
    } catch (error) {
      if (active.current === attempt)
        setStatus(
          attempt.cancelled
            ? { kind: "cancelled" }
            : { kind: "failed", message: officialReadOnlyCheckError(error) },
        );
    } finally {
      if (active.current === attempt) active.current = null;
    }
  };

  const cancel = async () => {
    const attempt = active.current;
    if (!attempt || attempt.cancellation) return;
    setStatus({ kind: "cancelling" });
    try {
      await requestCancellation(agentId, attempt);
    } catch {
      if (active.current === attempt) setStatus({ kind: "cancelFailed" });
    }
  };

  const running =
    status.kind === "checking" ||
    status.kind === "cancelling" ||
    status.kind === "cancelFailed";
  return (
    <details className="agent-setup-test-note">
      <summary>{S.title}</summary>
      <p>{S.hint}</p>
      {status.kind === "checked" ? (
        <div role="status">
          <p>{S.checked}</p>
          <p>
            {status.report.accountPresent ? S.account : S.accountUnknown}。
            {status.report.workspaceReported ? S.workspace : S.workspaceUnknown}
            。
          </p>
          <p>
            {S.provider} {status.report.provider}
          </p>
        </div>
      ) : status.kind !== "idle" ? (
        <p
          role={
            status.kind === "failed" || status.kind === "cancelFailed"
              ? "alert"
              : "status"
          }
        >
          {status.kind === "failed" ? status.message : S[status.kind]}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost"
        disabled={status.kind === "cancelling"}
        onClick={running ? () => void cancel() : () => void start()}
      >
        {running ? S.cancel : S.start}
      </button>
    </details>
  );
}

/** The transient report is owned only by the exact prepared view. */
export function AgentOfficialReadOnlyCheck({
  thread,
  program,
}: {
  thread: Pick<
    ThreadState,
    "agentId" | "cwd" | "configOptions" | "key" | "connectionId"
  >;
  program: string;
}) {
  const { agentId, cwd, configOptions, key, connectionId } = thread;
  const { info } = useConnectionPreparation(agentId, program, true);
  const target = officialReadOnlyTarget(
    agentId,
    cwd,
    info?.officialReadOnlyCheck,
    configOptions,
  );
  if (!target) return null;
  return (
    <OfficialReadOnlyAttempt
      key={JSON.stringify([program, key, connectionId, target])}
      target={target}
    />
  );
}
