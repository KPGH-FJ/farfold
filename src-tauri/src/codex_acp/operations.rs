//! Stateless command facade over the existing owned lifecycle and Configure authority.
//! All inputs are validated before state lookup, profile access, secrets or dispatch.
use super::{configure, profile, *};
use crate::{
    host_ids::{InstallationId, RuntimeProfileId, WorkingCopyId, derived_host_id},
    host_store::{HostStore, records::*},
};
use std::{fs, os::unix::fs::DirBuilderExt, path::PathBuf};
use tauri::{AppHandle, Manager};

// Deliberately no Debug/Serialize: request contents may include temporary secrets.
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Input {
    History {
        scope: Scope,
        farfold_session_id: crate::host_ids::FarfoldSessionId,
    },
    Turn {
        scope: Scope,
        command: turns::TurnCommandInput,
    },
    Focus {
        receipt: Box<sessions::Snapshot>,
        expected_navigation: crate::host_store::session_open::NavigationExpectation,
    },
    Session {
        scope: Scope,
        command: Box<sessions::CommandInput>,
    },
    Connect {
        installation_id: InstallationId,
        working_copy_id: WorkingCopyId,
    },
    Restore {
        scope: Scope,
        working_copy_id: WorkingCopyId,
    },
    Stop {
        scope: Scope,
    },
    DiscoverConfigure {
        scope: Scope,
    },
    Configure {
        scope: Scope,
        command: configure::CommandInput,
    },
    Admission {
        scope: Scope,
        command: Box<admission::ViewCommand>,
    },
    Interact {
        scope: Scope,
        key: String,
        reply: crate::codex_interactions::CodexInteractionReply,
    },
    Steer {
        scope: Scope,
        context: Box<turns::Context>,
        native_turn_id: String,
        operation_id: String,
        text: String,
    },
}

// Configure is a private command response, never an event or persisted snapshot.
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Receipt {
    History {
        snapshot: turns::HistorySnapshot,
    },
    Turn {
        snapshot: turns::TurnSnapshot,
    },
    Focused {
        scope: Scope,
        farfold_session_id: crate::host_ids::FarfoldSessionId,
        navigation: crate::host_store::session_binding_index::HostNavigationSnapshot,
    },
    Session {
        snapshot: sessions::Snapshot,
    },
    Connected {
        scope: Scope,
    },
    Stopped {
        scope: Scope,
    },
    Configure {
        snapshot: configure::Snapshot,
    },
    ConfigureDiscovery {
        discovery: configure::Discovery,
    },
    Admission {
        snapshot: admission::ViewSnapshot,
    },
    Replied,
    Steered,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationError {
    Unavailable,
    InvalidRequest,
    // Not a claim of not-sent, rollback, completion, or safe automatic retry.
    Unconfirmed,
}

enum Entry {
    Production,
    #[cfg(test)]
    Synthetic,
}
impl Entry {
    fn admit(self) -> Result<(), OperationError> {
        match self {
            Self::Production => Ok(()),
            #[cfg(test)]
            Self::Synthetic => Ok(()),
        }
    }
}

fn gated(
    entry: Entry,
    input: Value,
    execute: impl FnOnce(Input) -> Result<Receipt, String>,
) -> Result<Receipt, OperationError> {
    entry.admit()?;
    let input = serde_json::from_value(input).map_err(|_| OperationError::InvalidRequest)?;
    execute(input).map_err(|_| OperationError::Unconfirmed)
}

fn dispatch(
    runtime: &configure::Runtime,
    input: Input,
    restore: impl FnOnce(&Scope, &WorkingCopyId) -> Result<Scope, String>,
) -> Result<Receipt, String> {
    match input {
        Input::History { .. }
        | Input::Turn { .. }
        | Input::Session { .. }
        | Input::Focus { .. }
        | Input::Connect { .. }
        | Input::Interact { .. }
        | Input::Steer { .. } => {
            Err("Session operation requires original shared store".into())
        }
        Input::Admission { scope, command } => {
            scope.validate()?;
            runtime
                .admission_view(&scope, *command)
                .map(|snapshot| Receipt::Admission { snapshot })
        }
        Input::DiscoverConfigure { scope } => {
            scope.validate()?;
            runtime
                .discover_configure(&scope)
                .map(|discovery| Receipt::ConfigureDiscovery { discovery })
        }
        Input::Restore {
            scope,
            working_copy_id,
        } => {
            scope.validate()?;
            let next = restore(&scope, &working_copy_id)?;
            // A new generation is owned by persistent Host state, not the UI.
            let mut original = scope.clone();
            original.generation = next.generation;
            if next != original || next.generation <= scope.generation {
                return Err("Owned restore receipt does not match original target".into());
            }
            Ok(Receipt::Connected { scope: next })
        }
        Input::Stop { scope } => {
            scope.validate()?;
            runtime.stop(&scope)?;
            Ok(Receipt::Stopped { scope })
        }
        Input::Configure { scope, command } => {
            scope.validate()?;
            runtime
                .configure(&scope, command)
                .map(|snapshot| Receipt::Configure { snapshot })
        }
    }
}

fn restore_request(
    store: &HostStore,
    scope: &Scope,
    working_copy_id: &WorkingCopyId,
) -> Result<profile::OwnedRequest, String> {
    let binding = scope.binding()?;
    let profile_id = RuntimeProfileId::parse(&scope.profile_id).map_err(|_| "Invalid profile")?;
    let saved = store.current_owned_profile_launch(&binding, &profile_id, scope.generation)?;
    let parent = saved.home.parent().ok_or("Owned parent missing")?;
    if saved.working_copy_id != *working_copy_id
        || saved.home != parent.join(&scope.profile_id)
        || saved.runtime_home != saved.home.join("codex")
        || saved.adapter_version != ADAPTER_VERSION
    {
        return Err("Original owned launch target differs".into());
    }
    Ok(profile::OwnedRequest {
        launch: Launch {
            node: saved.node,
            adapter: saved.adapter,
            native: saved.native,
            owned_parent: parent.into(),
            cwd: saved.cwd,
            working_copy_id: Some(working_copy_id.clone()),
            scope: scope.clone(),
        },
        registration: RuntimeRegistration {
            runtime_product_id: binding.product_id,
            installation_id: binding.installation_id,
            runtime_build_id: binding.runtime_build_id,
            adapter_id: binding.adapter_id,
            connection_id: binding.connection_id,
            display_name: "Codex".into(),
            distribution: RuntimeDistribution::System,
            observed_version: "0.143.0".into(),
            artifact_sha256: NATIVE_SHA.into(),
            connection_label: "Owned Codex".into(),
            connection_kind: RuntimeConnectionKind::SystemLocal,
            // Restore checks the existing registration, never writes these labels/times.
            created_at: 0,
            verified_at: 0,
        },
        working_copy_id: working_copy_id.clone(),
        create: false,
    })
}

enum ConnectPlan {
    Create(profile::OwnedRequest),
    Restore(profile::OwnedRequest, u64),
}

fn codex_adapter_assets(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let packaged = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .ancestors()
        .any(|path| path.extension().is_some_and(|extension| extension == "app"));
    let node = resources.join("pi-capability-runtime/runtime/node");
    let adapter = resources.join("codex-acp-adapter/adapter.mjs");
    Ok(if packaged || (node.is_file() && adapter.is_file()) {
        (node, adapter)
    } else {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        (
            manifest.join("capability-bridge/runtime/node"),
            manifest.join("codex-acp-adapter/adapter.mjs"),
        )
    })
}

/// First owned launch creates its profile; a persisted profile restores exactly.
/// The owned installation binds the verified native executable, not the shim.
fn connect_plan(
    app: &AppHandle,
    store: &HostStore,
    installation_id: &InstallationId,
    working_copy_id: &WorkingCopyId,
) -> Result<ConnectPlan, String> {
    let registered = store
        .system_installations()?
        .into_iter()
        .find(|i| i.installation_id == *installation_id)
        .ok_or("Registered Codex installation missing")?;
    let native = registered.inspection.launch.executable_path().to_path_buf();
    let workspace = store.registered_session_workspace(working_copy_id)?;
    let owned_installation = InstallationId::parse(derived_host_id(
        "system-installation",
        &["codex", &native.to_string_lossy()],
    ))
    .map_err(|e| e.to_string())?;
    let profile_id = RuntimeProfileId::parse(derived_host_id(
        "codex-acp-profile",
        &[owned_installation.as_str(), working_copy_id.as_str()],
    ))
    .map_err(|e| e.to_string())?;
    let connection = crate::host_ids::ConnectionId::parse(derived_host_id(
        "connection",
        &[
            owned_installation.as_str(),
            "farfold-owned-acp",
            working_copy_id.as_str(),
        ],
    ))
    .map_err(|e| e.to_string())?;
    let scope = Scope {
        runtime_product_id: "codex".into(),
        installation_id: owned_installation.as_str().into(),
        runtime_build_id: NATIVE_SHA.into(),
        adapter_id: "codex-acp-stdio-v1".into(),
        adapter_build_id: ADAPTER_SHA.into(),
        connection_id: connection.as_str().into(),
        profile_id: profile_id.as_str().into(),
        generation: 1,
    };
    let binding = scope.binding()?;
    if store.runtime_owned_profile(&binding)?.is_some() {
        let generation = store.owned_profile_launch_generation(&binding, &profile_id)?;
        let mut restore_scope = scope;
        restore_scope.generation = generation;
        return Ok(ConnectPlan::Restore(
            restore_request(store, &restore_scope, working_copy_id)?,
            generation,
        ));
    }
    let owned_parent = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("codex-acp");
    if fs::symlink_metadata(&owned_parent).is_err() {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&owned_parent)
            .map_err(|_| "Cannot create owned profile parent")?;
    }
    let (node, adapter) = codex_adapter_assets(app)?;
    let now = crate::host_store::now_millis();
    Ok(ConnectPlan::Create(profile::OwnedRequest {
        launch: Launch {
            node,
            adapter,
            native,
            owned_parent,
            cwd: workspace.cwd,
            working_copy_id: Some(working_copy_id.clone()),
            scope,
        },
        registration: RuntimeRegistration {
            runtime_product_id: binding.product_id,
            installation_id: binding.installation_id,
            runtime_build_id: binding.runtime_build_id,
            adapter_id: binding.adapter_id,
            connection_id: binding.connection_id,
            display_name: "Codex".into(),
            distribution: RuntimeDistribution::System,
            observed_version: "0.143.0".into(),
            artifact_sha256: NATIVE_SHA.into(),
            connection_label: "Owned Codex".into(),
            connection_kind: RuntimeConnectionKind::SystemLocal,
            created_at: now,
            verified_at: now,
        },
        working_copy_id: working_copy_id.clone(),
        create: true,
    }))
}

fn execute(
    runtime: &configure::Runtime,
    store: &HostStore,
    input: Input,
    coordinator: &crate::turn_coordinator::TurnCoordinator,
    router: &crate::runtime_event_router::RuntimeEventRouter,
    connect: impl FnOnce(&InstallationId, &WorkingCopyId) -> Result<Scope, String>,
    interact: impl FnOnce(
        &Scope,
        &str,
        crate::codex_interactions::CodexInteractionReply,
    ) -> Result<(), String>,
    steer: impl FnOnce(&Scope, &turns::Context, &str, &str, &str) -> Result<(), String>,
) -> Result<Receipt, String> {
    if let Input::History {
        scope,
        farfold_session_id,
    } = input
    {
        return runtime
            .history_operation(store, &scope, &farfold_session_id, router)
            .map(|snapshot| Receipt::History { snapshot });
    }
    if let Input::Turn { scope, command } = input {
        return runtime
            .turn_operation(store, &scope, command, coordinator, router)
            .map(|snapshot| Receipt::Turn { snapshot });
    }
    if let Input::Focus {
        receipt,
        expected_navigation,
    } = input
    {
        let navigation = runtime.focus_registered_session(store, &receipt, &expected_navigation)?;
        return Ok(Receipt::Focused {
            scope: receipt.scope,
            farfold_session_id: receipt.farfold_session_id,
            navigation,
        });
    }
    if let Input::Session { scope, command } = input {
        return runtime
            .session_operation(store, &scope, *command)
            .map(|snapshot| Receipt::Session { snapshot });
    }
    if let Input::Connect {
        installation_id,
        working_copy_id,
    } = input
    {
        return connect(&installation_id, &working_copy_id)
            .map(|scope| Receipt::Connected { scope });
    }
    if let Input::Interact { scope, key, reply } = input {
        scope.validate()?;
        return interact(&scope, &key, reply).map(|_| Receipt::Replied);
    }
    if let Input::Steer {
        scope,
        context,
        native_turn_id,
        operation_id,
        text,
    } = input
    {
        scope.validate()?;
        return steer(&scope, &context, &native_turn_id, &operation_id, &text)
            .map(|_| Receipt::Steered);
    }
    dispatch(runtime, input, |scope, working_copy_id| {
        runtime.start_connection(|| {
            let request = restore_request(store, scope, working_copy_id)?;
            let (launch, lease) = profile::prepare_restore(store, request, scope.generation)?;
            Connection::start_inner(launch, Some(lease))
        })
    })
}

#[tauri::command]
pub async fn host_codex_acp_operation(
    app: AppHandle,
    input: Value,
) -> Result<Receipt, OperationError> {
    // Input validation precedes state lookup, profile access, secrets or dispatch.
    gated(Entry::Production, input, |input| {
        let runtime = app.state::<configure::Runtime>();
        let store = app.state::<HostStore>();
        let registry = app.state::<crate::interaction_registry::InteractionRegistry>();
        execute(
            &runtime,
            &store,
            input,
            &app.state::<crate::turn_coordinator::TurnCoordinator>(),
            &app.state::<crate::runtime_event_router::RuntimeEventRouter>(),
            |installation_id, working_copy_id| {
                let plan = connect_plan(&app, &store, installation_id, working_copy_id)?;
                runtime.start_connection(|| {
                    let (launch, lease) = match plan {
                        ConnectPlan::Create(request) => profile::prepare(&store, request),
                        ConnectPlan::Restore(request, generation) => {
                            profile::prepare_restore(&store, request, generation)
                        }
                    }?;
                    Connection::start_inner(launch, Some(lease))
                })
            },
            |scope, key, reply| {
                let interaction =
                    registry.codex_acp_request(&scope.binding()?, scope.generation, key)?;
                runtime.reply_interaction(&store, &registry, &interaction, reply)
            },
            |scope, context, native_turn_id, operation_id, text| {
                runtime.steer_turn(&store, scope, context, native_turn_id, operation_id, text)
            },
        )
    })
}

#[cfg(test)]
mod tests;
