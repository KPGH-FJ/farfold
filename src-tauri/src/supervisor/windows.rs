//! Kernel Jobs own Windows descendants, including after the parent app exits.
//! Saved numeric PIDs never authorize Windows termination; no new recovery table.
use std::path::Path;
pub(crate) const KILL: i32 = 9;
pub(crate) const TERM: i32 = 15;
pub(crate) const HANGUP: i32 = 1;
pub(crate) struct PidEntry;
pub(crate) fn register_pid(
    _data_dir: &Path,
    _agent_id: &str,
    _cwd: &str,
    _command: &str,
    pid: u32,
) -> Result<PidEntry, String> {
    if crate::windows_process::owns(pid) {
        Ok(PidEntry)
    } else {
        Err("无法确认连接进程的身份".into())
    }
}
pub(crate) fn unregister_pid(_data_dir: &Path, _owned: &PidEntry) {}
pub(crate) fn startup_cleanup(_data_dir: &Path) {}
pub(crate) fn signal_owned_group(pid: u32, _signal: i32) {
    crate::windows_process::terminate(pid);
}
pub(crate) fn owned_group_alive(pid: u32) -> bool {
    crate::windows_process::active(pid)
}
