//! Opt-in, numeric-only local timing diagnostics. No session content or identifiers.
use serde::Deserialize;
use std::sync::{
    OnceLock,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Instant;
use tauri::AppHandle;

static ORIGIN: OnceLock<i64> = OnceLock::new();
static SAMPLES: AtomicUsize = AtomicUsize::new(0);

pub fn start() {
    ORIGIN.get_or_init(crate::host_store::now_millis);
}

fn enabled(app: &AppHandle) -> bool {
    matches!(
        app.config().identifier.as_str(),
        "ai.farfold.desktop.dev"
            | "ai.farfold.desktop.p6qa"
            | "ai.farfold.desktop"
            | "ai.farfold.desktop.dpiqa"
    ) && std::env::var("FARFOLD_PERF_TRACE").as_deref() == Ok("1")
}

/// Numeric/fixed-enum payloads only: no child output, environment, paths or session IDs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RuntimeCheckPhase {
    Enter {
        bundled: bool,
    },
    Digest {
        matches: bool,
    },
    SpawnBegin,
    Spawned {
        pid: u32,
    },
    SpawnFailed {
        errno: Option<i32>,
    },
    Pending {
        polls: u32,
    },
    Exited {
        polls: u32,
        code: Option<i32>,
        success: bool,
    },
    Timeout {
        polls: u32,
    },
    ObserveFailed {
        errno: Option<i32>,
    },
    ChildState {
        pid: u32,
        parent: u32,
        group: u32,
        status: u32,
        flags: u32,
    },
    ChildStateUnavailable,
    BufferedOutput {
        bytes: Option<u32>,
    },
    Killed {
        success: bool,
    },
    Reaped {
        success: bool,
    },
    Output {
        bytes: usize,
    },
    Parsed {
        valid_utf8: bool,
        within_limit: bool,
    },
    Version {
        matches: bool,
    },
}

pub(crate) struct RuntimeCheckTrace {
    enabled: bool,
    sequence: usize,
    started: Instant,
}

impl RuntimeCheckTrace {
    pub(crate) fn new(app: &AppHandle, resource: &'static str, digest: &'static str) -> Self {
        let trace = Self {
            enabled: enabled(app),
            sequence: SAMPLES.fetch_add(1, Ordering::Relaxed),
            started: Instant::now(),
        };
        if trace.enabled && trace.sequence < 4096 {
            eprintln!(
                "[farfold-perf-runtime-identity] check={} resource={resource} expected_sha256={digest}",
                trace.sequence
            );
        }
        trace
    }

    pub(crate) fn record(&self, phase: RuntimeCheckPhase) {
        if self.enabled && self.sequence < 4096 {
            eprintln!(
                "[farfold-perf-runtime-check] check={} elapsed_ms={:.3} thread={:?} main={} phase={phase:?}",
                self.sequence,
                self.started.elapsed().as_secs_f64() * 1000.0,
                std::thread::current().id(),
                unsafe { libc::pthread_main_np() }
            );
        }
    }
}

pub(crate) fn pi_start_boundary(app: &AppHandle, resume: bool) {
    if enabled(app) && SAMPLES.fetch_add(1, Ordering::Relaxed) < 4096 {
        eprintln!(
            "[farfold-perf-pi-start] phase=before_installation_check resume={resume} generation_allocated=false start_lock_held=true boundary=host_blocking_worker thread={:?}",
            std::thread::current().id()
        );
    }
}

pub(crate) fn child_state(pid: u32) -> RuntimeCheckPhase {
    // libproc reads kernel metadata only. Never emit pbi_comm/name or process arguments.
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let count = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if count != size {
        return RuntimeCheckPhase::ChildStateUnavailable;
    }
    let info = unsafe { info.assume_init() };
    RuntimeCheckPhase::ChildState {
        pid: info.pbi_pid,
        parent: info.pbi_ppid,
        group: info.pbi_pgid,
        status: info.pbi_status,
        flags: info.pbi_flags,
    }
}

/// Fixed operation names only; never include arguments, return values or error text.
#[derive(Debug)]
pub(crate) enum Operation {
    HostSessionOpen,
}

pub(crate) fn measure<T, E>(
    app: &AppHandle,
    operation: Operation,
    run: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    if !enabled(app) {
        return run();
    }
    let started = Instant::now();
    let result = run();
    if SAMPLES.fetch_add(1, Ordering::Relaxed) < 4096 {
        eprintln!(
            "[farfold-perf-operation] {operation:?} {:.1}ms ok={}",
            started.elapsed().as_secs_f64() * 1000.0,
            u8::from(result.is_ok()),
        );
    }
    result
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
    CodexResume,
    PiEventPaint,
    OpencodeEventPaint,
    CodexEventPaint,
    InputPaint,
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
