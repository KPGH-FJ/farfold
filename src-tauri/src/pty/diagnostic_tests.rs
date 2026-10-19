impl super::PtyManager {
    // Read only the PID captured from this registered session's original Child.
    // This does not open, terminate, create or replace any process owner.
    #[cfg(all(windows, test))]
    pub(crate) fn retained_child_pid_for_test(&self, id: &str) -> Result<u32, String> {
        self.lock()?
            .get(id)
            .and_then(|session| session.pid)
            .ok_or_else(|| "test session has no retained Child PID".to_string())
    }
}
