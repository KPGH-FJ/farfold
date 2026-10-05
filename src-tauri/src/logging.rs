//! Structured app log in the resolved per-user log directory. macOS preserves
//! `~/Library/Logs/Farfold`; Windows uses Tauri's app_log_dir for this identifier.
//!
//! One line per event: timestamp, level, known component and message size only. The file rotates
//! once it exceeds 5 MB, keeping the current file plus two backups
//! (`.1`, `.2`). Diagnostics only — never read back at runtime.
//!
//! `init` is called once from `setup` with the real log dir; writers that
//! fire earlier use the legacy macOS directory. Windows waits for setup's path.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

/// Rotate when the current file exceeds this many bytes.
const LOG_FILE_CAP: u64 = 5 * 1024 * 1024;
/// Backups kept next to the current file: `app-v1-<date>.log.1` and `.2`.
const LOG_BACKUPS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn label(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// `(days since epoch, seconds into the day)` from unix millis.
fn unix_parts(millis: i64) -> (i64, i64) {
    let days = millis.div_euclid(86_400_000);
    let secs = millis.rem_euclid(86_400_000) / 1000;
    (days, secs)
}

/// Civil `(year, month, day)` from days since epoch (Howard Hinnant).
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn date_stamp(millis: i64) -> String {
    let (days, _) = unix_parts(millis);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn timestamp(millis: i64) -> String {
    let (days, secs) = unix_parts(millis);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60,
        millis.rem_euclid(1000)
    )
}

pub(crate) fn default_log_dir() -> PathBuf {
    if let Some(dir) = LOG_DIRECTORY.get() {
        return dir.clone();
    }
    #[cfg(windows)]
    return std::env::temp_dir().join("ai.farfold.desktop/logs");
    #[cfg(not(windows))]
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Logs/Farfold")
}

struct AppLog {
    dir: PathBuf,
    /// Date stamp of the open file; a new day opens a new file.
    date: String,
    file: std::io::BufWriter<std::fs::File>,
    written: u64,
}

impl AppLog {
    fn open(dir: &Path) -> Option<Self> {
        std::fs::create_dir_all(dir).ok()?;
        let date = date_stamp(now_millis());
        let (file, written) = Self::open_file(dir, &date)?;
        Some(Self {
            dir: dir.to_path_buf(),
            date,
            file,
            written,
        })
    }

    fn path_for(dir: &Path, date: &str) -> PathBuf {
        dir.join(format!("app-v1-{date}.log"))
    }

    fn open_file(dir: &Path, date: &str) -> Option<(std::io::BufWriter<std::fs::File>, u64)> {
        let path = Self::path_for(dir, date);
        let written = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        Some((std::io::BufWriter::new(file), written))
    }

    /// Rename the current file to `.1`, shifting older backups (`.2` is
    /// dropped beyond the keep count), then open a fresh file.
    fn rotate(&mut self) {
        let base = Self::path_for(&self.dir, &self.date);
        let _ = self.file.flush();
        for index in (1..=LOG_BACKUPS).rev() {
            let from = if index == 1 {
                base.clone()
            } else {
                base.with_extension(format!("log.{}", index - 1))
            };
            let to = base.with_extension(format!("log.{index}"));
            if index == LOG_BACKUPS {
                let _ = std::fs::remove_file(&to);
            }
            if from.exists() {
                let _ = std::fs::rename(&from, &to);
            }
        }
        if let Some((file, written)) = Self::open_file(&self.dir, &self.date) {
            self.file = file;
            self.written = written;
        }
    }

    fn write(&mut self, level: Level, module: &str, message: &str) {
        let now = now_millis();
        let today = date_stamp(now);
        if today != self.date {
            if let Some((file, written)) = Self::open_file(&self.dir, &today) {
                self.file = file;
                self.written = written;
            }
            self.date = today;
        }
        if self.written >= LOG_FILE_CAP {
            self.rotate();
        }
        let line = format!(
            "[{}] [{}] [{}] bytes={}\n",
            timestamp(now),
            level.label(),
            match module {
                "app" | "auth" | "diagnostics" | "supervisor" | "acp_client" | "pty" => module,
                _ => "other",
            },
            message.len()
        );
        // Flush every line: the logger lives in a `static` that never
        // drops at process exit, so buffered bytes would be lost.
        if self.file.write_all(line.as_bytes()).is_ok() && self.file.flush().is_ok() {
            self.written += line.len() as u64;
        }
    }
}

fn slot() -> &'static Mutex<Option<AppLog>> {
    static SLOT: OnceLock<Mutex<Option<AppLog>>> = OnceLock::new();
    SLOT.get_or_init(|| {
        // Windows setup resolves the official per-user app log directory.
        // Early calls must not create a macOS-shaped path in the working tree.
        #[cfg(windows)]
        let log = LOG_DIRECTORY.get().and_then(|dir| AppLog::open(dir));
        #[cfg(not(windows))]
        let log = AppLog::open(&default_log_dir());
        Mutex::new(log)
    })
}

/// Point the app log at `dir` (called once from setup with the resolved
/// log directory). A previously opened file keeps receiving lines — the
/// fallback and the real dir are the same in practice.
pub(crate) fn init(dir: &Path) {
    let _ = LOG_DIRECTORY.set(dir.to_path_buf());
    if let Ok(mut guard) = slot().lock()
        && guard.is_none()
    {
        *guard = AppLog::open(dir);
    }
}

pub(crate) fn log(level: Level, module: &str, message: impl std::fmt::Display) {
    if let Ok(mut guard) = slot().lock()
        && let Some(log) = guard.as_mut()
    {
        log.write(level, module, &message.to_string());
    }
}

pub(crate) fn info(module: &str, message: impl std::fmt::Display) {
    log(Level::Info, module, message);
}

pub(crate) fn warn(module: &str, message: impl std::fmt::Display) {
    log(Level::Warn, module, message);
}

pub(crate) fn error(module: &str, message: impl std::fmt::Display) {
    log(Level::Error, module, message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip_and_stamp() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(date_stamp(0), "1970-01-01");
        assert_eq!(date_stamp(1_789_813_230_000), "2026-09-19");
        assert_eq!(timestamp(1_789_813_230_000), "2026-09-19T10:20:30.000");
    }

    #[test]
    fn writes_and_rotates() {
        let dir = tempfile::tempdir().expect("tempdir");
        let today = date_stamp(now_millis());
        let legacy = dir.path().join(format!("app-{today}.log"));
        std::fs::write(&legacy, "legacy log kept locally").unwrap();
        let (file, _) = AppLog::open_file(dir.path(), &today).expect("open");
        let mut log = AppLog {
            dir: dir.path().to_path_buf(),
            date: today.clone(),
            file,
            written: LOG_FILE_CAP,
        };
        log.write(Level::Info, "test", "hello");
        // Rotation renamed the capped file to .1 and started fresh.
        assert!(dir.path().join(format!("app-v1-{today}.log.1")).exists());
        log.write(Level::Error, "secret-module", "secret-canary");
        let _ = log.file.flush();
        let current =
            std::fs::read_to_string(dir.path().join(format!("app-v1-{today}.log"))).unwrap();
        assert!(current.contains("[ERROR] [other] bytes="));
        assert!(!current.contains("secret-canary"));
        assert!(!current.contains("secret-module"));
        assert!(current.contains(&format!("[{today}T")));
        assert_eq!(
            std::fs::read_to_string(legacy).unwrap(),
            "legacy log kept locally"
        );
    }
}
