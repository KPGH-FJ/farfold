//! Finite current-member observations for the ORIGINAL Job, not a process ledger.
//! A snapshot cannot prove completeness for arbitrary previously vanished members.
//! Held objects and unresolved candidates survive later empty/failed snapshots.
use super::Handle;
use std::{io, mem::size_of};
use windows_sys::Win32::{
    Foundation::{ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        JobObjects::{
            IsProcessInJob, JOBOBJECT_BASIC_PROCESS_ID_LIST, JobObjectBasicProcessIdList,
            QueryInformationJobObject,
        },
        Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            WaitForSingleObject,
        },
    },
};

const CAPACITY: usize = 256;
struct Member {
    pid: u32,
    handle: Handle,
    admitted: bool,
}
pub(super) struct Current {
    held: Vec<Member>,
    pending: Vec<u32>,
    coverage_gap: bool,
    observation_unknown: bool,
}
#[cfg(test)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CurrentObservation {
    held_count: usize,
    admitted_count: usize,
    unresolved_candidate_count: usize,
    coverage_gap: bool,
    observation_unknown: bool,
    admitted_pids: Vec<u32>,
}
enum Lookup {
    Gone,
    Object(Handle),
}
impl Current {
    #[cfg(test)]
    pub(super) fn observation(&self) -> CurrentObservation {
        // Only inspect already owned objects. No query, PID reopen, wait,
        // retry or change to the production decision accompanies this record.
        let admitted_pids: Vec<_> = self
            .held
            .iter()
            .filter(|member| member.admitted)
            .map(|member| member.pid)
            .collect();
        CurrentObservation {
            held_count: self.held.len(),
            admitted_count: admitted_pids.len(),
            unresolved_candidate_count: self.pending.len(),
            coverage_gap: self.coverage_gap,
            observation_unknown: self.observation_unknown,
            admitted_pids,
        }
    }
    pub(super) fn new() -> io::Result<Self> {
        let mut held = Vec::new();
        let mut pending = Vec::new();
        held.try_reserve_exact(CAPACITY).map_err(io::Error::other)?;
        pending
            .try_reserve_exact(CAPACITY)
            .map_err(io::Error::other)?;
        Ok(Self {
            held,
            pending,
            coverage_gap: false,
            observation_unknown: false,
        })
    }
    /// One bounded observation, with no worker and no blocking process wait.
    /// Pending PIDs confer no termination authority. An incomplete observation
    /// when this SAME accounting query does not prove an empty Job creates a gap:
    /// later empty lists cannot identify members that disappeared in between.
    pub(super) fn observe(
        &mut self,
        job: HANDLE,
        leader: Option<u32>,
        associated: Option<u32>,
    ) -> bool {
        self.observe_using(job, leader, associated, || list(job), native_lookup)
    }
    pub(super) fn unknown(&self) -> bool {
        self.coverage_gap || self.observation_unknown
    }
    pub(super) fn query_unknown(&mut self) {
        self.observation_unknown = true;
    }
    fn incomplete(&mut self, associated: Option<u32>) -> bool {
        self.coverage_gap |= associated != Some(0);
        self.observation_unknown = true;
        true
    }
    fn observe_using(
        &mut self,
        job: HANDLE,
        leader: Option<u32>,
        associated: Option<u32>,
        snapshot: impl FnOnce() -> io::Result<Listed>,
        mut lookup: impl FnMut(u32) -> io::Result<Lookup>,
    ) -> bool {
        self.observation_unknown = associated.is_none();
        if self.poll_held(job).is_err() {
            return self.incomplete(associated);
        }
        self.resolve_pending(&mut lookup);
        if self.poll_held(job).is_err() || !self.pending.is_empty() {
            return self.incomplete(associated);
        }
        let listed = match snapshot() {
            Ok(value) => value,
            Err(_) => return self.incomplete(associated),
        };
        // Every newly listed candidate fits the finite pending array. A full
        // held array defers opens, retaining candidates rather than discarding
        // an object or silently accepting a partial observation.
        for &pid in listed.ids() {
            if Some(pid) != leader && !self.held.iter().any(|member| member.pid == pid) {
                self.pending.push(pid);
            }
        }
        self.resolve_pending(lookup);
        if self.poll_held(job).is_err() || !self.pending.is_empty() {
            // This iteration DID enumerate the complete current list. Keep
            // every actual candidate and report uncertainty; only a later
            // skipped enumeration when not proven empty establishes a gap.
            self.observation_unknown = true;
            return true;
        }
        self.unknown() || !self.held.is_empty()
    }
    fn resolve_pending(&mut self, mut lookup: impl FnMut(u32) -> io::Result<Lookup>) {
        let mut index = 0;
        while index < self.pending.len() {
            if self.held.len() == CAPACITY {
                // Later actual signals make capacity available. No launch,
                // termination, automatic cancellation or new thread occurs.
                break;
            }
            let pid = self.pending[index];
            match lookup(pid) {
                Ok(Lookup::Gone) => {
                    self.pending.swap_remove(index);
                }
                Ok(Lookup::Object(handle)) => {
                    self.held.push(Member {
                        pid,
                        handle,
                        admitted: false,
                    });
                    self.pending.swap_remove(index);
                }
                Err(_) => {
                    index += 1;
                }
            }
        }
    }
    fn poll_held(&mut self, job: HANDLE) -> io::Result<()> {
        let mut failed = false;
        let mut index = 0;
        while index < self.held.len() {
            let member = &mut self.held[index];
            if !member.admitted {
                let mut belongs = 0;
                let queried = unsafe { IsProcessInJob(member.handle.0, job, &mut belongs) };
                if queried == 0 {
                    failed = true;
                    index += 1;
                    continue;
                }
                if belongs == 0 {
                    // This PID was listed by the original Job, but the opened
                    // object is foreign now. The old process object no longer
                    // owns that PID. Never wait on or terminate this foreign one.
                    self.held.swap_remove(index);
                    continue;
                }
                member.admitted = true;
            }
            match unsafe { WaitForSingleObject(member.handle.0, 0) } {
                WAIT_OBJECT_0 => {
                    self.held.swap_remove(index);
                }
                WAIT_TIMEOUT => {
                    index += 1;
                }
                _ => {
                    failed = true;
                    index += 1;
                }
            }
        }
        if failed {
            Err(io::Error::other("程序退出状态尚未确认"))
        } else {
            Ok(())
        }
    }
}
fn native_lookup(pid: u32) -> io::Result<Lookup> {
    // Only validated, nonzero DWORD process IDs from this Job reach here.
    // No TERMINATE rights and no privilege adjustment for a listed candidate.
    let raw = unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        )
    };
    if !raw.is_null() {
        return Ok(Lookup::Object(Handle(raw)));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
        // Same nonzero-PID interpretation used by the official .NET runtime's
        // ProcessManager.IsProcessRunning. Access errors remain unresolved.
        Ok(Lookup::Gone)
    } else {
        Err(error)
    }
}
#[repr(C)]
struct NativeList {
    assigned: u32,
    listed: u32,
    ids: [usize; CAPACITY],
}
struct Listed {
    len: usize,
    ids: [u32; CAPACITY],
}
impl Listed {
    fn ids(&self) -> &[u32] {
        &self.ids[..self.len]
    }
}
fn list(job: HANDLE) -> io::Result<Listed> {
    let mut native = NativeList {
        assigned: 0,
        listed: 0,
        ids: [0; CAPACITY],
    };
    let mut written = 0;
    let ok = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicProcessIdList,
            (&mut native as *mut NativeList).cast(),
            size_of::<NativeList>() as u32,
            &mut written,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    parse_list(&native, written)
}
fn parse_list(native: &NativeList, written: u32) -> io::Result<Listed> {
    let offset = std::mem::offset_of!(NativeList, ids);
    let count = native.listed as usize;
    if offset != std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList)
        || native.assigned != native.listed
        || count > CAPACITY
        || written as usize > size_of::<NativeList>()
        || count
            .checked_mul(size_of::<usize>())
            .and_then(|n| offset.checked_add(n))
            .is_none_or(|needed| needed > written as usize)
    {
        return Err(io::Error::other("程序成员检查未完成"));
    }
    let mut result = Listed {
        len: count,
        ids: [0; CAPACITY],
    };
    for (index, &raw) in native.ids[..count].iter().enumerate() {
        let pid = u32::try_from(raw)
            .ok()
            .filter(|pid| *pid != 0)
            .ok_or_else(|| io::Error::other("程序成员标识无效"))?;
        if result.ids[..index].contains(&pid) {
            return Err(io::Error::other("程序成员标识重复"));
        }
        result.ids[index] = pid;
    }
    Ok(result)
}

#[cfg(test)]
#[path = "current_members_tests.rs"]
mod tests;
