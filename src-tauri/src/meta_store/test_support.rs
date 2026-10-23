//! Real in-memory SQLite fixtures; never pass the SQLite sentinel to filesystem APIs.
use super::*;
impl MetaStore {
    pub(crate) fn test_memory() -> Self {
        let connection = Connection::open_in_memory().expect("owned memory database");
        connection
            .execute_batch(schema::SCHEMA)
            .expect("real schema");
        Self {
            connection: Arc::new(Mutex::new(connection)),
            maintenance: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }
}
