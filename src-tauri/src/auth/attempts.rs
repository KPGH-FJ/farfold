//! Only in-memory account-operation ownership. No credentials or terminal text.
use crate::acp_client::manager::AuthenticationOperation;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

type Entries = HashMap<String, (String, AuthenticationOperation, Option<PathBuf>)>;
fn entries() -> &'static Mutex<Entries> {
    static ENTRIES: OnceLock<Mutex<Entries>> = OnceLock::new();
    ENTRIES.get_or_init(Default::default)
}
fn cancellations() -> &'static Mutex<VecDeque<(String, String)>> {
    static CANCELLED: OnceLock<Mutex<VecDeque<(String, String)>>> = OnceLock::new();
    CANCELLED.get_or_init(Default::default)
}
pub(crate) struct Attempt {
    agent: String,
    id: String,
    operation: AuthenticationOperation,
    _admission: crate::managed_update::ActivityPermit,
}
impl Attempt {
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.operation.interested() {
            Ok(())
        } else {
            Err("AUTH_CANCELLED".into())
        }
    }
    /// Only local setup waits use this. A sent authentication request keeps
    /// its existing owner until its actual terminal result.
    pub(crate) async fn setup<T>(
        &self,
        future: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        self.check()?;
        tokio::select! {
            biased;
            _ = self.operation.cancelled() => Err("AUTH_CANCELLED".into()),
            result = future => { self.check()?; result },
        }
    }
    pub(crate) async fn configuration_guard(
        &self,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        self.setup(async { Ok(crate::install_job::configuration_guard(&self.agent).await) })
            .await
    }
    pub(crate) fn operation(&self) -> AuthenticationOperation {
        self.operation.clone()
    }
    pub(crate) fn protocol_directory(&self, cwd: &Path) -> Result<(), String> {
        self.check()?;
        let mut entries = entries().lock().map_err(|_| "无法读取账号操作状态")?;
        let entry = entries
            .get_mut(&self.agent)
            .filter(|(id, _, _)| id == &self.id)
            .ok_or("这次账号操作已结束，请重新查看")?;
        entry.2 = Some(cwd.into());
        Ok(())
    }
}
impl Drop for Attempt {
    fn drop(&mut self) {
        if let Ok(mut entries) = entries().lock()
            && entries
                .get(&self.agent)
                .is_some_and(|(id, _, _)| id == &self.id)
        {
            entries.remove(&self.agent);
        }
    }
}
pub(crate) fn reserve(agent: &str, id: &str) -> Result<Attempt, String> {
    let admission = crate::managed_update::activity()?;
    if id.is_empty() || id.len() > 128 {
        return Err("无法确认这次账号操作，请重试".into());
    }
    let mut entries = entries().lock().map_err(|_| "无法读取账号操作状态")?;
    if entries.contains_key(agent) {
        return Err("此 Agent 的账号操作尚未结束，请返回查看".into());
    }
    let operation = AuthenticationOperation::new();
    let mut cancelled = cancellations().lock().map_err(|_| "无法读取账号取消状态")?;
    if let Some(index) = cancelled
        .iter()
        .position(|(owner, attempt)| owner == agent && attempt == id)
    {
        cancelled.remove(index);
        operation.abandon();
    }
    entries.insert(agent.into(), (id.into(), operation.clone(), None));
    Ok(Attempt {
        agent: agent.into(),
        id: id.into(),
        operation,
        _admission: admission,
    })
}
pub(crate) fn require_existing_source(source: Option<&str>) -> Result<(), String> {
    if source.is_some_and(|value| !value.is_empty()) {
        Err("当前使用 API 配置，请返回 API 设置检查此服务".into())
    } else {
        Ok(())
    }
}
pub(crate) fn auth_cancel(agent_id: String, attempt_id: String) -> Result<(), String> {
    let entries = entries().lock().map_err(|_| "无法读取账号操作状态")?;
    if let Some((id, operation, _)) = entries.get(&agent_id) {
        if id != &attempt_id {
            return Err("这次账号操作已变化，请返回查看".into());
        }
        operation.abandon();
    } else {
        // IPC cancellation can overtake startup before its first async poll.
        // Keep only bounded, non-secret correlation receipts for that race.
        let mut cancelled = cancellations().lock().map_err(|_| "无法读取账号取消状态")?;
        if cancelled.len() >= 128 {
            cancelled.pop_front();
        }
        cancelled.push_back((agent_id, attempt_id));
    }
    // Requesting cancellation is not evidence that the Agent has ended it.
    Ok(())
}
pub(crate) fn end_connection<T>(
    agent: &str,
    attempt: &str,
    close: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let entries = entries().lock().map_err(|_| "无法读取账号操作状态")?;
    let cwd = entries
        .get(agent)
        .filter(|(id, _, _)| id == attempt)
        .and_then(|(_, _, cwd)| cwd.as_deref())
        .ok_or("这次登录连接已变化，请重新查看")?;
    close(cwd)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_and_stale_cancellation_cannot_affect_another_attempt() {
        let first = reserve("attempt-test", "first").unwrap();
        assert!(reserve("attempt-test", "second").is_err());
        assert!(auth_cancel("attempt-test".into(), "stale".into()).is_err());
        assert!(first.operation.interested());
        auth_cancel("attempt-test".into(), "first".into()).unwrap();
        assert!(!first.operation.interested());
        drop(first);
        let second = reserve("attempt-test", "second").unwrap();
        assert!(auth_cancel("attempt-test".into(), "first".into()).is_err());
        assert!(second.operation.interested());
    }
    #[test]
    fn selected_api_never_dispatches_shared_account_authentication() {
        assert!(require_existing_source(Some("service-revision")).is_err());
        assert!(require_existing_source(None).is_ok());
    }
    #[test]
    fn cancellation_before_startup_is_not_lost() {
        auth_cancel("early-cancel-test".into(), "first".into()).unwrap();
        let attempt = reserve("early-cancel-test", "first").unwrap();
        assert!(!attempt.operation.interested());
    }
    #[test]
    fn ending_login_uses_original_directory_and_rejects_old_attempts() {
        let attempt = reserve("ending-test", "first").unwrap();
        assert!(end_connection("ending-test", "first", |_| Ok(())).is_err());
        attempt.protocol_directory(Path::new("/original")).unwrap();
        let cwd = end_connection("ending-test", "first", |cwd| Ok(cwd.to_path_buf())).unwrap();
        assert_eq!(cwd, Path::new("/original"));
        assert!(end_connection("ending-test", "later", |_| Ok(())).is_err());
    }
}
