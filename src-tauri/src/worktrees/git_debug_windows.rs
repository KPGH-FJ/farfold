//! Creation-time process objects for the existing fixed Git executor only.
//! This owner stays on the launching thread and keeps every object until the
//! original Job has a complete, signaled finite set. No PID reopen or reaper.
use std::{
    io,
    marker::PhantomData,
    os::windows::{
        io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command},
    rc::Rc,
};
use windows_sys::Win32::{
    Foundation::{
        DBG_CONTINUE, DBG_EXCEPTION_NOT_HANDLED, DuplicateHandle, ERROR_INVALID_HANDLE,
        ERROR_INVALID_PARAMETER, ERROR_SEM_TIMEOUT, EXCEPTION_BREAKPOINT, HANDLE,
        INVALID_HANDLE_VALUE, NTSTATUS,
    },
    System::{
        Diagnostics::Debug::{
            CREATE_PROCESS_DEBUG_EVENT, ContinueDebugEvent, DEBUG_EVENT, EXCEPTION_DEBUG_EVENT,
            EXIT_PROCESS_DEBUG_EVENT, LOAD_DLL_DEBUG_EVENT, RIP_EVENT, WaitForDebugEvent,
        },
        Threading::{
            DEBUG_PROCESS, DETACHED_PROCESS, GetCurrentProcess, GetProcessId,
            PROCESS_QUERY_INFORMATION, PROCESS_SYNCHRONIZE,
        },
    },
};

struct Member {
    process: OwnedHandle,
    pid: u32,
    initial_breakpoint_seen: bool,
    exit_continued: bool,
}
struct Event {
    raw: DEBUG_EVENT,
    disposition: NTSTATUS,
    exit_member: Option<usize>,
    handled: bool,
    image_closed: bool,
}
impl Event {
    fn new(raw: DEBUG_EVENT) -> Self {
        Self {
            disposition: if raw.dwDebugEventCode == EXCEPTION_DEBUG_EVENT {
                DBG_EXCEPTION_NOT_HANDLED
            } else {
                DBG_CONTINUE
            },
            raw,
            exit_member: None,
            handled: false,
            image_closed: false,
        }
    }
}

pub(super) struct DebugProcesses {
    members: Vec<Member>,
    pending: Option<Event>,
    uncertain: bool,
    #[cfg(test)]
    event_observation: super::command_observation::DebugEvents,
    _launch_thread: PhantomData<Rc<()>>,
}
impl DebugProcesses {
    pub(super) fn new(command: &mut Command) -> io::Result<Self> {
        let mut members = Vec::new();
        members
            .try_reserve_exact(crate::windows_process::DEBUG_MEMBER_LIMIT)
            .map_err(io::Error::other)?;
        command.creation_flags(DETACHED_PROCESS | DEBUG_PROCESS);
        Ok(Self {
            members,
            pending: None,
            uncertain: false,
            #[cfg(test)]
            event_observation: super::command_observation::DebugEvents::default(),
            _launch_thread: PhantomData,
        })
    }
    pub(super) fn drain(
        &mut self,
        group: &crate::process_platform::OwnedGroup,
        child: &Child,
    ) -> io::Result<()> {
        // Bound each pass so the original cancellation, output caps and clock
        // remain checked even while a command generates many debug events.
        for _ in 0..32 {
            if self.confirmed(group, child).unwrap_or(false) {
                return Ok(());
            }
            if self.pending.is_none() {
                let mut raw = DEBUG_EVENT::default();
                // Let the continued process hand off its next loader event
                // before returning to the caller's regular polling interval.
                if unsafe { WaitForDebugEvent(&mut raw, 1) } == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ERROR_SEM_TIMEOUT as i32) {
                        #[cfg(test)]
                        {
                            self.event_observation.empty_wait();
                        }
                        return Ok(());
                    }
                    // A drained debugger can report no attached process. That
                    // result is never an exit witness: accept it only after
                    // the complete original-object certificate succeeds.
                    if self.all_exits_continued()
                        && matches!(
                            error.raw_os_error(),
                            Some(code) if code == ERROR_INVALID_HANDLE as i32
                                || code == ERROR_INVALID_PARAMETER as i32
                        )
                    {
                        return if self.confirmed(group, child).unwrap_or(false) {
                            Ok(())
                        } else {
                            Err(error)
                        };
                    }
                    self.uncertain = true;
                    return Err(error);
                }
                #[cfg(test)]
                {
                    self.event_observation.event_received();
                }
                self.pending = Some(Event::new(raw));
            }
            let was_uncertain = self.uncertain;
            self.uncertain = true;
            // Keep the exact pending event in this owner even across unwind.
            // Cleanup retries Continue on the original launching thread.
            let event = self.pending.as_mut().unwrap();
            let handled = if event.handled {
                Ok(())
            } else {
                let result = Self::handle(&mut self.members, event);
                event.handled = true;
                result
            };
            if unsafe {
                ContinueDebugEvent(
                    event.raw.dwProcessId,
                    event.raw.dwThreadId,
                    event.disposition,
                )
            } == 0
            {
                let error = io::Error::last_os_error();
                // Same event and original thread retry only its continuation.
                return Err(error);
            }
            let event = self.pending.take().unwrap();
            if let Some(index) = event.exit_member {
                self.members[index].exit_continued = true;
            }
            if handled.is_ok() {
                self.uncertain = was_uncertain;
            }
            handled?;
        }
        Ok(())
    }
    fn handle(members: &mut Vec<Member>, event: &mut Event) -> io::Result<()> {
        let raw = &event.raw;
        match raw.dwDebugEventCode {
            CREATE_PROCESS_DEBUG_EVENT => {
                let info = unsafe { raw.u.CreateProcessInfo };
                if !event.image_closed {
                    close_image(info.hFile);
                    event.image_closed = true;
                }
                if members.len() == crate::windows_process::DEBUG_MEMBER_LIMIT
                    || members.iter().any(|member| member.pid == raw.dwProcessId)
                {
                    return Err(io::Error::other("程序进程观察超出范围"));
                }
                let process = retain(info.hProcess)?;
                if unsafe { GetProcessId(process.as_raw_handle()) } != raw.dwProcessId {
                    return Err(io::Error::other("程序进程身份发生变化"));
                }
                members.push(Member {
                    process,
                    pid: raw.dwProcessId,
                    initial_breakpoint_seen: false,
                    exit_continued: false,
                });
            }
            LOAD_DLL_DEBUG_EVENT => {
                if !event.image_closed {
                    close_image(unsafe { raw.u.LoadDll.hFile });
                    event.image_closed = true;
                }
            }
            EXIT_PROCESS_DEBUG_EVENT => {
                let index = members
                    .iter()
                    .position(|member| member.pid == raw.dwProcessId)
                    .ok_or_else(|| io::Error::other("程序进程退出身份尚未确认"))?;
                if members[index].exit_continued {
                    return Err(io::Error::other("程序进程退出重复"));
                }
                event.exit_member = Some(index);
            }
            EXCEPTION_DEBUG_EVENT => {
                let exception = unsafe { raw.u.Exception };
                let member = members
                    .iter_mut()
                    .find(|member| member.pid == raw.dwProcessId)
                    .ok_or_else(|| io::Error::other("程序进程异常身份尚未确认"))?;
                if exception.dwFirstChance != 0
                    && exception.ExceptionRecord.ExceptionCode == EXCEPTION_BREAKPOINT
                    && !member.initial_breakpoint_seen
                {
                    member.initial_breakpoint_seen = true;
                    event.disposition = DBG_CONTINUE;
                }
            }
            RIP_EVENT => return Err(io::Error::other("无法确认程序进程观察")),
            _ => {}
        }
        Ok(())
    }
    fn all_exits_continued(&self) -> bool {
        self.pending.is_none()
            && !self.members.is_empty()
            && self.members.iter().all(|member| member.exit_continued)
    }
    #[cfg(test)]
    pub(super) fn observation(&self) -> serde_json::Value {
        let (events, empty_waits) = self.event_observation.counts();
        serde_json::json!({
            "capturedMemberCount": self.members.len(),
            "capturedMemberPids": self.members.iter().map(|member| member.pid).collect::<Vec<_>>(),
            "allExitContinued": self.all_exits_continued(),
            "unresolvedDebugError": self.uncertain,
            "debugEventCount": events,
            "debugEmptyWaitCount": empty_waits,
        })
    }
    pub(super) fn confirmed(
        &self,
        group: &crate::process_platform::OwnedGroup,
        child: &Child,
    ) -> io::Result<bool> {
        if self.uncertain || !self.all_exits_continued() {
            return Ok(false);
        }
        group.debugged_members_inactive(
            child.as_handle(),
            self.members.iter().map(|member| member.process.as_handle()),
        )
    }
}
fn retain(process: HANDLE) -> io::Result<OwnedHandle> {
    let mut duplicate = std::ptr::null_mut();
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            process,
            GetCurrentProcess(),
            &mut duplicate,
            PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            0,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(duplicate) })
}
fn close_image(handle: HANDLE) {
    if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
        drop(unsafe { OwnedHandle::from_raw_handle(handle) });
    }
}
