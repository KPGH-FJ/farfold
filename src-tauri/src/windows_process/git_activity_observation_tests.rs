//! First active Git Job query plus one bounded test-only association sample.
//! No new process owner, reaper, PID reopen, retry, or blocking wait.
//! Emitted only after the original Child and retained Job actually settle.
use super::*;
use std::io::Write;

pub(crate) struct Observation {
    owner_pid: u32,
    query_return: i32,
    native_error: Option<u32>,
    active_processes: Option<u32>,
    total_processes: Option<u32>,
    total_terminated_processes: Option<u32>,
    conservative_active: bool,
    association: Option<AssociationObservation>,
}
impl OwnedGroup {
    pub(crate) fn active_with_observation(
        &self,
        original_child: &std::process::Child,
    ) -> (bool, Observation) {
        // Same Arc<Job> and SAME single query as active(), with the same bool.
        // This does not clone a Job/leader handle or consult the PID registry.
        let query = self.job.activity_query();
        let active = query.not_confirmed_inactive();
        let succeeded = query.ok != 0;
        let observation = Observation {
            owner_pid: self.pid,
            query_return: query.ok,
            native_error: query.native_error,
            active_processes: succeeded.then_some(query.info.ActiveProcesses),
            total_processes: succeeded.then_some(query.info.TotalProcesses),
            total_terminated_processes: succeeded.then_some(query.info.TotalTerminatedProcesses),
            conservative_active: active,
            // At most the first active observation needs this bounded sample.
            association: active.then(|| self.observe_association(original_child)),
        };
        (active, observation)
    }
}
impl Observation {
    pub(crate) fn emit(
        &self,
        original_child_pid: u32,
        exit_code: Option<i32>,
        stopped: Option<&str>,
    ) {
        let event = serde_json::json!({
            "phase": "firstActiveGroupQueryAfterOriginalChild",
            "originalChildPid": original_child_pid,
            "retainedGroupHelperPid": self.owner_pid,
            "sameOriginalChildPid": original_child_pid == self.owner_pid,
            "originalChildExitCode": exit_code,
            "queryClass": "JobObjectBasicAccountingInformation",
            "queryReturn": self.query_return,
            "querySucceeded": self.query_return != 0,
            "nativeError": self.native_error,
            // Failed query leaves ALL counts unknown, not zero/ended.
            "activeProcesses": self.active_processes,
            "totalProcesses": self.total_processes,
            "totalTerminatedProcesses": self.total_terminated_processes,
            "conservativeActive": self.conservative_active,
            "stoppedReason": stopped,
            "settledNaturally": stopped.is_none(),
            "scope": "same retained Job, first active query, emitted only after confirmed inactivity",
        });
        // At most one record for this completed command's settling interval.
        // No cleanup-loop output, argv/env/path/data, retry or blocking wait.
        // The separate record below reports one borrowed-handle zero-wait and
        // one bounded process-list query; it does not change the original bool.
        let _ = writeln!(
            std::io::stderr().lock(),
            "FARFOLD_WINDOWS_GIT_DECISIVE_JOB_QUERY {event}"
        );
        if let Some(association) = &self.association {
            let event = serde_json::json!({
                "phase": "sameJobAssociatedListAfterOriginalChild",
                "originalChildPid": original_child_pid,
                "retainedGroupHelperPid": self.owner_pid,
                "originalChildExitCode": exit_code,
                "association": association,
                "scope": "after first active accounting query; non-atomic observations, no PID reopen",
            });
            let _ = writeln!(
                std::io::stderr().lock(),
                "FARFOLD_WINDOWS_GIT_ASSOCIATED_PROCESS_LIST {event}"
            );
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AssociationObservation {
    original_child_id_matches: bool,
    original_child_wait_return: u32,
    original_child_wait_error: Option<u32>,
    capacity: u32,
    layout_matches: bool,
    list_query_return: Option<i32>,
    list_query_error: Option<u32>,
    returned_bytes: u32,
    layout_complete: bool,
    assigned_processes: Option<u32>,
    listed_processes: Option<u32>,
    original_helper_listed: Option<bool>,
    ids: Option<Vec<usize>>,
}
impl OwnedGroup {
    fn observe_association(&self, child: &std::process::Child) -> AssociationObservation {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::WAIT_FAILED,
            System::{
                JobObjects::{JOBOBJECT_BASIC_PROCESS_ID_LIST, JobObjectBasicProcessIdList},
                Threading::WaitForSingleObject,
            },
        };
        const CAPACITY: usize = 32;
        #[repr(C)]
        struct Storage {
            assigned: u32,
            listed: u32,
            ids: [usize; CAPACITY],
        }
        // Borrow the ORIGINAL Child handle; no OpenProcess or new handle owner.
        let wait = unsafe { WaitForSingleObject(child.as_raw_handle(), 0) };
        let wait_error = (wait == WAIT_FAILED).then(|| unsafe { GetLastError() });
        let mut result = AssociationObservation {
            original_child_id_matches: child.id() == self.pid,
            original_child_wait_return: wait,
            original_child_wait_error: wait_error,
            capacity: CAPACITY as u32,
            layout_matches: std::mem::offset_of!(Storage, ids)
                == std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList),
            list_query_return: None,
            list_query_error: None,
            returned_bytes: 0,
            layout_complete: false,
            assigned_processes: None,
            listed_processes: None,
            original_helper_listed: None,
            ids: None,
        };
        if !result.layout_matches {
            return result;
        }
        let mut storage = Storage {
            assigned: 0,
            listed: 0,
            ids: [0; CAPACITY],
        };
        let ok = unsafe {
            QueryInformationJobObject(
                self.job.handle.0,
                JobObjectBasicProcessIdList,
                (&mut storage as *mut Storage).cast(),
                std::mem::size_of::<Storage>() as u32,
                &mut result.returned_bytes,
            )
        };
        result.list_query_error = (ok == 0).then(|| unsafe { GetLastError() });
        result.list_query_return = Some(ok);
        result.assigned_processes = (ok != 0).then_some(storage.assigned);
        result.listed_processes = (ok != 0).then_some(storage.listed);
        let counted_bytes = (storage.listed as usize)
            .checked_mul(std::mem::size_of::<usize>())
            .and_then(|n| n.checked_add(std::mem::offset_of!(Storage, ids)));
        result.layout_complete = ok != 0
            && storage.listed as usize <= CAPACITY
            && storage.assigned == storage.listed
            && counted_bytes.is_some_and(|n| n <= result.returned_bytes as usize)
            && result.returned_bytes as usize <= std::mem::size_of::<Storage>();
        if result.layout_complete {
            let ids = storage.ids[..storage.listed as usize].to_vec();
            result.original_helper_listed = Some(ids.contains(&(self.pid as usize)));
            result.ids = Some(ids);
        }
        // Unknown/truncation has no retry and no parsed partial IDs. No listed
        // PID authorizes reopening, signaling, or treating an object as live.
        result
    }
}
