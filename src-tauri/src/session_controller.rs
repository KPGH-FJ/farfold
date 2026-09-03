use crate::{
    host_ids::FarfoldSessionId,
    host_store::{
        HostStore,
        records::NativeSessionLocatorKind,
        session_binding_index::HostNavigationSnapshot,
        session_open::{SessionOpenBlocker, SessionOpenTarget},
    },
    interaction_registry::InteractionRegistry,
    opencode_protocol::list_sessions,
    opencode_runtime::{self, OpenCodeRuntime, OpenCodeStartOptions},
    pi_runtime::{self, PiRuntime, StartOptions},
    runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME},
    runtime_supervisor::{self, RuntimeSupervisor},
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct HostSessionController {
    lifecycle_command: Mutex<()>,
}

impl HostSessionController {
    pub(crate) fn exclusive<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .lifecycle_command
            .lock()
            .map_err(|_| "Host Session controller is unavailable".to_string())?;
        operation()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSessionOpenInput {
    farfold_session_id: FarfoldSessionId,
    project_trust: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSessionOpenResult {
    farfold_session_id: FarfoldSessionId,
    runtime_product_id: String,
    installation_id: String,
    native_session_id: String,
    runtime_generation: u64,
    opened_at: i64,
    navigation: HostNavigationSnapshot,
}

fn require_openable(target: &SessionOpenTarget) -> Result<(), String> {
    let blockers = target.blockers();
    if blockers.is_empty() {
        return Ok(());
    }
    let names = blockers
        .iter()
        .map(|blocker| match blocker {
            SessionOpenBlocker::SessionArchived => "session_archived",
            SessionOpenBlocker::RuntimeBuildNotCurrent => "runtime_build_not_current",
            SessionOpenBlocker::WorkingCopyUnavailable => "working_copy_unavailable",
            SessionOpenBlocker::NativeLocatorUnavailable => "native_locator_unavailable",
        })
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!("Farfold Session cannot be opened: {names}"))
}

fn require_all_runtimes_stopped(pi: &PiRuntime, opencode: &OpenCodeRuntime) -> Result<(), String> {
    if !pi_runtime::is_stopped(pi)? || !opencode_runtime::is_stopped(opencode)? {
        return Err(
            "All managed Agent Runtimes must be fully stopped before opening a Host Session"
                .to_string(),
        );
    }
    Ok(())
}

fn verify_opencode_target(
    runtime: &OpenCodeRuntime,
    target: &SessionOpenTarget,
) -> Result<u64, String> {
    let connection = opencode_runtime::connection(runtime)?;
    if connection.project_path != target.working_copy_path {
        return Err("OpenCode started in a different Working Copy".to_string());
    }
    let native = list_sessions(&connection)?
        .into_iter()
        .find(|session| {
            session.get("id").and_then(serde_json::Value::as_str)
                == Some(target.native_session_id.as_str())
        })
        .ok_or_else(|| {
            "The bound OpenCode native Session is unavailable from the active connection"
                .to_string()
        })?;
    let directory = native
        .get("directory")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "OpenCode native Session has no Project directory".to_string())?;
    let directory = std::path::PathBuf::from(directory)
        .canonicalize()
        .map_err(|error| format!("Cannot resolve OpenCode native Session Project: {error}"))?;
    if directory != target.working_copy_path {
        return Err("OpenCode native Session belongs to a different Working Copy".to_string());
    }
    Ok(connection.generation)
}

fn cleanup_failed_pi_open(
    app: &AppHandle,
    supervisor: &RuntimeSupervisor,
    runtime: &PiRuntime,
    error: String,
) -> String {
    match runtime_supervisor::pi_stop(app.clone(), supervisor, runtime) {
        Ok(_) => error,
        Err(cleanup) => format!("{error}; Pi cleanup also failed: {cleanup}"),
    }
}

fn cleanup_failed_opencode_open(
    app: &AppHandle,
    supervisor: &RuntimeSupervisor,
    runtime: &OpenCodeRuntime,
    interactions: &InteractionRegistry,
    error: String,
) -> String {
    let cleanup = runtime_supervisor::opencode_stop(app, supervisor, runtime);
    let _ = interactions.advance_generation(
        OPENCODE_RUNTIME,
        opencode_runtime::current_generation(runtime),
    );
    match cleanup {
        Ok(_) => error,
        Err(cleanup) => format!("{error}; OpenCode cleanup also failed: {cleanup}"),
    }
}

#[allow(clippy::too_many_arguments)]
fn open_session(
    app: &AppHandle,
    store: &HostStore,
    supervisor: &RuntimeSupervisor,
    pi: &PiRuntime,
    opencode: &OpenCodeRuntime,
    interactions: &InteractionRegistry,
    input: HostSessionOpenInput,
) -> Result<HostSessionOpenResult, String> {
    require_all_runtimes_stopped(pi, opencode)?;
    let target = store.session_open_target(&input.farfold_session_id)?;
    require_openable(&target)?;
    let definition = target
        .definition()
        .ok_or_else(|| "Farfold Session Runtime is not supported by this build".to_string())?;

    let runtime_generation = if definition == PI_RUNTIME {
        let locator = target
            .locator_path
            .as_deref()
            .filter(|_| target.locator_kind == Some(NativeSessionLocatorKind::PiSessionFile))
            .ok_or_else(|| "Farfold Pi Session locator is unavailable".to_string())?;
        runtime_supervisor::pi_start(
            app.clone(),
            supervisor,
            pi,
            StartOptions::host_session(&target.working_copy_path, locator, input.project_trust),
        )?;
        pi_runtime::verify_active_host_session(
            pi,
            &target.working_copy_path,
            target.native_session_id.as_str(),
            locator,
        )
        .map_err(|error| cleanup_failed_pi_open(app, supervisor, pi, error))?
    } else if definition == OPENCODE_RUNTIME {
        runtime_supervisor::opencode_start(
            app,
            supervisor,
            opencode,
            OpenCodeStartOptions::host_session(&target.working_copy_path),
        )?;
        if let Err(error) = interactions.advance_generation(
            OPENCODE_RUNTIME,
            opencode_runtime::current_generation(opencode),
        ) {
            return Err(cleanup_failed_opencode_open(
                app,
                supervisor,
                opencode,
                interactions,
                error,
            ));
        }
        verify_opencode_target(opencode, &target).map_err(|error| {
            cleanup_failed_opencode_open(app, supervisor, opencode, interactions, error)
        })?
    } else {
        return Err("Farfold Session Runtime is not supported by this build".to_string());
    };

    let (opened_at, navigation) = store
        .mark_session_opened(&target.farfold_session_id)
        .map_err(|error| {
            if definition == PI_RUNTIME {
                cleanup_failed_pi_open(app, supervisor, pi, error)
            } else {
                cleanup_failed_opencode_open(app, supervisor, opencode, interactions, error)
            }
        })?;
    Ok(HostSessionOpenResult {
        farfold_session_id: target.farfold_session_id,
        runtime_product_id: target.runtime_product_id.into_inner(),
        installation_id: target.installation_id.into_inner(),
        native_session_id: target.native_session_id.into_inner(),
        runtime_generation,
        opened_at,
        navigation,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn host_session_open(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    supervisor: State<'_, RuntimeSupervisor>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    interactions: State<'_, InteractionRegistry>,
    input: HostSessionOpenInput,
) -> Result<HostSessionOpenResult, String> {
    controller.exclusive(|| {
        open_session(
            &app,
            &store,
            &supervisor,
            &pi,
            &opencode,
            &interactions,
            input,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{HostSessionController, require_all_runtimes_stopped};
    use crate::{opencode_runtime::OpenCodeRuntime, pi_runtime::PiRuntime};

    #[test]
    fn lifecycle_commands_are_serialized_and_require_quiescence() {
        let controller = HostSessionController::default();
        let pi = PiRuntime::default();
        let opencode = OpenCodeRuntime::default();
        assert_eq!(
            controller
                .exclusive(|| {
                    require_all_runtimes_stopped(&pi, &opencode)?;
                    Ok(7)
                })
                .unwrap(),
            7
        );
    }
}
