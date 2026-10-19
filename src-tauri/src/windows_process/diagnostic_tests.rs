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
