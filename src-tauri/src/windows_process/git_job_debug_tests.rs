//! Test-only debugger for fixed Git. Debug stops perturb scheduling.
use super::*;
use std::{io, os::windows::process::CommandExt};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, DBG_CONTINUE, DBG_EXCEPTION_NOT_HANDLED, DuplicateHandle, ERROR_SEM_TIMEOUT,
        EXCEPTION_BREAKPOINT, INVALID_HANDLE_VALUE, NTSTATUS,
    },
    System::{
        Diagnostics::Debug::{
            CREATE_PROCESS_DEBUG_EVENT, ContinueDebugEvent, DEBUG_EVENT, DebugActiveProcessStop,
            EXCEPTION_DEBUG_EVENT, EXIT_PROCESS_DEBUG_EVENT, LOAD_DLL_DEBUG_EVENT, RIP_EVENT,
            WaitForDebugEvent,
        },
        Threading::{
            DEBUG_PROCESS, DETACHED_PROCESS, GetProcessId, PROCESS_QUERY_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    },
};

struct Event(DEBUG_EVENT, bool);
impl Event {
    fn advance(mut self, disposition: NTSTATUS) {
        self.1 = true;
        assert_ne!(
            unsafe { ContinueDebugEvent(self.0.dwProcessId, self.0.dwThreadId, disposition) },
            0,
            "{}",
            io::Error::last_os_error()
        );
    }
}
impl Drop for Event {
    fn drop(&mut self) {
        if !self.1 {
            let disposition = if self.0.dwDebugEventCode == EXCEPTION_DEBUG_EVENT {
                DBG_EXCEPTION_NOT_HANDLED
            } else {
                DBG_CONTINUE
            };
            unsafe { ContinueDebugEvent(self.0.dwProcessId, self.0.dwThreadId, disposition) };
        }
    }
}

struct Debugger {
    helper: Child,
    group: OwnedGroup,
    members: Vec<Member>,
    complete: bool,
}
impl Drop for Debugger {
    fn drop(&mut self) {
        if !self.complete {
            // Never block in Drop: an outstanding debug event may still need
            // its original thread. Kill-on-close stays with the original Job.
            self.group.terminate();
            for member in &self.members {
                if member.exit.is_none() {
                    unsafe { DebugActiveProcessStop(member.pid) };
                }
            }
            if self.members.is_empty() {
                unsafe { DebugActiveProcessStop(self.helper.id()) };
            }
        }
    }
}

struct Member {
    pid: u32,
    handle: Handle,
    in_job: Option<bool>,
    initial_breakpoint_seen: bool,
    exit: Option<Exit>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit {
    debug_exit_code: u32,
    before_continue: Sample,
    after_continue: Sample,
}

fn close_image(handle: HANDLE) {
    if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
        unsafe { CloseHandle(handle) };
    }
}
fn belongs(process: &Handle, group: &OwnedGroup) -> bool {
    let mut in_job = 0;
    assert_ne!(
        unsafe { IsProcessInJob(process.0, group.job.handle.0, &mut in_job) },
        0
    );
    in_job != 0
}
fn retain(process: HANDLE, pid: u32) -> Member {
    let mut duplicate = std::ptr::null_mut();
    assert_ne!(
        unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                process,
                GetCurrentProcess(),
                &mut duplicate,
                PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                0,
            )
        },
        0,
        "{}",
        io::Error::last_os_error()
    );
    let handle = Handle(duplicate);
    assert_eq!(unsafe { GetProcessId(handle.0) }, pid);
    Member {
        pid,
        handle,
        in_job: None,
        initial_breakpoint_seen: false,
        exit: None,
    }
}

pub(super) fn run() {
    let directory = tempfile::tempdir().unwrap();
    let executable = pinned_git();
    let mut command = Command::new(&executable.path);
    command
        .args(["hash-object", "--stdin", "--no-filters"])
        .current_dir(directory.path());
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(name);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "NUL");
    let pending =
        super::super::super::super::prepare_noninteractive_git_command(&mut command).unwrap();
    // Start the original wrapper itself in debug mode on this test thread.
    // The wrapper retains normal detached Git mode and admits Git to its Job.
    let mut helper = command
        .creation_flags(DETACHED_PROCESS | DEBUG_PROCESS)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let helper_pid = helper.id();
    let group = pending.attach(helper_pid).unwrap_or_else(|error| {
        let _ = helper.kill();
        unsafe { DebugActiveProcessStop(helper_pid) };
        panic!("cannot retain original debug wrapper: {error}");
    });
    let mut debugger = Debugger {
        helper,
        group,
        members: Vec::new(),
        complete: false,
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut events = 0;
    let mut selected = None;
    loop {
        assert!(Instant::now() < deadline, "Git debug events did not drain");
        let mut raw = DEBUG_EVENT::default();
        if unsafe { WaitForDebugEvent(&mut raw, 100) } == 0 {
            let error = io::Error::last_os_error();
            assert_eq!(
                error.raw_os_error(),
                Some(ERROR_SEM_TIMEOUT as i32),
                "{error}"
            );
            continue;
        }
        let event = Event(raw, false);
        events += 1;
        let pid = raw.dwProcessId;
        let mut disposition = DBG_CONTINUE;
        let mut exiting = None;
        let mut release_stdin = false;
        match raw.dwDebugEventCode {
            CREATE_PROCESS_DEBUG_EVENT => {
                let create = unsafe { raw.u.CreateProcessInfo };
                // Windows closes the original event process/thread handles at
                // EXIT Continue. Its separate image handle is ours to close.
                close_image(create.hFile);
                assert!(debugger.members.len() < 32, "Git debug member cap exceeded");
                assert!(!debugger.members.iter().any(|member| member.pid == pid));
                let mut member = retain(create.hProcess, pid);
                if pid != helper_pid {
                    member.in_job = Some(belongs(&member.handle, &debugger.group));
                    if selected.is_none() {
                        selected = Some(pid);
                        let leader = debugger
                            .members
                            .iter_mut()
                            .find(|member| member.pid == helper_pid)
                            .unwrap();
                        // Initial wrapper CREATE precedes the wrapper's own
                        // Job entry. First descendant CREATE is after entry.
                        leader.in_job = Some(belongs(&leader.handle, &debugger.group));
                        release_stdin = true;
                    }
                }
                debugger.members.push(member);
            }
            LOAD_DLL_DEBUG_EVENT => close_image(unsafe { raw.u.LoadDll.hFile }),
            EXIT_PROCESS_DEBUG_EVENT => {
                let member = debugger
                    .members
                    .iter_mut()
                    .find(|member| member.pid == pid)
                    .unwrap();
                assert!(member.exit.is_none());
                let before =
                    Sample::observe(&debugger.group, &debugger.helper, Some(&member.handle));
                exiting = Some((member, unsafe { raw.u.ExitProcess.dwExitCode }, before));
            }
            EXCEPTION_DEBUG_EVENT => {
                let exception = unsafe { raw.u.Exception };
                let member = debugger
                    .members
                    .iter_mut()
                    .find(|member| member.pid == pid)
                    .unwrap();
                if exception.dwFirstChance != 0
                    && exception.ExceptionRecord.ExceptionCode == EXCEPTION_BREAKPOINT
                    && !member.initial_breakpoint_seen
                {
                    member.initial_breakpoint_seen = true;
                } else {
                    disposition = DBG_EXCEPTION_NOT_HANDLED;
                }
            }
            RIP_EVENT => panic!("Windows reported a Git debugger RIP event"),
            _ => {}
        }
        event.advance(disposition);
        if release_stdin {
            drop(debugger.helper.stdin.take().unwrap());
        }
        if let Some((member, debug_exit_code, before_continue)) = exiting {
            // Sample without blocking the event pump. Require actual object
            // signals only once all observed EXIT events have been continued.
            let after_continue =
                Sample::observe(&debugger.group, &debugger.helper, Some(&member.handle));
            member.exit = Some(Exit {
                debug_exit_code,
                before_continue,
                after_continue,
            });
        }
        if !debugger.members.is_empty()
            && debugger.members.iter().all(|member| member.exit.is_some())
        {
            break;
        }
    }

    assert!(selected.is_some(), "no actual Git process was observed");
    let receipts: Vec<_> = debugger.members.iter().map(|member| {
        let wait_ms = deadline.saturating_duration_since(Instant::now()).as_millis() as u32;
        let final_wait = unsafe { WaitForSingleObject(member.handle.0, wait_ms) };
        assert_eq!(final_wait, WAIT_OBJECT_0);
        serde_json::json!({
            "role": if member.pid == helper_pid { "originalWrapper" } else if Some(member.pid) == selected { "selectedGit" } else { "gitDescendant" },
            "verifiedOriginalJob": member.in_job,
            "exit": member.exit,
            "exactFinalWait": final_wait,
        })
    }).collect();
    assert!(debugger.helper.wait().unwrap().success());
    let known_original_members = debugger
        .members
        .iter()
        .filter(|member| member.in_job == Some(true))
        .count();
    debugger.members.clear();
    let final_sample = Sample::observe(&debugger.group, &debugger.helper, None);
    executable.verify().unwrap();
    debugger.complete = true;
    eprintln!(
        "FARFOLD_WINDOWS_ACTUAL_GIT_DEBUG_MEMBERS {}",
        serde_json::json!({
            "fixedCommand": "hash-object --stdin --no-filters",
            "detached": true,
            "debuggerChangesScheduling": true,
            "selectedAbsolutePathGitMayBeLauncher": true,
            "debugEvents": events,
            "knownOriginalMembers": known_original_members,
            "observedMemberCountMatchesJobTotal": final_sample.total_processes == Some(known_original_members as u32),
            "members": receipts,
            "afterCreationHandleRelease": final_sample,
        })
    );
}
