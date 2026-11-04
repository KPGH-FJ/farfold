//! A finite complete set of exact process objects for one fixed Git command.
//! This read-only proof never changes general Agent/terminal retirement state.
use super::*;
use std::os::windows::io::{AsRawHandle, BorrowedHandle};
use windows_sys::Win32::{
    Foundation::{CompareObjectHandles, WAIT_FAILED},
    System::JobObjects::IsProcessInJob,
    System::Threading::GetProcessId,
};

pub(crate) const DEBUG_MEMBER_LIMIT: usize = 256;

impl OwnedGroup {
    pub(crate) fn debugged_members_inactive<'a>(
        &self,
        child: BorrowedHandle<'_>,
        members: impl Iterator<Item = BorrowedHandle<'a>> + Clone,
    ) -> io::Result<bool> {
        let count = members.clone().count();
        if count == 0 || count > DEBUG_MEMBER_LIMIT {
            return Ok(false);
        }
        let original = child.as_raw_handle();
        if unsafe { GetProcessId(original) } != self.pid
            || self.job.leader.get().is_some_and(|leader| unsafe {
                CompareObjectHandles(original, leader.handle.0) == 0
            })
        {
            return Err(io::Error::other("程序进程身份发生变化"));
        }
        // Fixed Git retains its actual Child even if secondary registration
        // failed. A direct owner of that SAME Job can then finish cleanup.
        if !signaled(original)? {
            return Ok(false);
        }
        let before = self.job.activity_query();
        if before.ok == 0 {
            return Err(io::Error::last_os_error());
        }
        if before.info.ActiveProcesses != 0 {
            return Ok(false);
        }
        let mut original_members = 0;
        let mut found_leader = false;
        for (index, member) in members.clone().enumerate() {
            let raw = member.as_raw_handle();
            if members
                .clone()
                .take(index)
                .any(|earlier| unsafe { CompareObjectHandles(raw, earlier.as_raw_handle()) != 0 })
            {
                return Err(io::Error::other("程序进程对象重复"));
            }
            if !signaled(raw)? {
                return Ok(false);
            }
            let is_leader = unsafe { CompareObjectHandles(raw, original) } != 0;
            found_leader |= is_leader;
            let mut belongs = 0;
            if unsafe { IsProcessInJob(raw, self.job.handle.0, &mut belongs) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if belongs != 0 {
                original_members += 1;
            } else if !is_leader {
                return Err(io::Error::other("程序进程不属于原操作"));
            }
        }
        if !found_leader || before.info.TotalProcesses != original_members {
            return Ok(false);
        }
        // The original helper may have been cancelled before Job entry. It
        // must still be in the exact signaled object set, but is not charged as
        // an association. Every other object must belong to this same Job.
        let after = self.job.activity_query();
        if after.ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(after.info.ActiveProcesses == 0 && after.info.TotalProcesses == original_members)
    }
}

fn signaled(process: HANDLE) -> io::Result<bool> {
    match unsafe { WaitForSingleObject(process, 0) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_FAILED => Err(io::Error::last_os_error()),
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::windows::io::AsHandle,
        process::{Child, Stdio},
        time::{Duration, Instant},
    };
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

    struct Children(Vec<Child>);
    impl Drop for Children {
        fn drop(&mut self) {
            for child in &mut self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    fn launch() -> Child {
        Command::new(super::super::behavior_tests::fixture())
            .arg("argv")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
    fn until(mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready() {
            assert!(
                Instant::now() < deadline,
                "certificate fixture did not settle"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn certificate_requires_every_distinct_original_object_signal() {
        let pending = pending().unwrap();
        let mut children = Children(vec![launch(), launch(), launch()]);
        for child in &children.0[..2] {
            assert_ne!(
                unsafe { AssignProcessToJobObject(pending.0.handle.0, child.as_raw_handle()) },
                0
            );
        }
        let group = pending.attach(children.0[0].id()).unwrap();
        let handles = [children.0[0].as_handle(), children.0[1].as_handle()];
        assert!(
            !group
                .debugged_members_inactive(handles[0], handles.into_iter())
                .unwrap()
        );
        drop(children.0[0].stdin.take());
        until(|| children.0[0].try_wait().unwrap().is_some());
        let handles = [children.0[0].as_handle(), children.0[1].as_handle()];
        assert!(
            !group
                .debugged_members_inactive(handles[0], handles.into_iter())
                .unwrap()
        );
        drop(children.0[1].stdin.take());
        drop(children.0[2].stdin.take());
        until(|| {
            children
                .0
                .iter_mut()
                .all(|child| child.try_wait().unwrap().is_some())
        });
        until(|| !group.job.activity_query().not_confirmed_inactive());
        let root = children.0[0].as_handle();
        let second = children.0[1].as_handle();
        let foreign = children.0[2].as_handle();
        assert!(
            !group
                .debugged_members_inactive(root, [root].into_iter())
                .unwrap()
        );
        assert!(
            group
                .debugged_members_inactive(root, [root, root].into_iter())
                .is_err()
        );
        assert!(
            group
                .debugged_members_inactive(root, [root, foreign].into_iter())
                .is_err()
        );
        assert!(
            group
                .debugged_members_inactive(foreign, [root, second].into_iter())
                .is_err()
        );
        {
            let mut current = group.job.current.lock().unwrap();
            // Invalid handle injects a failed historical list without reading
            // a caller/foreign Job. All actual processes above remain ours.
            assert!(current.observe(
                windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE,
                Some(children.0[0].id()),
                Some(1)
            ));
            assert!(current.unknown());
        }
        assert!(group.active());
        assert!(
            group
                .debugged_members_inactive(root, [root, second].into_iter())
                .unwrap()
        );
        assert!(group.active(), "the general retirement policy is unchanged");
    }
}
