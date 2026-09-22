//! Opt-in, numeric-only local timing diagnostics. No session content or identifiers.
use serde::Deserialize;
use std::sync::{
    OnceLock,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

static ORIGIN: OnceLock<i64> = OnceLock::new();
static SAMPLES: AtomicUsize = AtomicUsize::new(0);

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn start() {
    ORIGIN.get_or_init(now_millis);
}

fn enabled(app: &AppHandle) -> bool {
    app.config().identifier == "ai.farfold.desktop"
        && std::env::var("FARFOLD_PERF_TRACE").as_deref() == Ok("1")
}

#[tauri::command]
pub fn host_performance_origin(app: AppHandle) -> Option<i64> {
    enabled(&app).then(|| *ORIGIN.get_or_init(now_millis))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerformanceMetric {
    ShellReady,
    SidebarReady,
    PiResume,
    OpencodeResume,
    CodexResume,
    PiEventPaint,
    OpencodeEventPaint,
    CodexEventPaint,
    InputPaint,
    ThreadSwitch,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn host_performance_sample(
    app: AppHandle,
    metric: PerformanceMetric,
    milliseconds: f64,
    ready_milliseconds: f64,
    paint_wait_milliseconds: f64,
    visible: bool,
    focused: bool,
    visibility_changed: bool,
) {
    if enabled(&app)
        && [milliseconds, ready_milliseconds, paint_wait_milliseconds]
            .iter()
            .all(|value| value.is_finite() && (0.0..=300_000.0).contains(value))
        && SAMPLES.fetch_add(1, Ordering::Relaxed) < 4096
    {
        eprintln!(
            "[farfold-perf] {metric:?} {milliseconds:.1}ms ready={ready_milliseconds:.1} paint={paint_wait_milliseconds:.1} visible={} focused={} visibility_changed={}",
            u8::from(visible),
            u8::from(focused),
            u8::from(visibility_changed)
        );
    }
}
