//! Opt-in, numeric-only local timing diagnostics. No session content or identifiers.
use serde::Deserialize;
use std::sync::{
    OnceLock,
    atomic::{AtomicUsize, Ordering},
};
use tauri::AppHandle;

static ORIGIN: OnceLock<i64> = OnceLock::new();
static SAMPLES: AtomicUsize = AtomicUsize::new(0);

pub fn start() {
    ORIGIN.get_or_init(crate::host_store::now_millis);
}

fn enabled(app: &AppHandle) -> bool {
    matches!(
        app.config().identifier.as_str(),
        "ai.farfold.desktop.dev" | "ai.farfold.desktop"
    ) && std::env::var("FARFOLD_PERF_TRACE").as_deref() == Ok("1")
}

#[tauri::command]
pub fn host_performance_origin(app: AppHandle) -> Option<i64> {
    enabled(&app).then(|| *ORIGIN.get_or_init(crate::host_store::now_millis))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerformanceMetric {
    ShellReady,
    SidebarReady,
    PiResume,
    OpencodeResume,
    PiEventPaint,
    OpencodeEventPaint,
    InputPaint,
}

#[tauri::command]
pub fn host_performance_sample(app: AppHandle, metric: PerformanceMetric, milliseconds: f64) {
    if enabled(&app)
        && milliseconds.is_finite()
        && (0.0..=300_000.0).contains(&milliseconds)
        && SAMPLES.fetch_add(1, Ordering::Relaxed) < 4096
    {
        eprintln!("[farfold-perf] {metric:?} {milliseconds:.1}ms");
    }
}
