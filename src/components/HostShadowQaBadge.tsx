import type { HostShadowState } from "../runtime/host-shadow";

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
  if (state.reconciliationReasons.length) {
    return `P3 Host · 需要重建 · ${state.reconciliationReasons.join(", ")}`;
  }
  const { matched, unmatchedChannel, unmatchedPolling } = state.transportParity;
  if (unmatchedChannel || unmatchedPolling) {
    return `P3 Host · 对比中 · 已配平 ${matched} · Channel ${unmatchedChannel} / Polling ${unmatchedPolling}`;
  }
  if (matched) {
    return `P3 Host · 已配平 ${matched} · seq ${state.latestSequence}`;
  }
  return `P3 Host · 等待 Runtime 事件 · seq ${state.latestSequence}`;
}

export function HostShadowQaBadge({
  state,
  unavailable,
}: HostShadowQaBadgeProps) {
  const label = hostShadowQaLabel(state, unavailable);
  const tone = unavailable
    ? "failed"
    : state?.reconciliationReasons.length
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
