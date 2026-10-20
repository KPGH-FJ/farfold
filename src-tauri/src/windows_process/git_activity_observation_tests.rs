//! One decisive Git Job query observation, not a new query/reaper or owner.
//! Records are emitted only after the original unknown branch terminates its Job.
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
}
impl OwnedGroup {
    pub(crate) fn active_with_observation(&self) -> (bool, Observation) {
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
        };
        (active, observation)
    }
}
impl Observation {
    pub(crate) fn emit(&self, original_child_pid: u32, exit_code: Option<i32>) {
        let event = serde_json::json!({
            "phase": "decisiveGroupQueryAfterOriginalChild",
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
            "scope": "same retained Job, original query before termination, emitted after original termination call",
        });
        // At most one record for this completed command's decisive branch.
        // No cleanup-loop observation, argv/env/path/data, retry or new wait.
        let _ = writeln!(
            std::io::stderr().lock(),
            "FARFOLD_WINDOWS_GIT_DECISIVE_JOB_QUERY {event}"
        );
    }
}
