//! Admission and delivery on the exact live conversation actor.
use super::*;
use crate::acp_client::{
    lifecycle::OperationLease,
    model_guard::{ConfigStore, ModelGuard},
    original_config::{Request, Review},
    permission_guard::PermissionGuard,
    service_connection::ServiceRecord,
    session_config::SessionConfig,
};

const CHANGED: &str = "对话或设置已变化，请重新打开后核对原设置";

pub(super) enum Outcome {
    Reviewed(Value),
    Saved(OperationLease),
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    request: Request,
    review: &mut Option<Review>,
    store: &mut ConfigStore,
    guard: &mut ModelGuard,
    options: Option<&Value>,
    ctx: &DispatchContext<'_>,
    busy: bool,
    deadline: tokio::time::Instant,
    result: &oneshot::Sender<Result<Value, String>>,
) -> Result<Outcome, String> {
    if busy
        || store.service_record.is_some()
        || store.expected_model.is_some()
        || result.is_closed()
        || tokio::time::Instant::now() >= deadline
    {
        *review = None;
        return Err(CHANGED.into());
    }
    let options = options.ok_or(CHANGED)?;
    let lease = ctx.ops.life.operation(format!("open:{}", ctx.session_id))?;
    match request {
        Request::Review { backup } => {
            *review = None;
            let (pending, value) =
                Review::new(store, ctx.session_id, guard, options, backup).await?;
            if result.is_closed() || tokio::time::Instant::now() >= deadline {
                return Err(CHANGED.into());
            }
            *review = Some(pending);
            Ok(Outcome::Reviewed(value))
        }
        Request::Confirm { review_id } => {
            let record = review
                .take()
                .ok_or(CHANGED)?
                .save(&review_id, store, guard, options)
                .await?;
            // Retain the persisted baseline even if subsequent option updates
            // disagree. The next observation then blocks the live composer.
            *guard = ModelGuard::for_connection(
                options,
                Some(&record),
                true,
                ctx.ops.configuration_dialect,
            );
            store.service_record = Some(ServiceRecord::Existing);
            Ok(Outcome::Saved(lease))
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn finish(
    outcome: Result<Outcome, String>,
    result: oneshot::Sender<Result<Value, String>>,
    guard: &mut ModelGuard,
    store: &ConfigStore,
    configuration: &SessionConfig,
    permission: &PermissionGuard,
    events: &SessionSink,
    deadline: tokio::time::Instant,
    busy: bool,
) {
    match outcome {
        Ok(Outcome::Saved(_lease)) => {
            let delivery = if !busy
                && guard.admissible()
                && !result.is_closed()
                && tokio::time::Instant::now() < deadline
                && let Some(options) = configuration.modern_options()
            {
                let mut check = serde_json::to_value(guard.check()).unwrap();
                check["configuration"] =
                    configuration_snapshot(options.clone(), true, guard, store, permission);
                Ok(check)
            } else {
                guard.change_unknown();
                Err(CHANGED.into())
            };
            if result.send(delivery).is_err() {
                guard.change_unknown();
            }
            events(serde_json::json!({"kind":"configCheck", "check":guard.check()}));
        }
        Ok(Outcome::Reviewed(value)) => {
            let _ = result.send(Ok(value));
        }
        Err(error) => {
            let _ = result.send(Err(error));
        }
    }
}
