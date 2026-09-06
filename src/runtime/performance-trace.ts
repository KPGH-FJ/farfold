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

export function traceAfterPaint(metric: Metric, startedAt = Date.now()) {
  void origin.then((nativeOrigin) => {
    if (nativeOrigin === null) return;
    if (metric === "shell_ready" || metric === "sidebar_ready") {
      if (once.has(metric)) return;
      once.add(metric);
    }
    // Two animation frames bound the next paint opportunity, including React work.
    // This is an observed upper bound, not a CPU-only React render duration.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const finishedAt = Date.now();
        const start =
          metric === "shell_ready"
            ? nativeOrigin
            : metric === "sidebar_ready"
              ? (shellPaintedAt ?? startedAt)
              : startedAt;
        if (metric === "shell_ready") shellPaintedAt = finishedAt;
        void invoke("host_performance_sample", {
          metric,
          milliseconds: Math.max(0, finishedAt - start),
        }).catch(() => undefined);
      }),
    );
  });
}
