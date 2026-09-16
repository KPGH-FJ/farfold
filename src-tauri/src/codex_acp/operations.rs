//! Stateless command facade over the existing owned lifecycle and Configure authority.
//! Production rejects before state lookup, profile access, parsing secrets or dispatch.
use super::{configure, profile, *};
use crate::{
    host_ids::{RuntimeProfileId, WorkingCopyId},
    host_store::{HostStore, records::*},
};
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
            Self::Production => Err(OperationError::Unavailable),
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
        | Input::Focus { .. } => Err("Session operation requires original shared store".into()),
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

fn execute(
    runtime: &configure::Runtime,
    store: &HostStore,
    input: Input,
    coordinator: &crate::turn_coordinator::TurnCoordinator,
    router: &crate::runtime_event_router::RuntimeEventRouter,
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
    // No spawn, app.state(), database read, profile access or native request before gate.
    // No deserializable enable flag, environment setting or production test entry exists.
    gated(Entry::Production, input, |input| {
        execute(
            &app.state::<configure::Runtime>(),
            &app.state::<HostStore>(),
            input,
            &app.state::<crate::turn_coordinator::TurnCoordinator>(),
            &app.state::<crate::runtime_event_router::RuntimeEventRouter>(),
        )
    })
}

#[cfg(test)]
mod tests;
