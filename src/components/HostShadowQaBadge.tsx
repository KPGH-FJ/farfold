import {
  hostRuntimeReconciliationRequest,
  type HostShadowState,
} from "../runtime/host-shadow";

interface HostShadowQaBadgeProps {
  state: HostShadowState | null;
  unavailable: boolean;
  injectingGap: boolean;
  onInjectGap: () => void;
}

export function hostShadowQaLabel(
  state: HostShadowState | null,
  unavailable: boolean,
): string {
  if (unavailable) return "P3 Host · Channel 不可用";
  if (!state) return "P3 Host · 正在连接";
  const requests = Object.values(state.projections)
    .map((projection) =>
      hostRuntimeReconciliationRequest(
        state,
        projection.runtime.installationId,
      ),
    )
    .filter((request) => request !== null);
  if (requests.length) {
    const reasons = [
      ...new Set(requests.flatMap((request) => request.reasons)),
    ];
    return `P3 Host · 需要重建 · ${reasons.join(", ")}`;
  }
  const recovered = Object.values(state.reconciledRevisions).reduce(
    (total, revision) => total + revision,
    0,
  );
  const pending = state.pendingInteractions.filter(
    (interaction) => interaction.state === "pending",
  ).length;
  return `P3 Host · Channel · ${recovered ? `已恢复 ${recovered} · ` : ""}seq ${state.latestSequence}${pending ? ` · 待回复 ${pending}` : ""}`;
}

export function HostShadowQaBadge({
  state,
  unavailable,
  injectingGap,
  onInjectGap,
}: HostShadowQaBadgeProps) {
  const label = hostShadowQaLabel(state, unavailable);
  const pendingReconciliation = Boolean(
    state &&
    Object.values(state.projections).some((projection) =>
      hostRuntimeReconciliationRequest(
        state,
        projection.runtime.installationId,
      ),
    ),
  );
  const tone = unavailable
    ? "failed"
    : pendingReconciliation
      ? "warning"
      : state
        ? "passed"
        : "observing";

  return (
    <output className={`host-shadow-qa ${tone}`} aria-live="polite">
      <span>{label}</span>
      <button
        type="button"
        disabled={injectingGap}
        onClick={onInjectGap}
        title="暂停 Host Channel，以真实 Pi RPC 事件溢出 QA ring，再从旧 cursor 重连"
      >
        {injectingGap ? "注入中…" : "注入 gap"}
      </button>
    </output>
  );
}
