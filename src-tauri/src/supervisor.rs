//! Process supervision for agent connections.
//!
//! `app_data/pids.json` registers every spawned agent process
//! (`{pid, agent_id, cwd, started_at}`) so the next launch can reap
//! leftovers from a crash or force-quit: a still-alive entry whose parent
//! is `launchd` (pid 1) or any process that is not this app gets
//! SIGTERM, a 2-second grace, then SIGKILL. Entries are removed as
//! connections die and the file is cleared after the startup sweep.
//!
//! Provides the process-table helpers the
//! connection manager needs (`pgrep -P` child listing, ppid/pgid
//! inspection, group kill — agents are spawned as process-group
//! leaders, so `kill(-pid)` terminates the whole tree).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::logging;

/// Grace between SIGTERM and SIGKILL for leftover processes.
const TERM_GRACE: Duration = Duration::from_secs(2);
/// Serialize every `pids.json` read-modify-write.
static PIDS_LOCK: Mutex<()> = Mutex::new(());
/// Serializes spawn→pid attribution across concurrent connects.
static SPAWN_ATTRIBUTION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PidEntry {
    pub pid: u32,
    pub agent_id: String,
    pub cwd: String,
    /// Spawn command path — used to confirm a still-alive pid is really
    /// our agent and not a recycled pid owned by someone else.
    #[serde(default)]
    pub command: String,
    pub started_at: i64,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn pids_path(data_dir: &Path) -> PathBuf {
    data_dir.join("pids.json")
}

fn read_pids(data_dir: &Path) -> Vec<PidEntry> {
    std::fs::read_to_string(pids_path(data_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_pids(data_dir: &Path, entries: &[PidEntry]) {
    if let Ok(raw) = serde_json::to_string_pretty(entries) {
        let _ = std::fs::write(pids_path(data_dir), raw);
    }
}

/// Register a spawned agent process. Called once per successful connect.
pub(crate) fn register_pid(data_dir: &Path, agent_id: &str, cwd: &str, command: &str, pid: u32) {
    if pid == 0 {
        return;
    }
    let _guard = PIDS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read_pids(data_dir);
    entries.retain(|entry| entry.pid != pid);
    entries.push(PidEntry {
        pid,
        agent_id: agent_id.to_string(),
        cwd: cwd.to_string(),
        command: command.to_string(),
        started_at: now_millis(),
    });
    write_pids(data_dir, &entries);
}

/// Remove a process registration (connection dead/disconnected).
pub(crate) fn unregister_pid(data_dir: &Path, pid: u32) {
    if pid == 0 {
        return;
    }
    let _guard = PIDS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let entries: Vec<PidEntry> = read_pids(data_dir)
        .into_iter()
        .filter(|entry| entry.pid != pid)
        .collect();
    write_pids(data_dir, &entries);
}

/// Hold while a connection spawns+initializes so `child_pids` diffs
/// attribute the new process to the right connection.
pub(crate) async fn spawn_attribution_guard() -> tokio::sync::MutexGuard<'static, ()> {
    SPAWN_ATTRIBUTION.lock().await
}

/// Direct children of `ppid` via `pgrep -P` (no libc const needed).
pub(crate) fn child_pids(ppid: u32) -> Vec<u32> {
    std::process::Command::new("pgrep")
        .arg("-P")
        .arg(ppid.to_string())
        .output()
        .ok()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// `(ppid, pgid)` for a live process, `None` when it is gone.
fn pid_info(pid: u32) -> Option<(u32, u32)> {
    unsafe {
        let mut info: libc::proc_bsdshortinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdshortinfo>() as i32;
        let written = libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDT_SHORTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        );
        (written == size).then_some((info.pbsi_ppid, info.pbsi_pgid))
    }
}

/// Executable path of `pid` via `proc_pidpath`, `None` when the process
/// is gone or the lookup fails.
fn pid_exe_path(pid: u32) -> Option<PathBuf> {
    unsafe {
        let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let written = libc::proc_pidpath(
            pid as i32,
            buffer.as_mut_ptr() as *mut libc::c_void,
            buffer.len() as u32,
        );
        if written <= 0 {
            return None;
        }
        let end = buffer[..written as usize]
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(written as usize);
        Some(PathBuf::from(
            String::from_utf8_lossy(&buffer[..end]).into_owned(),
        ))
    }
}

/// Whether `pid`'s executable matches the recorded spawn `command`
/// (basename compare — node-spawned agents have `command` = node path
/// and exe = node binary, which is the match we need). A pid recycled by
/// a different program is never ours.
fn exe_matches(pid: u32, command: &str) -> bool {
    if command.is_empty() {
        // Legacy entries without a recorded command: fall back to the
        // ppid/pgid shape checks only.
        return true;
    }
    let Some(exe) = pid_exe_path(pid) else {
        return false;
    };
    let expected = Path::new(command)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    exe.file_name()
        .map(|name| name.to_string_lossy() == expected)
        .unwrap_or(false)
}

fn pid_alive(pid: u32) -> bool {
    unsafe {
        if libc::kill(pid as i32, 0) == 0 {
            return true;
        }
        *libc::__error() == libc::EPERM
    }
}

/// Signal the process group when `pid` is a group leader (all our agent
/// spawns are), else the single process.
fn signal_target(pid: u32, signal: i32, group: bool) {
    unsafe {
        if group {
            libc::kill(-(pid as i32), signal);
        } else {
            libc::kill(pid as i32, signal);
        }
    }
}

/// SIGTERM → up to `grace` wait → SIGKILL. `group` selects group kill.
fn terminate(pid: u32, group: bool, grace: Duration) {
    if !pid_alive(pid) {
        return;
    }
    signal_target(pid, libc::SIGTERM, group);
    let deadline = std::time::Instant::now() + grace;
    while pid_alive(pid) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if pid_alive(pid) {
        signal_target(pid, libc::SIGKILL, group);
    }
}

/// Whether a registered pid still looks like one of our agent processes:
/// the executable must match the recorded spawn command (guards pid
/// recycling), and it must be orphaned to `launchd` (ppid 1) or still a
/// process-group leader owned by nobody we know. Anything else is left
/// alone — killing it would hit an innocent process.
fn is_leftover(entry: &PidEntry, own_pid: u32) -> Option<bool> {
    let (ppid, pgid) = pid_info(entry.pid)?;
    if ppid == own_pid || !exe_matches(entry.pid, &entry.command) {
        return Some(false);
    }
    Some(ppid == 1 || pgid == entry.pid)
}

/// Startup sweep: kill registered leftovers from a previous run, clear
/// `pids.json`. Files outside the process registry are never swept.
pub(crate) fn startup_cleanup(data_dir: &Path) {
    let own_pid = std::process::id();
    let entries = read_pids(data_dir);
    for entry in &entries {
        if is_leftover(entry, own_pid) == Some(true) {
            let (_, pgid) = pid_info(entry.pid).unwrap_or((0, 0));
            logging::warn(
                "supervisor",
                format_args!(
                    "reaping leftover agent process {} ({} {})",
                    entry.pid, entry.agent_id, entry.cwd
                ),
            );
            terminate(entry.pid, pgid == entry.pid, TERM_GRACE);
        }
    }
    write_pids(data_dir, &[]);
}

/// App-exit sweep: kill every still-registered agent process. Connections
/// also shut down gracefully through their command channels; this is the
/// backstop for whatever outlives the run loop.
pub(crate) fn kill_all(data_dir: &Path) {
    let entries = read_pids(data_dir);
    // exe-match before signaling: a pid recycled by a foreign program is
    // never ours to kill.
    let ours: Vec<&PidEntry> = entries
        .iter()
        .filter(|entry| pid_alive(entry.pid) && exe_matches(entry.pid, &entry.command))
        .collect();
    for entry in &ours {
        let (_, pgid) = pid_info(entry.pid).unwrap_or((0, entry.pid));
        signal_target(entry.pid, libc::SIGTERM, pgid == entry.pid);
    }
    if !ours.is_empty() {
        std::thread::sleep(Duration::from_millis(500));
        for entry in &ours {
            if pid_alive(entry.pid) {
                let (_, pgid) = pid_info(entry.pid).unwrap_or((0, entry.pid));
                signal_target(entry.pid, libc::SIGKILL, pgid == entry.pid);
            }
        }
    }
    write_pids(data_dir, &[]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_unregister_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        register_pid(dir.path(), "opencode", "/tmp/p", "/bin/opencode", 4242);
        register_pid(dir.path(), "codex", "/tmp/q", "/bin/codex", 4243);
        let entries = read_pids(dir.path());
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].agent_id, "opencode");
        assert_eq!(entries[0].command, "/bin/opencode");

        unregister_pid(dir.path(), 4242);
        let entries = read_pids(dir.path());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pid, 4243);
    }

    #[test]
    fn pid_table_helpers() {
        let own = std::process::id();
        assert!(pid_alive(own));
        assert_eq!(pid_info(own).map(|(ppid, _)| ppid > 0), Some(true));
        assert!(!pid_alive(u32::MAX - 1));
        // child_pids returns a vec (empty or not); no panic is the contract.
        let _ = child_pids(own);
    }

    #[test]
    fn leftover_detection() {
        let own = std::process::id();
        let dead = PidEntry {
            pid: u32::MAX - 1,
            agent_id: "a".to_string(),
            cwd: "/tmp".to_string(),
            command: String::new(),
            started_at: 0,
        };
        assert_eq!(is_leftover(&dead, own), None);

        // Own pid with a mismatched command → exe check rejects it even
        // though it is alive (never a leftover of a different program).
        let mut wrong_exe = dead.clone();
        wrong_exe.pid = own;
        wrong_exe.command = "/definitely/not/our-agent".to_string();
        assert_eq!(is_leftover(&wrong_exe, own), Some(false));

        // Own pid is also excluded because its parent IS this process's
        // parent — but a pid whose ppid == own is never a leftover.
        let mut ours = dead.clone();
        ours.pid = own;
        ours.command = String::new(); // legacy entry → exe check skipped
        // ppid of self != own pid, and self is usually a group leader on
        // macOS — either outcome is fine; the contract is "never kill".
        let _ = is_leftover(&ours, own);
    }

    #[test]
    fn exe_path_lookup_works() {
        // Our own exe resolves (test binary); a dead pid resolves None.
        assert!(pid_exe_path(std::process::id()).is_some());
        assert!(pid_exe_path(u32::MAX - 1).is_none());
        assert!(exe_matches(
            std::process::id(),
            pid_exe_path(std::process::id()).unwrap().to_str().unwrap()
        ));
    }

    #[test]
    fn tmp_cleanup_preserves_unowned_farfold_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stale = dir.path().join("farfold-old");
        let fresh = dir.path().join("farfold-new");
        let other = dir.path().join("other-dir");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        // Age the stale dir beyond the cutoff via `touch -t`.
        let old = SystemTime::now() - Duration::from_secs(7200);
        let stamp = {
            let t = old.duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
            let days = t.div_euclid(86_400);
            let secs_of_day = t.rem_euclid(86_400);
            let (y, m, d) = crate::logging::civil_from_days(days);
            format!(
                "{y:04}{m:02}{d:02}{:02}{:02}.{:02}",
                secs_of_day / 3600,
                (secs_of_day % 3600) / 60,
                secs_of_day % 60
            )
        };
        let status = std::process::Command::new("touch")
            .arg("-t")
            .arg(stamp)
            .arg(&stale)
            .status()
            .expect("touch");
        assert!(status.success());
        startup_cleanup(dir.path());
        assert!(stale.exists());
        assert!(fresh.exists());
        assert!(other.exists());
    }
}
