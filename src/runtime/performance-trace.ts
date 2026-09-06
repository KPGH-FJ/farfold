import { invoke } from "@tauri-apps/api/core";

// The Host only enables this for an explicitly opted-in local process. Keep content,
// paths and native identifiers out of diagnostics; never persist UI state here.
const origin = invoke<number | null>("host_performance_origin").catch(
  () => null,
);
type Metric =
  | "shell_ready"
  | "sidebar_ready"
  | "pi_resume"
  | "opencode_resume"
  | "pi_event_paint"
  | "opencode_event_paint"
  | "input_paint";
let shellPaintedAt: number | null = null;
const once = new Set<Metric>();
let visibilityRevision = 0;
void origin.then((nativeOrigin) => {
  if (nativeOrigin !== null) {
    document.addEventListener("visibilitychange", () => visibilityRevision++);
  }
});

export function traceAfterPaint(metric: Metric, startedAt = Date.now()) {
  void origin.then((nativeOrigin) => {
    if (nativeOrigin === null) return;
    if (metric === "shell_ready" || metric === "sidebar_ready") {
      if (once.has(metric)) return;
      once.add(metric);
    }
    const start =
      metric === "shell_ready"
        ? nativeOrigin
        : metric === "sidebar_ready"
          ? (shellPaintedAt ?? startedAt)
          : startedAt;
    const scheduledAt = Date.now();
    const scheduledRevision = visibilityRevision;
    const visibleAtSchedule = !document.hidden;
    const focusedAtSchedule = document.hasFocus();
    // Two animation frames bound the next paint opportunity, including React work.
    // This is an observed upper bound, not a CPU-only React render duration.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const finishedAt = Date.now();
        if (metric === "shell_ready") shellPaintedAt = finishedAt;
        void invoke("host_performance_sample", {
          metric,
          milliseconds: Math.max(0, finishedAt - start),
          readyMilliseconds: Math.max(0, scheduledAt - start),
          paintWaitMilliseconds: Math.max(0, finishedAt - scheduledAt),
          visible: visibleAtSchedule && !document.hidden,
          focused: focusedAtSchedule && document.hasFocus(),
          visibilityChanged: visibilityRevision !== scheduledRevision,
        }).catch(() => undefined);
      }),
    );
  });
}
