//! Explicit, read-only recovery of one saved, unresolved tool change. Never
//! load the conversation, mutate Agent configuration, or infer an old success.
use super::{
    lifecycle::OpenReservation,
    manager::{AcpManager, ManagedConnection, ManagerCommand},
    model_guard::ConfigStore,
    session_tool_changes::inventory::Inventory,
};
use crate::meta_store::{
    MetaStore, SessionRow,
    mcp_pending::{Action, Pending},
};
use agent_client_protocol::{Agent, ConnectionTo};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use tokio::sync::{oneshot, watch};

mod review;
mod types;
pub use types::{Confirmation, Inspection, Resolution, Target};
const FAILED: &str = "SESSION_TOOL_RECOVERY_UNAVAILABLE";
const CHANGED: &str = "SESSION_TOOL_RECOVERY_REVIEW_CHANGED";
const STILL_PENDING: &str = "SESSION_TOOL_RECOVERY_PENDING";
const MAX_REVIEWS: usize = 4096;
const WAIT: Duration = Duration::from_secs(10);
const REVIEW_LIFETIME: Duration = Duration::from_secs(120);

pub(crate) async fn require_ready(store: &ConfigStore, native: &str) -> Result<(), String> {
    let id = super::session_index::session_row_id(&store.agent_id, &store.cwd, native);
    store
        .store
        .run(move |store| store.require_mcp_ready(&id))
        .await
}

struct Review {
    inspection: Inspection,
    row: SessionRow,
    pending: Pending,
    digest: String,
    connection: ManagedConnection,
    expires: tokio::time::Instant,
    clear_attempted: bool,
    _reservation: OpenReservation,
}
struct Job<T: Clone> {
    target: Target,
    result: watch::Sender<Option<Result<T, String>>>,
}
#[derive(Clone, PartialEq, Eq, Hash)]
struct ConfirmKey {
    target: Target,
    review_id: String,
    connection_id: String,
    resolution: Resolution,
}
#[derive(Default)]
pub(crate) struct Reviews {
    review: Mutex<HashMap<Target, Review>>,
    inspecting: Mutex<HashMap<Target, Arc<Job<Inspection>>>>,
    // One result per actual confirmation, retained for repeated delivery after
    // IPC loss. This in-memory map never replaces the durable pending guard.
    confirming: Mutex<HashMap<ConfirmKey, Arc<Job<Confirmation>>>>,
}

fn blank(target: Target, pending: Option<&Pending>, outcome: &'static str) -> Inspection {
    Inspection {
        target,
        pending: pending.is_some(),
        operation_id: pending.map(|p| p.operation_id.clone()),
        action: pending.map(|p| match p.action {
            Action::Add => "add",
            Action::Remove => "remove",
        }),
        outcome,
        can_confirm: false,
        review_id: None,
        connection_id: None,
        resolution: None,
        configuration: None,
    }
}
fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| FAILED)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
async fn await_job<T: Clone>(job: &Job<T>) -> Result<Option<T>, String> {
    let mut read = job.result.subscribe();
    let future = async {
        loop {
            if let Some(value) = read.borrow().clone() {
                return value;
            }
            read.changed().await.map_err(|_| FAILED.to_string())?;
        }
    };
    match tokio::time::timeout(WAIT, future).await {
        Ok(result) => result.map(Some),
        Err(_) => Ok(None),
    }
}

async fn saved(
    store: &MetaStore,
    target: &Target,
) -> Result<(SessionRow, Option<Pending>), String> {
    let target = target.clone();
    store
        .run(move |store| {
            let id = super::session_index::session_row_id(
                &target.agent_id,
                &target.cwd,
                &target.session_id,
            );
            let row = store
                .get_session(&id)?
                .filter(|row| {
                    row.agent_id == target.agent_id
                        && row.cwd == target.cwd
                        && row.native_session_id.as_deref() == Some(&target.session_id)
                })
                .ok_or(CHANGED)?;
            Ok((row, store.mcp_pending(&id)?))
        })
        .await
}

impl AcpManager {
    pub(crate) async fn inspect_tool_recovery(
        &self,
        store: &MetaStore,
        target: Target,
    ) -> Result<Inspection, String> {
        if self
            .tool_recovery
            .confirming
            .lock()
            .map_err(|_| FAILED)?
            .iter()
            .any(|(key, job)| key.target == target && job.result.borrow().is_none())
        {
            return Err(STILL_PENDING.into());
        }
        {
            let mut current = self.tool_recovery.review.lock().map_err(|_| FAILED)?;
            current.retain(|_, review| {
                review.clear_attempted || review.expires > tokio::time::Instant::now()
            });
            if let Some(review) = current.get(&target) {
                if review.clear_attempted {
                    return Err(STILL_PENDING.into());
                }
                return Ok(review.inspection.clone());
            }
        }
        let job = {
            let mut jobs = self.tool_recovery.inspecting.lock().map_err(|_| FAILED)?;
            if let Some(job) = jobs.get(&target).filter(|j| j.result.borrow().is_none()) {
                job.clone()
            } else {
                if !jobs.contains_key(&target) && jobs.len() >= MAX_REVIEWS {
                    return Err(FAILED.into());
                }
                let job = Arc::new(Job {
                    target: target.clone(),
                    result: watch::channel(None).0,
                });
                jobs.insert(target.clone(), job.clone());
                let manager = self.clone();
                let store = store.clone();
                let task = job.clone();
                super::manager::runtime().spawn(async move {
                    let value = manager
                        .inspect_tool_recovery_owned(&store, task.target.clone())
                        .await;
                    task.result.send_replace(Some(value));
                });
                job
            }
        };
        if let Some(value) = await_job(&job).await? {
            return Ok(value);
        }
        let (_, pending) = saved(store, &target).await?;
        Ok(blank(target, pending.as_ref(), "busy"))
    }

    async fn inspect_tool_recovery_owned(
        &self,
        store: &MetaStore,
        target: Target,
    ) -> Result<Inspection, String> {
        let (row, Some(pending)) = saved(store, &target).await? else {
            return Ok(blank(target, None, "none"));
        };
        // A matched failure may have changed the active configuration. End only
        // this exact idle process before reading persistence. Real unknown work
        // cannot pass release_for_configuration and is never force-stopped.
        if let Some(owner) =
            self.session_owner(&target.agent_id, Path::new(&target.cwd), &target.session_id)?
            && !owner.life.finished()
        {
            let mut status = blank(target.clone(), Some(&pending), "busy");
            status.connection_id = Some(owner.connection_id.clone());
            if owner
                .sessions
                .lock()
                .map_err(|_| FAILED)?
                .keys()
                .any(|id| id != &target.session_id)
            {
                return Ok(status);
            }
            if owner.life.release_for_configuration().is_err() {
                return Ok(status);
            }
            match tokio::time::timeout(WAIT, owner.life.closed()).await {
                Err(_) => {
                    status.outcome = "closing";
                    return Ok(status);
                }
                Ok(Err(_)) if !owner.life.finished() => return Ok(status),
                _ => {}
            }
        }
        let reservation = match self.opening_sessions.reserve(
            &target.agent_id,
            Path::new(&target.cwd),
            &target.session_id,
        ) {
            Ok(value) => value,
            Err(_) => return Ok(blank(target, Some(&pending), "busy")),
        };
        let current = saved(store, &target).await?;
        if current.0.created_at != row.created_at || current.1.as_ref() != Some(&pending) {
            return Err(CHANGED.into());
        }
        let agent = {
            let id = target.agent_id.clone();
            store
                .run(move |s| s.get_agent(&id)?.ok_or(CHANGED.into()))
                .await?
        };
        let recorded = super::service_connection::recorded_service(row.config_options.as_ref())?;
        let (selection, expected) =
            super::service_connection::selection_for_open(true, recorded.as_ref(), None)?;
        let (_, connection) = self
            .connect_selected_owned(
                &agent,
                Path::new(&target.cwd),
                store,
                selection,
                expected,
                true,
                None,
            )
            .await?;
        let inventory = self
            .read_recovery_inventory(&connection, &target.session_id)
            .await?;
        let digest = inventory.digest();
        let outcome = if digest == pending.before_digest {
            "unchanged"
        } else if inventory.matches_pending(&pending).map_err(|_| FAILED)? {
            "applied"
        } else {
            "changed"
        };
        let mut inspection = blank(target, Some(&pending), outcome);
        inspection.connection_id = Some(connection.connection_id.clone());
        let resolution = if outcome == "changed" {
            let Some(configuration) = review::configuration(&inventory) else {
                return Ok(inspection);
            };
            inspection.configuration = Some(configuration);
            Resolution::AcceptCurrent
        } else {
            Resolution::ConfirmResult
        };
        inspection.resolution = Some(resolution);
        let id = nonce()?;
        inspection.review_id = Some(id.clone());
        inspection.can_confirm = true;
        let review = Review {
            inspection: inspection.clone(),
            row,
            pending,
            digest,
            connection,
            expires: tokio::time::Instant::now() + REVIEW_LIFETIME,
            clear_attempted: false,
            _reservation: reservation,
        };
        self.tool_recovery
            .review
            .lock()
            .map_err(|_| FAILED)?
            .insert(inspection.target.clone(), review);
        let target = inspection.target.clone();
        let state = Arc::downgrade(&self.tool_recovery);
        super::manager::runtime().spawn(async move {
            tokio::time::sleep(REVIEW_LIFETIME).await;
            if let Some(state) = state.upgrade()
                && let Ok(mut current) = state.review.lock()
                && current.get(&target).is_some_and(|r| {
                    !r.clear_attempted && r.inspection.review_id.as_deref() == Some(&id)
                })
            {
                current.remove(&target);
            }
        });
        Ok(inspection)
    }

    async fn read_recovery_inventory(
        &self,
        connection: &ManagedConnection,
        native: &str,
    ) -> Result<Inventory, String> {
        if connection
            .session_tools
            .capability()
            .is_none_or(|c| c.configuration != Some(true))
        {
            return Err(FAILED.into());
        }
        let (result, receive) = oneshot::channel();
        connection.send(ManagerCommand::McpRecoveryRead {
            session_id: native.into(),
            availability: connection.session_tools.clone(),
            result,
        })?;
        // The owning job, not the IPC wait, holds this receiver through unknown
        // transport completion. A second click cannot resend it.
        receive.await.map_err(|_| FAILED.to_string())?
    }

    pub(crate) async fn confirm_tool_recovery(
        &self,
        store: &MetaStore,
        target: Target,
        review_id: String,
        connection_id: String,
        resolution: Resolution,
    ) -> Result<Confirmation, String> {
        let key = ConfirmKey {
            target: target.clone(),
            review_id: review_id.clone(),
            connection_id: connection_id.clone(),
            resolution,
        };
        let job = {
            let mut jobs = self.tool_recovery.confirming.lock().map_err(|_| FAILED)?;
            if jobs.get(&key).is_some_and(
                |job| matches!(&*job.result.borrow(),Some(Err(code)) if code == STILL_PENDING),
            ) {
                jobs.remove(&key);
            }
            if let Some(job) = jobs.get(&key) {
                job.clone()
            } else {
                if jobs.len() >= MAX_REVIEWS
                    || jobs
                        .iter()
                        .any(|(key, job)| key.target == target && job.result.borrow().is_none())
                {
                    return Err(STILL_PENDING.into());
                }
                let job = Arc::new(Job {
                    target: target.clone(),
                    result: watch::channel(None).0,
                });
                jobs.insert(key, job.clone());
                let manager = self.clone();
                let store = store.clone();
                let task = job.clone();
                super::manager::runtime().spawn(async move {
                    let value = manager
                        .confirm_tool_recovery_owned(
                            &store,
                            task.target.clone(),
                            review_id,
                            connection_id,
                            resolution,
                        )
                        .await;
                    task.result.send_replace(Some(value));
                });
                job
            }
        };
        await_job(&job).await?.ok_or_else(|| STILL_PENDING.into())
    }

    async fn confirm_tool_recovery_owned(
        &self,
        store: &MetaStore,
        target: Target,
        review_id: String,
        connection_id: String,
        resolution: Resolution,
    ) -> Result<Confirmation, String> {
        let mut review = {
            let mut current = self.tool_recovery.review.lock().map_err(|_| CHANGED)?;
            if current.get(&target).is_none_or(|r| {
                r.inspection.target != target
                    || r.inspection.review_id.as_deref() != Some(&review_id)
                    || r.connection.connection_id != connection_id
                    || r.inspection.resolution != Some(resolution)
                    || (!r.clear_attempted && r.expires <= tokio::time::Instant::now())
            }) {
                return Err(CHANGED.into());
            }
            current.remove(&target).ok_or(CHANGED)?
        };
        if !review.clear_attempted {
            if review.connection.life.finished()
                || self
                    .session_owner(&target.agent_id, Path::new(&target.cwd), &target.session_id)
                    .map_err(|_| CHANGED)?
                    .is_some()
            {
                return Err(CHANGED.into());
            }
            let current = saved(store, &target).await.map_err(|_| CHANGED)?;
            if current.0.created_at != review.row.created_at
                || current.0.config_options != review.row.config_options
                || current.1.as_ref() != Some(&review.pending)
            {
                return Err(CHANGED.into());
            }
            let inventory = self
                .read_recovery_inventory(&review.connection, &target.session_id)
                .await
                .map_err(|_| CHANGED)?;
            if inventory.digest() != review.digest {
                return Err(CHANGED.into());
            }
            review.clear_attempted = true;
            let row = review.row.clone();
            let pending = review.pending.clone();
            if store
                .run(move |s| s.clear_mcp_pending(&row, &pending))
                .await
                .is_err()
            {
                return self
                    .finish_uncertain_clear(store, review, review_id, connection_id)
                    .await;
            }
        } else {
            // The protocol verification already finished. Retry only the local
            // commit observation; never dispatch that official query again.
            return self
                .finish_uncertain_clear(store, review, review_id, connection_id)
                .await;
        }
        let reply = Confirmation {
            target,
            resolved: true,
            operation_id: review.pending.operation_id.clone(),
            review_id,
            connection_id,
            requires_reopen: true,
            resolution,
        };
        Ok(reply)
    }
    async fn finish_uncertain_clear(
        &self,
        store: &MetaStore,
        review: Review,
        review_id: String,
        connection_id: String,
    ) -> Result<Confirmation, String> {
        let target = review.inspection.target.clone();
        match saved(store, &target).await {
            Ok((row, None)) if row.created_at == review.row.created_at => Ok(Confirmation {
                target,
                resolved: true,
                operation_id: review.pending.operation_id,
                review_id,
                connection_id,
                requires_reopen: true,
                resolution: review.inspection.resolution.ok_or(CHANGED)?,
            }),
            Ok((row, Some(pending)))
                if row.created_at == review.row.created_at && pending == review.pending =>
            {
                Err(CHANGED.into())
            }
            _ => {
                self.tool_recovery
                    .review
                    .lock()
                    .map_err(|_| STILL_PENDING)?
                    .insert(target, review);
                Err(STILL_PENDING.into())
            }
        }
    }
}

pub(crate) async fn read_on_connection(
    cx: &ConnectionTo<Agent>,
    life: &Arc<super::lifecycle::ConnectionLife>,
    availability: &Arc<super::session_tools::Availability>,
    native: &str,
) -> Result<Inventory, String> {
    let (future, witness) = availability
        .send_raw(
            cx,
            super::session_tool_changes::LIST,
            serde_json::json!({"sessionId":native}),
        )
        .map_err(|_| FAILED)?;
    let response = super::operations::until_owner_ended(life, future).await;
    if !witness.load(Ordering::Acquire) && !life.finished() {
        life.terminated().await;
    }
    let matched = witness.load(Ordering::Acquire);
    availability.clear(&witness);
    match response {
        Some(Ok(value)) if matched => Inventory::parse(value).map_err(|_| FAILED.into()),
        _ => Err(FAILED.into()),
    }
}

async fn validate_target(target: Target) -> Result<Target, String> {
    if target.agent_id.is_empty()
        || target.agent_id.len() > 4096
        || target.session_id.is_empty()
        || target.session_id.len() > 4096
        || target.session_id.chars().any(char::is_control)
    {
        return Err(CHANGED.into());
    }
    let cwd = super::manager::validate_cwd_async(&target.cwd).await?;
    if cwd.to_string_lossy() != target.cwd {
        return Err(CHANGED.into());
    }
    Ok(target)
}
#[tauri::command]
pub async fn session_tool_recovery_inspect(
    app: tauri::AppHandle,
    target: Target,
) -> Result<Inspection, String> {
    use tauri::Manager;
    app.state::<AcpManager>()
        .inspect_tool_recovery(&app.state::<MetaStore>(), validate_target(target).await?)
        .await
}
#[tauri::command]
pub async fn session_tool_recovery_confirm(
    app: tauri::AppHandle,
    target: Target,
    review_id: String,
    connection_id: String,
    resolution: Option<Resolution>,
) -> Result<Confirmation, String> {
    use tauri::Manager;
    app.state::<AcpManager>()
        .confirm_tool_recovery(
            &app.state::<MetaStore>(),
            validate_target(target).await?,
            review_id,
            connection_id,
            resolution.unwrap_or_default(),
        )
        .await
}

#[cfg(test)]
mod tests;
