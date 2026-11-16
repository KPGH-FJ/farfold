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
    counted_live: bool,
}
pub(super) struct Current {
    held: Vec<Member>,
    pending: Vec<u32>,
    coverage_gap: bool,
    observation_unknown: bool,
    complete_empty: bool,
    counted_leader: Option<u32>,
    observed_live: u32,
    retired_live: u32,
    count_invalid: bool,
    #[cfg(test)]
    first_incomplete: Option<(&'static str, Option<u32>)>,
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
    observed_live: u32,
    retired_live: u32,
    count_invalid: bool,
    complete_empty: bool,
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
            observed_live: self.observed_live,
            retired_live: self.retired_live,
            count_invalid: self.count_invalid,
            complete_empty: self.complete_empty,
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
            complete_empty: false,
            counted_leader: None,
            observed_live: 0,
            retired_live: 0,
            count_invalid: false,
            #[cfg(test)]
            first_incomplete: None,
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
        #[cfg(not(test))]
        {
            self.observe_using(job, leader, associated, || list(job), native_lookup)
        }
        #[cfg(test)]
        {
            let mut native_list = None;
            let active = self.observe_using(
                job,
                leader,
                associated,
                || list(job, &mut native_list),
                native_lookup,
            );
            if let Some((reason, associated)) = self.first_incomplete.take() {
                tests::emit_incomplete(
                    reason,
                    leader,
                    associated,
                    &self.observation(),
                    native_list,
                );
            }
            active
        }
    }
    pub(super) fn unknown(&self) -> bool {
        self.coverage_gap || self.observation_unknown
    }
    pub(super) fn query_unknown(&mut self) {
        self.observation_unknown = true;
    }
    /// A scalar count of distinct original objects, not PID history. An object
    /// can first become counted only while its exact handle is NOT signaled.
    /// Once retired on its exact signal, reopening that same old object can
    /// never make it count again. Genuine PID reuse has a different live object.
    pub(super) fn completely_retired_live(&self, leader: u32) -> Option<u32> {
        (self.coverage_gap
            && self.counted_leader == Some(leader)
            && !self.count_invalid
            && !self.observation_unknown
            && self.complete_empty
            && self.held.is_empty()
            && self.pending.is_empty()
            && self.observed_live == self.retired_live)
            .then_some(self.observed_live)
    }
    fn incomplete(&mut self, associated: Option<u32>, _reason: &'static str) -> bool {
        #[cfg(test)]
        // The first transition into the existing sticky gap is the relevant
        // failure. Earlier incomplete observations with accounting zero must
        // not consume this diagnostic or hide a later actual coverage gap.
        if !self.coverage_gap && associated != Some(0) {
            self.first_incomplete = Some((_reason, associated));
        }
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
        self.complete_empty = false;
        match (self.counted_leader, leader) {
            (None, Some(pid)) => self.counted_leader = Some(pid),
            (Some(fixed), Some(pid)) if fixed == pid => {}
            // Missing/changing leader context cannot provide lifetime coverage.
            // This does not change ordinary no-gap completion or clear a gap.
            _ => self.count_invalid = true,
        }
        self.observation_unknown = associated.is_none();
        if self.poll_held(job).is_err() {
            return self.incomplete(associated, "held-before-resolution");
        }
        self.resolve_pending(&mut lookup);
        let held_failed = self.poll_held(job).is_err();
        if held_failed || !self.pending.is_empty() {
            return self.incomplete(
                associated,
                if held_failed {
                    "held-after-resolution"
                } else {
                    "pending-before-snapshot"
                },
            );
        }
        let listed = match snapshot() {
            Ok(value) => value,
            Err(_) => return self.incomplete(associated, "snapshot"),
        };
        let complete_empty = listed.ids().is_empty();
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
        self.complete_empty = complete_empty;
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
                        counted_live: false,
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
                    if member.counted_live {
                        match self.retired_live.checked_add(1) {
                            Some(count) if count <= self.observed_live => self.retired_live = count,
                            _ => self.count_invalid = true,
                        }
                    }
                    self.held.swap_remove(index);
                }
                WAIT_TIMEOUT => {
                    if !member.counted_live
                        && !self.count_invalid
                        && self
                            .counted_leader
                            .is_some_and(|leader| member.pid != leader)
                    {
                        if let Some(count) = self.observed_live.checked_add(1) {
                            self.observed_live = count;
                            member.counted_live = true;
                        } else {
                            self.count_invalid = true;
                        }
                    }
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
fn list(
    job: HANDLE,
    #[cfg(test)] observation: &mut Option<tests::NativeListObservation>,
) -> io::Result<Listed> {
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
    // Preserve the original error before any test-only metadata work.
    let result = if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        parse_list(&native, written)
    };
    #[cfg(test)]
    if let Err(error) = &result {
        *observation = Some(tests::NativeListObservation::capture(
            &native,
            written,
            ok,
            error.raw_os_error(),
        ));
    }
    result
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
