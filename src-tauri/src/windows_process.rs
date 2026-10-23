//! Windows launch ownership, independent of any Agent protocol or credentials.
//! A trusted Farfold helper enters the parent's Job before starting selected argv.
//! The parent alone retains the Job handle; its exit closes the whole process tree.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, SetLastError, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, OpenJobObjectW,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::SystemServices::{JOB_OBJECT_ASSIGN_PROCESS, JOB_OBJECT_QUERY};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
};

#[path = "windows_process/current_members.rs"]
mod current_members;

const HELPER: &str = "--farfold-owned-process";
const PREFIX: &str = "Local\\Farfold-process-";

struct Handle(HANDLE);
// Job handles are kernel references, safe to query/terminate concurrently. No
// borrowed process pointer crosses threads, and CloseHandle has one RAII owner.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Job {
    handle: Handle,
    name: String,
    leader: OnceLock<Leader>,
    stopping: AtomicBool,
    current: Mutex<current_members::Current>,
}
struct Leader {
    pid: u32,
    handle: Handle,
}
// One stack-owned result of the EXISTING Job accounting query, no new handle.
struct ActivityQuery {
    ok: i32,
    info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    #[cfg(test)]
    native_error: Option<u32>,
}
impl ActivityQuery {
    fn not_confirmed_inactive(&self) -> bool {
        // A failed query is not proof of process termination.
        self.ok == 0 || self.info.ActiveProcesses != 0
    }
}
impl Job {
    fn create() -> io::Result<Arc<Self>> {
        let mut random = [0u8; 16];
        if unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                random.as_mut_ptr(),
                random.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } < 0
        {
            return Err(io::Error::other("无法准备程序进程"));
        }
        let name = format!(
            "{PREFIX}{}",
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let wide = wide(OsStr::new(&name))?;
        unsafe {
            SetLastError(0);
        }
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), wide.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let handle = Handle(handle);
        // A pre-existing named object is never accepted as launch authority.
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return Err(io::Error::other("程序进程标识已存在"));
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                handle.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Arc::new(Self {
            handle,
            name,
            leader: OnceLock::new(),
            stopping: AtomicBool::new(false),
            current: Mutex::new(current_members::Current::new()?),
        }))
    }
    fn terminate(&self) {
        self.stopping.store(true, Ordering::Release);
        // Capture currently visible original members BEFORE requesting their
        // asynchronous termination. Failed lookups remain in the same owner.
        self.observe_current();
        unsafe {
            // Cancellation can arrive before the helper enters the Job. Retain
            // and terminate its exact kernel object, then all Job descendants.
            if let Some(leader) = self.leader.get() {
                TerminateProcess(leader.handle.0, 1);
            }
            TerminateJobObject(self.handle.0, 1);
        }
    }
    fn active(&self) -> bool {
        self.active_from_query(&self.activity_query())
    }
    fn observe_current(&self) -> bool {
        self.observe_current_from_query(&self.activity_query())
    }
    fn observe_current_from_query(&self, query: &ActivityQuery) -> bool {
        self.current.lock().map_or(true, |mut current| {
            current.observe(
                self.handle.0,
                self.leader.get().map(|leader| leader.pid),
                (query.ok != 0).then_some(query.info.ActiveProcesses),
            )
        })
    }
    fn retirement_unknown(&self) -> bool {
        self.current
            .lock()
            .map_or(true, |current| current.unknown())
    }
    fn active_from_query(&self, query: &ActivityQuery) -> bool {
        let leader_active = self.leader.get().is_some_and(|leader| unsafe {
            WaitForSingleObject(leader.handle.0, 0) != WAIT_OBJECT_0
        });
        if leader_active && !self.stopping.load(Ordering::Acquire) {
            // Ordinary long-running work does not accumulate member history.
            // The exact original leader also covers its pre-Job-entry interval.
            return true;
        }
        let current_active = self.observe_current_from_query(query);
        if query.not_confirmed_inactive() || leader_active || current_active {
            return true;
        }
        // A member could appear during the bounded observation. Keep the old
        // accounting condition too; held-member waits never replace it.
        let final_query = self.activity_query();
        if final_query.ok == 0
            && let Ok(mut current) = self.current.lock()
        {
            current.query_unknown();
        }
        final_query.not_confirmed_inactive()
    }
    fn activity_query(&self) -> ActivityQuery {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(
                self.handle.0,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        };
        #[cfg(test)]
        let native_error = if ok == 0 {
            // Capture immediately: no other API/logging precedes GetLastError.
            Some(unsafe { GetLastError() })
        } else {
            None
        };
        ActivityQuery {
            ok,
            info,
            #[cfg(test)]
            native_error,
        }
    }
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut text: Vec<_> = value.encode_wide().collect();
    if text.contains(&0) {
        return Err(io::Error::other("程序参数无效"));
    }
    text.push(0);
    Ok(text)
}
fn groups() -> &'static Mutex<HashMap<u32, Weak<Job>>> {
    static GROUPS: OnceLock<Mutex<HashMap<u32, Weak<Job>>>> = OnceLock::new();
    GROUPS.get_or_init(Default::default)
}

/// Holds the Job before the helper exists. Dropping a failed launch cannot leave
/// an Agent: the helper has not entered the Job or starts under this Job.
pub(crate) struct PendingGroup(Arc<Job>);
impl PendingGroup {
    /// The caller must retain its original Child (and Windows process handle)
    /// throughout this call. All std/async/PTY spawn owners do so: Windows cannot
    /// reuse that PID while the original process object has a retained handle.
    fn attach(&self, pid: u32) -> io::Result<OwnedGroup> {
        let leader = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if leader.is_null() {
            return Err(io::Error::last_os_error());
        }
        self.0
            .leader
            .set(Leader {
                pid,
                handle: Handle(leader),
            })
            .map_err(|_| io::Error::other("程序进程已登记"))?;
        let mut groups = groups()
            .lock()
            .map_err(|_| io::Error::other("无法登记程序进程"))?;
        if groups.get(&pid).and_then(Weak::upgrade).is_some() {
            self.0.terminate();
            return Err(io::Error::other("程序进程已登记"));
        }
        groups.insert(pid, Arc::downgrade(&self.0));
        Ok(OwnedGroup {
            pid,
            job: self.0.clone(),
        })
    }
    /// A failed registration has no usable registry entry. Keep this direct Job
    /// owner and the caller's exact Child until both termination facts hold.
    /// The reap closure kills/polls only that Child, including before Job entry.
    pub(crate) fn attach_or_reap(
        &self,
        pid: Option<u32>,
        mut reap: impl FnMut() -> bool,
    ) -> io::Result<OwnedGroup> {
        match pid
            .ok_or_else(|| io::Error::other("无法确认程序进程"))
            .and_then(|pid| self.attach(pid))
        {
            Ok(group) => Ok(group),
            Err(error) => {
                let mut reaped = false;
                loop {
                    self.0.terminate();
                    reaped = reaped || reap();
                    if reaped && !self.0.active() {
                        return Err(error);
                    }
                    // A query/reap failure is unknown, never an early release of
                    // the caller's configuration, authentication or job permit.
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
            }
        }
    }
    pub(crate) fn helper_argv(
        &self,
        program: &OsStr,
        args: impl IntoIterator<Item = OsString>,
        terminal: bool,
    ) -> Vec<OsString> {
        [
            OsString::from(HELPER),
            OsString::from(&self.0.name),
            OsString::from(if terminal { "pty" } else { "stdio" }),
            program.to_owned(),
        ]
        .into_iter()
        .chain(args)
        .collect()
    }
}
pub(crate) struct OwnedGroup {
    pid: u32,
    job: Arc<Job>,
}
impl OwnedGroup {
    pub(crate) fn terminate(&self) {
        self.job.terminate();
    }
    pub(crate) fn active(&self) -> bool {
        self.job.active()
    }
    pub(crate) fn retirement_unknown(&self) -> bool {
        self.job.retirement_unknown()
    }
}
impl Drop for OwnedGroup {
    fn drop(&mut self) {
        self.job.terminate();
        if let Ok(mut groups) = groups().lock()
            && groups
                .get(&self.pid)
                .is_some_and(|job| job.ptr_eq(&Arc::downgrade(&self.job)))
        {
            groups.remove(&self.pid);
        }
    }
}
pub(crate) fn pending() -> io::Result<PendingGroup> {
    Job::create().map(PendingGroup)
}

/// Rebuild only executable/argv; preserve the selected cwd and every explicit
/// environment override/removal. Callers set their own stdio after this step.
pub(crate) fn prepare_command(command: &mut Command) -> io::Result<PendingGroup> {
    use std::os::windows::process::CommandExt;
    let pending = pending()?;
    let mut helper = Command::new(helper_executable()?);
    helper.args(pending.helper_argv(
        command.get_program(),
        command.get_args().map(OsStr::to_owned),
        false,
    ));
    if let Some(cwd) = command.get_current_dir() {
        helper.current_dir(cwd);
    }
    for (name, value) in command.get_envs() {
        match value {
            Some(value) => {
                helper.env(name, value);
            }
            None => {
                helper.env_remove(name);
            }
        }
    }
    helper.creation_flags(CREATE_NO_WINDOW);
    *command = helper;
    Ok(pending)
}

pub(crate) fn helper_executable() -> io::Result<std::path::PathBuf> {
    #[cfg(not(test))]
    {
        std::env::current_exe()
    }
    #[cfg(test)]
    {
        Ok(behavior_tests::fixture())
    }
}

pub(crate) fn terminate(pid: u32) {
    let original = groups()
        .lock()
        .ok()
        .and_then(|groups| groups.get(&pid).and_then(Weak::upgrade));
    if let Some(job) = original {
        job.terminate();
    }
}
pub(crate) fn owns(pid: u32) -> bool {
    groups()
        .lock()
        .is_ok_and(|groups| groups.get(&pid).and_then(Weak::upgrade).is_some())
}
pub(crate) fn active(pid: u32) -> bool {
    let original = match groups().lock() {
        Ok(groups) => groups.get(&pid).and_then(Weak::upgrade),
        Err(_) => return true,
    };
    // Only registry lookup uses the shared mutex. The original Arc retains
    // this exact Job while native observation runs independently of other
    // Agents' registration and cancellation.
    original.is_some_and(|job| job.active())
}

fn valid_job_name(name: &OsStr) -> bool {
    name.to_str()
        .and_then(|name| name.strip_prefix(PREFIX))
        .is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
fn enter_job(name: &OsStr) -> io::Result<()> {
    if !valid_job_name(name) {
        return Err(io::Error::other("程序进程标识无效"));
    }
    let wide = wide(name)?;
    let raw = unsafe {
        OpenJobObjectW(
            JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_QUERY,
            0,
            wide.as_ptr(),
        )
    };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = Handle(raw);
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    let queried = unsafe {
        QueryInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
            std::ptr::null_mut(),
        )
    };
    if queried == 0 || limits.BasicLimitInformation.LimitFlags != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    {
        return Err(io::Error::other("程序进程保护未确认"));
    }
    if unsafe { AssignProcessToJobObject(job.0, GetCurrentProcess()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // Crucial: only the parent retains a Job handle before selected code runs.
    // If the parent already died, closing this last handle kills this helper.
    drop(job);
    Ok(())
}

/// Called from main before Tauri, logging, single-instance handling or secrets.
/// This is OS process ownership only, never an Agent or shell command parser.
pub(crate) fn run_if_requested() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(HELPER)) {
        return None;
    }
    let mut failure_phase = "准备启动参数";
    let result = (|| {
        let name = args.next().ok_or_else(|| io::Error::other("missing job"))?;
        let terminal = match args.next().as_deref() {
            Some(mode) if mode == "pty" => true,
            Some(mode) if mode == "stdio" => false,
            _ => return Err(io::Error::other("invalid launch mode")),
        };
        let program = args
            .next()
            .filter(|arg| !arg.is_empty())
            .ok_or_else(|| io::Error::other("missing program"))?;
        failure_phase = "加入进程保护";
        enter_job(&name)?;
        let mut command = Command::new(Path::new(&program));
        if !terminal {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        failure_phase = "执行或等待程序";
        let status = command
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()?;
        Ok::<_, io::Error>(status.code().unwrap_or(1))
    })();
    Some(match result {
        Ok(code) => code,
        Err(error) => {
            eprintln!("无法启动所选程序");
            // Only a fixed phase and numeric system code; never selected argv,
            // paths, environment values or credential-bearing diagnostics.
            if let Some(code) = error.raw_os_error() {
                eprintln!("{failure_phase}时失败，系统错误：{code}");
            } else {
                eprintln!("{failure_phase}时失败，系统未提供错误码");
            }
            126
        }
    })
}

#[cfg(test)]
#[path = "windows_process/behavior_tests.rs"]
mod behavior_tests;
#[cfg(test)]
#[path = "windows_process/git_activity_observation_tests.rs"]
pub(crate) mod git_activity_observation;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_never_accept_foreign_or_partial_jobs() {
        assert!(valid_job_name(OsStr::new(&format!(
            "{PREFIX}{}",
            "1a".repeat(16)
        ))));
        for name in [
            "",
            "Global\\Farfold-process-",
            "Local\\Other",
            "Local\\Farfold-process-../other",
        ] {
            assert!(!valid_job_name(OsStr::new(name)));
        }
    }
    #[test]
    fn prepared_command_preserves_explicit_values_and_literal_argv() {
        let mut command = Command::new("C:\\Program Files\\fixture.exe");
        command
            .args(["space value", "& %PATH% literal", ""])
            .current_dir("C:\\work")
            .env("FIXTURE_ONLY", "value")
            .env_remove("REMOVED_FIXTURE");
        let pending = prepare_command(&mut command).unwrap();
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args[0], HELPER);
        assert_eq!(args[1], OsStr::new(&pending.0.name));
        assert_eq!(args[2], "stdio");
        assert_eq!(
            &args[3..],
            [
                "C:\\Program Files\\fixture.exe",
                "space value",
                "& %PATH% literal",
                ""
            ]
            .map(OsStr::new)
        );
        assert_eq!(command.get_current_dir(), Some(Path::new("C:\\work")));
        assert_eq!(
            command
                .get_envs()
                .collect::<HashMap<_, _>>()
                .get(OsStr::new("REMOVED_FIXTURE")),
            Some(&None)
        );
    }
}

#[cfg(test)]
#[path = "windows_process/diagnostic_tests.rs"]
mod diagnostic_tests;
#[cfg(test)]
pub(crate) use diagnostic_tests::read_only_job_witness_for_test;
