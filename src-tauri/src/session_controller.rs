use crate::{
    host_ids::FarfoldSessionId,
    host_store::{
        HostStore,
        records::NativeSessionLocatorKind,
        session_binding_index::{
            HostNavigationSnapshot, ManagedSessionRegistrationInput, SessionMetadataUpdateResult,
            UpdateSessionMetadataInput, register_managed_session,
        },
        session_open::{SessionOpenBlocker, SessionOpenTarget},
    },
    interaction_registry::InteractionRegistry,
    opencode_bindings,
    opencode_protocol::{create_session, list_sessions},
    opencode_runtime::{self, OpenCodeRuntime, OpenCodeRuntimeStatus, OpenCodeStartOptions},
    pi_runtime::{self, PiRuntime, RuntimeStatus, StartOptions},
    runtime_host,
    runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME},
    runtime_supervisor::{self, RuntimeSupervisor},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPiSessionCreateInput {
    project_path: String,
    project_trust: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOpenCodeSessionCreateInput {
    project_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostManagedRuntimeStopInput {
    runtime_product_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPiSessionSyncResult {
    farfold_session_id: FarfoldSessionId,
    locator_available: bool,
    navigation: HostNavigationSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "runtimeProductId", content = "status")]
pub enum HostManagedRuntimeStopResult {
    #[serde(rename = "pi")]
    Pi(RuntimeStatus),
    #[serde(rename = "opencode")]
    OpenCode(OpenCodeRuntimeStatus),
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

struct PiSessionObservation {
    native_session_id: String,
    session_file: PathBuf,
    title: String,
}

fn pi_session_observation(state: &serde_json::Value) -> Result<PiSessionObservation, String> {
    let native_session_id = state
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Pi get_state returned no native Session ID".to_string())?
        .to_string();
    let session_file = state
        .get("sessionFile")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Pi get_state returned no native Session file".to_string())?;
    let title = state
        .get("sessionName")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("新对话")
        .to_string();
    Ok(PiSessionObservation {
        native_session_id,
        session_file: PathBuf::from(session_file),
        title,
    })
}

fn observed_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn register_empty_pi_observation(
    store: &HostStore,
    project_path: &Path,
    session_dir: &Path,
    observation: &PiSessionObservation,
    observed_at: u64,
) -> Result<FarfoldSessionId, String> {
    if observation
        .session_file
        .extension()
        .is_none_or(|value| value != "jsonl")
    {
        return Err("Pi reported a non-JSONL Session locator".to_string());
    }
    let parent = observation
        .session_file
        .parent()
        .ok_or_else(|| "Pi reported a Session locator without a parent directory".to_string())?
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Pi Session directory: {error}"))?;
    let session_dir = session_dir
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Farfold Pi Session directory: {error}"))?;
    if parent != session_dir {
        return Err("Pi reported a Session locator outside Farfold Session storage".to_string());
    }
    register_managed_session(
        store,
        PI_RUNTIME,
        ManagedSessionRegistrationInput {
            native_session_id: &observation.native_session_id,
            working_copy_path: project_path,
            title: &observation.title,
            created_at: observed_at,
            updated_at: observed_at,
        },
    )
    .map(|(farfold_session_id, _)| farfold_session_id)
}

fn register_active_pi_observation(
    app: &AppHandle,
    store: &HostStore,
    pi: &PiRuntime,
    project_path: &Path,
    state: &serde_json::Value,
) -> Result<PiSessionObservation, String> {
    let observation = pi_session_observation(state)?;
    if observation.session_file.is_file() {
        pi_runtime::pi_runtime_remember_session(
            pi,
            store,
            observation.session_file.to_string_lossy().into_owned(),
        )?;
    } else {
        register_empty_pi_observation(
            store,
            project_path,
            &pi_runtime::running_session_dir(pi)?,
            &observation,
            observed_millis(),
        )?;
    }
    let profile_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?;
    crate::host_store::legacy::finalize_pi_pointer_if_bound(store, &profile_path)?;
    Ok(observation)
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

fn create_pi_session(
    app: &AppHandle,
    store: &HostStore,
    supervisor: &RuntimeSupervisor,
    pi: &PiRuntime,
    opencode: &OpenCodeRuntime,
    input: HostPiSessionCreateInput,
) -> Result<HostSessionOpenResult, String> {
    if !opencode_runtime::is_stopped(opencode)? {
        return Err("OpenCode must be fully stopped before creating a Pi Session".to_string());
    }
    let project_path = std::path::PathBuf::from(input.project_path)
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Pi Working Copy: {error}"))?;
    if !project_path.is_dir() {
        return Err("Pi Working Copy is not a directory".to_string());
    }
    let observed = crate::runtime_registry::verify_managed_installation(app, PI_RUNTIME)?;
    runtime_host::register_verified_runtime(store, &observed)?;

    let running = pi_runtime::is_running(pi)?;
    if running {
        if pi_runtime::running_project_path(pi)? != project_path {
            return Err(
                "Pi is running in another Working Copy; stop it before creating this Session"
                    .to_string(),
            );
        }
        pi_runtime::create_native_session(pi)?;
    } else {
        if !pi_runtime::is_stopped(pi)? {
            return Err("Pi Runtime is already changing state".to_string());
        }
        runtime_supervisor::pi_start(
            app.clone(),
            supervisor,
            pi,
            StartOptions::host_new(&project_path, input.project_trust),
        )?;
    }

    let registered = (|| -> Result<HostSessionOpenResult, String> {
        let state = pi_runtime::active_host_state(pi)?;
        let observation = register_active_pi_observation(app, store, pi, &project_path, &state)?;
        let navigation = store.navigation_snapshot()?;
        let binding = navigation
            .session_index
            .sessions
            .iter()
            .find(|session| {
                session.runtime_product_id.as_str() == PI_RUNTIME.product_id
                    && session.native_session_id.as_str() == observation.native_session_id
                    && session.archived_at.is_none()
            })
            .ok_or_else(|| "Host did not register the new Pi Session".to_string())?;
        Ok(HostSessionOpenResult {
            farfold_session_id: binding.farfold_session_id.clone(),
            runtime_product_id: binding.runtime_product_id.as_str().to_string(),
            installation_id: binding.installation_id.as_str().to_string(),
            native_session_id: binding.native_session_id.as_str().to_string(),
            runtime_generation: pi_runtime::running_generation(pi)?,
            opened_at: binding.last_opened_at,
            navigation,
        })
    })();
    registered.map_err(|error| cleanup_failed_pi_open(app, supervisor, pi, error))
}

#[allow(clippy::too_many_arguments)]
fn create_opencode_session(
    app: &AppHandle,
    store: &HostStore,
    supervisor: &RuntimeSupervisor,
    pi: &PiRuntime,
    opencode: &OpenCodeRuntime,
    interactions: &InteractionRegistry,
    input: HostOpenCodeSessionCreateInput,
) -> Result<HostSessionOpenResult, String> {
    require_all_runtimes_stopped(pi, opencode)?;
    let project_path = std::path::PathBuf::from(input.project_path)
        .canonicalize()
        .map_err(|error| format!("Cannot resolve OpenCode Working Copy: {error}"))?;
    if !project_path.is_dir() {
        return Err("OpenCode Working Copy is not a directory".to_string());
    }
    let observed = crate::runtime_registry::verify_managed_installation(app, OPENCODE_RUNTIME)?;
    runtime_host::register_verified_runtime(store, &observed)?;
    runtime_supervisor::opencode_start(
        app,
        supervisor,
        opencode,
        OpenCodeStartOptions::host_session(&project_path),
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

    let registered = (|| -> Result<HostSessionOpenResult, String> {
        let connection = opencode_runtime::connection(opencode)?;
        if connection.project_path != project_path {
            return Err("OpenCode started in a different Working Copy".to_string());
        }
        let native = create_session(&connection, Some("新对话".to_string()))?;
        let native_session_id = native
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "OpenCode returned no native Session ID".to_string())?;
        opencode_bindings::remember_active_binding(app, opencode, store, native_session_id)?;
        let navigation = store.navigation_snapshot()?;
        let binding = navigation
            .session_index
            .sessions
            .iter()
            .find(|session| {
                session.runtime_product_id.as_str() == OPENCODE_RUNTIME.product_id
                    && session.native_session_id.as_str() == native_session_id
                    && session.archived_at.is_none()
            })
            .ok_or_else(|| "Host did not register the new OpenCode Session".to_string())?;
        Ok(HostSessionOpenResult {
            farfold_session_id: binding.farfold_session_id.clone(),
            runtime_product_id: binding.runtime_product_id.as_str().to_string(),
            installation_id: binding.installation_id.as_str().to_string(),
            native_session_id: binding.native_session_id.as_str().to_string(),
            runtime_generation: connection.generation,
            opened_at: binding.last_opened_at,
            navigation,
        })
    })();
    registered.map_err(|error| {
        cleanup_failed_opencode_open(app, supervisor, opencode, interactions, error)
    })
}

fn sync_active_pi_session(
    app: &AppHandle,
    store: &HostStore,
    pi: &PiRuntime,
) -> Result<HostPiSessionSyncResult, String> {
    let project_path = pi_runtime::running_project_path(pi)?;
    let state = pi_runtime::active_host_state(pi)?;
    let observation = register_active_pi_observation(app, store, pi, &project_path, &state)?;
    let navigation = store.navigation_snapshot()?;
    let binding = navigation
        .session_index
        .sessions
        .iter()
        .find(|session| {
            session.runtime_product_id.as_str() == PI_RUNTIME.product_id
                && session.native_session_id.as_str() == observation.native_session_id
                && session.archived_at.is_none()
        })
        .ok_or_else(|| "Host did not register the active Pi Session".to_string())?;
    Ok(HostPiSessionSyncResult {
        farfold_session_id: binding.farfold_session_id.clone(),
        locator_available: observation.session_file.is_file(),
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn host_pi_session_create(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    supervisor: State<'_, RuntimeSupervisor>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: HostPiSessionCreateInput,
) -> Result<HostSessionOpenResult, String> {
    controller.exclusive(|| create_pi_session(&app, &store, &supervisor, &pi, &opencode, input))
}

#[tauri::command]
pub fn host_pi_active_session_sync(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    pi: State<'_, PiRuntime>,
) -> Result<HostPiSessionSyncResult, String> {
    controller.exclusive(|| sync_active_pi_session(&app, &store, &pi))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn host_opencode_session_create(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    supervisor: State<'_, RuntimeSupervisor>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    interactions: State<'_, InteractionRegistry>,
    input: HostOpenCodeSessionCreateInput,
) -> Result<HostSessionOpenResult, String> {
    controller.exclusive(|| {
        create_opencode_session(
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

#[tauri::command]
pub fn host_session_metadata_update(
    controller: State<'_, HostSessionController>,
    store: State<'_, HostStore>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: UpdateSessionMetadataInput,
) -> Result<SessionMetadataUpdateResult, String> {
    controller.exclusive(|| {
        if input.archives_session() {
            require_all_runtimes_stopped(&pi, &opencode)?;
        }
        store.update_session_metadata(input)
    })
}

#[tauri::command]
pub fn host_managed_runtime_stop(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    supervisor: State<'_, RuntimeSupervisor>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    interactions: State<'_, InteractionRegistry>,
    input: HostManagedRuntimeStopInput,
) -> Result<HostManagedRuntimeStopResult, String> {
    controller.exclusive(|| match input.runtime_product_id.trim() {
        "pi" => {
            runtime_supervisor::pi_stop(app, &supervisor, &pi).map(HostManagedRuntimeStopResult::Pi)
        }
        "opencode" => {
            let result = runtime_supervisor::opencode_stop(&app, &supervisor, &opencode);
            interactions.advance_generation(
                OPENCODE_RUNTIME,
                opencode_runtime::current_generation(&opencode),
            )?;
            result.map(HostManagedRuntimeStopResult::OpenCode)
        }
        _ => Err("Managed Runtime product is not supported by this build".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        HostSessionController, PiSessionObservation, register_empty_pi_observation,
        require_all_runtimes_stopped,
    };
    use crate::{
        host_ids::{AdapterId, ConnectionId, InstallationId, RuntimeBuildId, RuntimeProductId},
        host_store::{
            HostStore,
            records::{RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration},
            session_open::SessionOpenBlocker,
        },
        opencode_runtime::OpenCodeRuntime,
        pi_runtime::PiRuntime,
        runtime_registry::PI_RUNTIME,
    };
    use std::{fs, path::PathBuf};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "farfold-session-controller-{}-{}",
                std::process::id(),
                std::thread::current().name().unwrap_or("test")
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn register_pi_runtime(store: &HostStore) {
        store
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
                display_name: PI_RUNTIME.display_name.to_string(),
                installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(PI_RUNTIME.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(PI_RUNTIME.adapter_id).unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: PI_RUNTIME.version.to_string(),
                artifact_sha256: PI_RUNTIME.binary_sha256.to_string(),
                connection_id: ConnectionId::parse(PI_RUNTIME.default_connection_id).unwrap(),
                connection_label: "Pi native configuration".to_string(),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();
    }

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

    #[test]
    fn empty_pi_session_is_bound_before_its_native_jsonl_exists() {
        let root = TestDirectory::new();
        let project = root.0.join("project");
        let session_dir = root.0.join("sessions");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&session_dir).unwrap();
        let store = HostStore::open(root.0.join("host.sqlite3"));
        register_pi_runtime(&store);
        let observation = PiSessionObservation {
            native_session_id: "pi-empty-native-session".to_string(),
            session_file: session_dir.join("pi-empty-native-session.jsonl"),
            title: "新对话".to_string(),
        };

        let farfold_session_id =
            register_empty_pi_observation(&store, &project, &session_dir, &observation, 2).unwrap();
        let navigation = store.navigation_snapshot().unwrap();
        assert!(!navigation.session_index.sessions[0].native_locator_registered);
        assert_eq!(
            serde_json::to_value(navigation.restore_state.unwrap()).unwrap()["lastSessionId"],
            farfold_session_id.as_str()
        );
        let target = store.session_open_target(&farfold_session_id).unwrap();
        assert_eq!(target.native_session_id.as_str(), "pi-empty-native-session");
        assert_eq!(
            target.blockers(),
            vec![SessionOpenBlocker::NativeLocatorUnavailable]
        );
    }
}
