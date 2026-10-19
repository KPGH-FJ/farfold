use super::*;

// Diagnostic-only reference to the EXISTING Job captured before cancellation.
// No new Job/handle/registry/controller and no terminate method. Its Arc extends
// this same Job/leader handle lifetime until the final observation is dropped.
#[cfg(test)]
pub(crate) struct ReadOnlyJobWitness(Arc<Job>);
#[cfg(test)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobWitnessObservation {
    member: Option<bool>,
    membership_error: Option<u32>,
    active_processes: Option<u32>,
    accounting_error: Option<u32>,
    // Additional observations only; original complete()/verdict are unchanged.
    basic_accounting: Option<BasicAccountingObservation>,
    process_list: ProcessListObservation,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BasicAccountingObservation {
    total_user_time: i64,
    total_kernel_time: i64,
    this_period_total_user_time: i64,
    this_period_total_kernel_time: i64,
    total_page_fault_count: u32,
    total_processes: u32,
    active_processes: u32,
    total_terminated_processes: u32,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessListObservation {
    capacity: u32,
    returned_bytes: u32,
    native_error: Option<u32>,
    layout_complete: bool,
    assigned_processes: Option<u32>,
    listed_processes: Option<u32>,
    ids: Option<Vec<usize>>,
}
impl ReadOnlyJobWitness {
    fn process_list(&self) -> ProcessListObservation {
        use windows_sys::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_PROCESS_ID_LIST, JobObjectBasicProcessIdList,
        };
        const CAPACITY: usize = 32;
        #[repr(C)]
        struct Storage {
            assigned: u32,
            listed: u32,
            ids: [usize; CAPACITY],
        }
        // An aligned stack object with the locked SDK's counted-tail layout.
        // No allocation from an untrusted count and no ERROR_MORE_DATA retry.
        let mut storage = Storage {
            assigned: 0,
            listed: 0,
            ids: [0; CAPACITY],
        };
        let mut returned = 0u32;
        let layout_matches = std::mem::offset_of!(Storage, ids)
            == std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
        if !layout_matches {
            return ProcessListObservation {
                capacity: CAPACITY as u32,
                returned_bytes: 0,
                native_error: None,
                layout_complete: false,
                assigned_processes: None,
                listed_processes: None,
                ids: None,
            };
        }
        let ok = unsafe {
            QueryInformationJobObject(
                self.0.handle.0,
                JobObjectBasicProcessIdList,
                (&mut storage as *mut Storage).cast(),
                std::mem::size_of::<Storage>() as u32,
                &mut returned,
            )
        };
        let native_error = (ok == 0).then(|| unsafe { GetLastError() });
        let counted_bytes = (storage.listed as usize)
            .checked_mul(std::mem::size_of::<usize>())
            .and_then(|n| n.checked_add(std::mem::offset_of!(Storage, ids)));
        let layout_complete = ok != 0
            && storage.listed as usize <= CAPACITY
            && storage.assigned == storage.listed
            && counted_bytes.is_some_and(|n| n <= returned as usize)
            && returned as usize <= std::mem::size_of::<Storage>();
        ProcessListObservation {
            capacity: CAPACITY as u32,
            returned_bytes: returned,
            native_error,
            layout_complete,
            assigned_processes: (ok != 0).then_some(storage.assigned),
            listed_processes: (ok != 0).then_some(storage.listed),
            ids: layout_complete.then(|| storage.ids[..storage.listed as usize].to_vec()),
        }
    }
}
#[cfg(test)]
impl JobWitnessObservation {
    pub(crate) fn complete(&self) -> bool {
        self.member.is_some()
            && self.membership_error.is_none()
            && self.active_processes.is_some()
            && self.accounting_error.is_none()
    }
}
#[cfg(test)]
impl ReadOnlyJobWitness {
    pub(crate) fn observe(&self, target: std::os::windows::io::RawHandle) -> JobWitnessObservation {
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        let mut member = 0;
        let ok = unsafe { IsProcessInJob(target, self.0.handle.0, &mut member) };
        let membership_error = (ok == 0).then(|| unsafe { GetLastError() });
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let accounting_ok = unsafe {
            QueryInformationJobObject(
                self.0.handle.0,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        };
        let accounting_error = (accounting_ok == 0).then(|| unsafe { GetLastError() });
        JobWitnessObservation {
            member: (ok != 0).then_some(member != 0),
            membership_error,
            active_processes: (accounting_ok != 0).then_some(info.ActiveProcesses),
            accounting_error,
            basic_accounting: (accounting_ok != 0).then_some(BasicAccountingObservation {
                total_user_time: info.TotalUserTime,
                total_kernel_time: info.TotalKernelTime,
                this_period_total_user_time: info.ThisPeriodTotalUserTime,
                this_period_total_kernel_time: info.ThisPeriodTotalKernelTime,
                total_page_fault_count: info.TotalPageFaultCount,
                total_processes: info.TotalProcesses,
                active_processes: info.ActiveProcesses,
                total_terminated_processes: info.TotalTerminatedProcesses,
            }),
            process_list: self.process_list(),
        }
    }
}
#[cfg(test)]
pub(crate) fn read_only_job_witness_for_test(pid: u32) -> io::Result<ReadOnlyJobWitness> {
    // Caller takes this BEFORE cancellation, using the current session's PID
    // captured from its retained original Child, never a saved/reopened PID.
    let job = groups()
        .lock()
        .map_err(|_| io::Error::other("test Job registry poisoned"))?
        .get(&pid)
        .and_then(Weak::upgrade)
        .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
    Ok(ReadOnlyJobWitness(job))
}
