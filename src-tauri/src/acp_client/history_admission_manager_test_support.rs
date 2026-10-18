use super::AcpManager;

// A synchronous wake must observe this lock, never wait on the lock it tests.
impl AcpManager {
    pub(in crate::acp_client) fn history_connections_unlocked(&self) -> bool {
        self.connections.try_lock().is_ok()
    }
}
