//! Process supervision for agent connections.
//!
//! `app_data/pids.json` is a recovery hint for exact process identities.
//! Birth time, executable path and uid must still match before signaling.
//! Legacy entries never authorize termination. Normal connections retain their
//! actual Child through wait/reap; this file only covers interrupted app runs.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::logging;
pub(crate) const KILL: i32 = libc::SIGKILL;
pub(crate) const TERM: i32 = libc::SIGTERM;
pub(crate) const HANGUP: i32 = libc::SIGHUP;

/// Grace between SIGTERM and SIGKILL for leftover processes.
const TERM_GRACE: Duration = Duration::from_secs(2);
/// Serialize every `pids.json` read-modify-write.
static PIDS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessIdentity {
    started_sec: u64,
    started_usec: u64,
    executable: PathBuf,
    uid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PidEntry {
    pub pid: u32,
    pub agent_id: String,
    pub cwd: String,
    /// Informational launch command; never authorizes a signal.
    #[serde(default)]
    pub command: String,
    pub started_at: i64,
    /// Old records cannot authorize a signal. Never infer this from command names.
    #[serde(default)]
    pub identity: Option<ProcessIdentity>,
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
pub(crate) fn register_pid(
    data_dir: &Path,
    agent_id: &str,
    cwd: &str,
    command: &str,
    pid: u32,
) -> Result<PidEntry, String> {
    let identity = process_identity(pid).ok_or("无法确认连接进程的身份")?;
    let _guard = PIDS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = read_pids(data_dir);
    entries.retain(|entry| entry.pid != pid);
    let entry = PidEntry {
        pid,
        agent_id: agent_id.to_string(),
        cwd: cwd.to_string(),
        command: command.to_string(),
        started_at: now_millis(),
        identity: Some(identity),
    };
    entries.push(entry.clone());
    std::fs::create_dir_all(data_dir).map_err(|_| "无法保存连接进程")?;
    let raw = serde_json::to_vec(&entries).map_err(|_| "无法保存连接进程")?;
    std::fs::write(pids_path(data_dir), raw).map_err(|_| "无法保存连接进程")?;
    Ok(entry)
}

/// Remove a process registration (connection dead/disconnected).
pub(crate) fn unregister_pid(data_dir: &Path, owned: &PidEntry) {
    let _guard = PIDS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let entries: Vec<PidEntry> = read_pids(data_dir)
        .into_iter()
        .filter(|entry| entry.pid != owned.pid || entry.identity != owned.identity)
        .collect();
    write_pids(data_dir, &entries);
}

fn process_identity(pid: u32) -> Option<ProcessIdentity> {
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let written = libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        );
        if written != size {
            return None;
        }
        Some(ProcessIdentity {
            started_sec: info.pbi_start_tvsec,
            started_usec: info.pbi_start_tvusec,
            executable: pid_exe_path(pid)?,
            uid: info.pbi_uid,
        })
    }
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

/// Full process identity prevents same-binary PID reuse from authorizing a kill.
fn identity_matches(entry: &PidEntry) -> bool {
    entry
        .identity
        .as_ref()
        .is_some_and(|expected| process_identity(entry.pid).as_ref() == Some(expected))
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

/// Only a live process owner may call these with the Child's exact process group.
pub(crate) fn signal_owned_group(pid: u32, signal: i32) {
    signal_target(pid, signal, true);
}
pub(crate) fn owned_group_alive(pid: u32) -> bool {
    unsafe { libc::kill(-(pid as i32), 0) == 0 || *libc::__error() == libc::EPERM }
}

/// Recovery signals are authorized by the saved full identity, never a name.
fn terminate(entry: &PidEntry, group: bool, grace: Duration) {
    if !identity_matches(entry) {
        return;
    }
    signal_target(entry.pid, libc::SIGTERM, group);
    let started = std::time::Instant::now();
    let alive = || {
        if group {
            owned_group_alive(entry.pid)
        } else {
            identity_matches(entry)
        }
    };
    while alive() && started.elapsed() < grace {
        std::thread::sleep(Duration::from_millis(25));
    }
    if alive() {
        signal_target(entry.pid, libc::SIGKILL, group);
    }
    while alive() && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// A full identity must match, and this must be a leftover from an earlier app.
fn is_leftover(entry: &PidEntry, own_pid: u32) -> Option<bool> {
    let (ppid, pgid) = pid_info(entry.pid)?;
    if ppid == own_pid || !identity_matches(entry) {
        return Some(false);
    }
    Some(ppid == 1 || pgid == entry.pid)
}

/// Startup sweep only removes dead records. Unverifiable live records remain untouched.
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
            terminate(entry, pgid == entry.pid, TERM_GRACE);
        }
    }
    // Keep unverifiable live records as evidence; never promote legacy data to authority.
    let remaining: Vec<_> = entries
        .into_iter()
        .filter(|entry| pid_alive(entry.pid) || owned_group_alive(entry.pid))
        .collect();
    write_pids(data_dir, &remaining);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_unregister_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let pid = std::process::id();
        let owned = register_pid(dir.path(), "fixture", "/tmp", "/unused/launcher", pid).unwrap();
        assert!(identity_matches(&owned));
        assert_eq!(read_pids(dir.path()).len(), 1);
        let mut wrong = owned.clone();
        wrong.identity.as_mut().unwrap().started_usec += 1;
        assert!(!identity_matches(&wrong));
        unregister_pid(dir.path(), &wrong);
        assert_eq!(read_pids(dir.path()).len(), 1);
        unregister_pid(dir.path(), &owned);
        assert!(read_pids(dir.path()).is_empty());
    }

    #[test]
    fn pid_table_helpers() {
        let own = std::process::id();
        assert!(pid_alive(own));
        assert_eq!(pid_info(own).map(|(ppid, _)| ppid > 0), Some(true));
        assert!(!pid_alive(u32::MAX - 1));
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
            identity: None,
        };
        assert_eq!(is_leftover(&dead, own), None);

        // A live legacy record remains untrusted even with the exact executable.
        let mut legacy = dead.clone();
        legacy.pid = own;
        legacy.command = pid_exe_path(own).unwrap().to_string_lossy().into_owned();
        assert_eq!(is_leftover(&legacy, own), Some(false));
        assert!(!identity_matches(&legacy));
    }

    #[test]
    fn exe_path_lookup_works() {
        // Our own exe resolves (test binary); a dead pid resolves None.
        assert!(pid_exe_path(std::process::id()).is_some());
        assert!(pid_exe_path(u32::MAX - 1).is_none());
        let identity = process_identity(std::process::id()).unwrap();
        assert_eq!(
            identity.executable,
            pid_exe_path(std::process::id()).unwrap()
        );
    }

    #[test]
    fn recovery_skips_live_legacy_and_same_binary_reused_identity() {
        let dir = tempfile::tempdir().unwrap();
        let pid = std::process::id();
        let mut stale = register_pid(dir.path(), "fixture", "/tmp", "fixture", pid).unwrap();
        stale.identity.as_mut().unwrap().started_usec += 1;
        write_pids(dir.path(), &[stale.clone()]);
        startup_cleanup(dir.path());
        assert!(pid_alive(pid));
        assert_eq!(read_pids(dir.path()), vec![stale.clone()]);
        stale.identity = None;
        write_pids(dir.path(), &[stale.clone()]);
        startup_cleanup(dir.path());
        assert_eq!(read_pids(dir.path()), vec![stale]);
    }

    #[test]
    fn recovery_reaps_descendant_after_leader_exits_on_term() {
        use std::os::unix::process::CommandExt;
        struct Group(std::process::Child);
        impl Drop for Group {
            fn drop(&mut self) {
                signal_owned_group(self.0.id(), libc::SIGKILL);
                let _ = self.0.wait();
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let child_file = dir.path().join("child");
        let mut command = std::process::Command::new("/usr/bin/python3");
        command.args(["-c", "import os,sys,time,signal\npid=os.fork()\nif pid==0:\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n open(sys.argv[1],'w').write(str(os.getpid()))\ntime.sleep(60)"])
            .arg(&child_file).process_group(0);
        let group = Group(command.spawn().unwrap());
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let child: i32 = loop {
            if let Ok(raw) = std::fs::read_to_string(&child_file)
                && let Ok(pid) = raw.parse::<i32>()
                && pid > 0
            {
                break pid;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "child did not publish a complete PID"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        let entry = register_pid(
            dir.path(),
            "fixture",
            "/tmp",
            "/usr/bin/python3",
            group.0.id(),
        )
        .unwrap();
        terminate(&entry, true, TERM_GRACE);
        assert_ne!(
            unsafe { libc::kill(child, 0) },
            0,
            "leader exit does not end descendant ownership"
        );
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
