import {
  hostRuntimeReconciliationRequest,
  type HostShadowState,
} from "../runtime/host-shadow";

interface HostShadowQaBadgeProps {
  state: HostShadowState | null;
  unavailable: boolean;
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
  const { matched, unmatchedChannel, unmatchedPolling } = state.transportParity;
  if (unmatchedChannel || unmatchedPolling) {
    return `P3 Host · 对比中 · 已配平 ${matched} · Channel ${unmatchedChannel} / Polling ${unmatchedPolling}`;
  }
  const recovered = Object.values(state.reconciledRevisions).reduce(
    (total, revision) => total + revision,
    0,
  );
  if (matched) {
    return `P3 Host · ${recovered ? `已恢复 ${recovered} · ` : ""}已配平 ${matched} · seq ${state.latestSequence}`;
  }
  return `P3 Host · 等待 Runtime 事件 · seq ${state.latestSequence}`;
}

export function HostShadowQaBadge({
  state,
  unavailable,
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
      : state?.transportParity.matched &&
          state.transportParity.unmatchedChannel === 0 &&
          state.transportParity.unmatchedPolling === 0
        ? "passed"
        : "observing";

  return (
    <output className={`host-shadow-qa ${tone}`} aria-live="polite">
      {label}
    </output>
  );
}
