use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};

use crate::{
    host_store::{
        HostStore,
        session_binding_index::{ManagedSessionRegistrationInput, register_managed_session},
    },
    opencode_protocol::list_sessions,
    opencode_runtime::{OpenCodeRuntime, connection},
    runtime_registry::{
        OPENCODE_RUNTIME, OPENCODE_RUNTIME_ADAPTER_ID,
        OPENCODE_RUNTIME_CONNECTION_ID as OPENCODE_LOCAL_CONNECTION_ID,
        OPENCODE_RUNTIME_INSTALLATION_ID, OPENCODE_RUNTIME_PRODUCT_ID, RuntimeIdentity,
        opencode_identity,
    },
};

const STORE_VERSION: u32 = 1;

#[derive(Default)]
pub struct OpenCodeBindingRepository {
    lock: Mutex<()>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberOpenCodeBindingInput {
    native_session_id: String,
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct LegacyRememberOpenCodeBindingInput {
    native_session_id: String,
    project_path: String,
    title: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeSessionBinding {
    runtime: RuntimeIdentity,
    connection_id: String,
    native_session_id: String,
    project_path: String,
    title: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredOpenCodeBinding {
    runtime: RuntimeIdentity,
    connection_id: String,
    native_session_id: String,
    project_path: String,
    title: String,
    created_at: u64,
    updated_at: u64,
}

impl StoredOpenCodeBinding {
    fn output(&self) -> OpenCodeSessionBinding {
        OpenCodeSessionBinding {
            runtime: self.runtime.clone(),
            connection_id: self.connection_id.clone(),
            native_session_id: self.native_session_id.clone(),
            project_path: self.project_path.clone(),
            title: self.title.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OpenCodeBindingStore {
    version: u32,
    bindings: Vec<StoredOpenCodeBinding>,
}

impl Default for OpenCodeBindingStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            bindings: Vec::new(),
        }
    }
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?
        .join("opencode-session-bindings.json"))
}

fn read_store(path: &Path) -> Result<OpenCodeBindingStore, String> {
    if !path.exists() {
        return Ok(OpenCodeBindingStore::default());
    }
    let body = fs::read(path)
        .map_err(|error| format!("Cannot read OpenCode Session bindings: {error}"))?;
    let store: OpenCodeBindingStore = serde_json::from_slice(&body)
        .map_err(|error| format!("OpenCode Session binding store is invalid: {error}"))?;
    if store.version != STORE_VERSION {
        return Err(format!(
            "Unsupported OpenCode Session binding store version {}",
            store.version
        ));
    }
    Ok(store)
}

fn valid_native_session_id(value: &str) -> bool {
    value.starts_with("ses_")
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[cfg(test)]
fn remember_binding(
    store: &mut OpenCodeBindingStore,
    input: LegacyRememberOpenCodeBindingInput,
) -> Result<OpenCodeSessionBinding, String> {
    let native_session_id = input.native_session_id.trim().to_string();
    if !valid_native_session_id(&native_session_id) {
        return Err("OpenCode native Session ID is invalid".to_string());
    }
    let project_path = PathBuf::from(input.project_path)
        .canonicalize()
        .map_err(|error| format!("Cannot resolve OpenCode Session Project: {error}"))?;
    if !project_path.is_dir() {
        return Err("OpenCode Session Project is not a directory".to_string());
    }
    let project_path = project_path.to_string_lossy().into_owned();
    let title = input.title.trim();
    let title = if title.is_empty() {
        "OpenCode Session".to_string()
    } else {
        title.chars().take(160).collect()
    };
    if let Some(existing) = store
        .bindings
        .iter_mut()
        .find(|binding| binding.native_session_id == native_session_id)
    {
        if existing.runtime != opencode_identity()
            || existing.connection_id != OPENCODE_LOCAL_CONNECTION_ID
        {
            return Err(
                "An OpenCode native Session cannot be rebound to another installation or connection"
                    .to_string(),
            );
        }
        if existing.project_path != project_path {
            return Err(
                "An OpenCode native Session cannot be rebound to another Project".to_string(),
            );
        }
        existing.title = title;
        existing.updated_at = existing.updated_at.max(input.updated_at);
        return Ok(existing.output());
    }
    let stored = StoredOpenCodeBinding {
        runtime: opencode_identity(),
        connection_id: OPENCODE_LOCAL_CONNECTION_ID.to_string(),
        native_session_id,
        project_path,
        title,
        created_at: input.created_at,
        updated_at: input.updated_at.max(input.created_at),
    };
    let output = stored.output();
    store.bindings.push(stored);
    store
        .bindings
        .sort_by_key(|binding| std::cmp::Reverse(binding.updated_at));
    store.bindings.truncate(500);
    Ok(output)
}

#[tauri::command]
pub fn opencode_binding_list(
    app: AppHandle,
    repository: State<'_, OpenCodeBindingRepository>,
    host: State<'_, HostStore>,
) -> Result<Vec<OpenCodeSessionBinding>, String> {
    let _guard = repository
        .lock
        .lock()
        .map_err(|_| "OpenCode Session binding store lock is unavailable".to_string())?;
    let legacy = read_store(&store_path(&app)?)?.bindings;
    let mut bindings = host
        .session_binding_index_snapshot()?
        .sessions
        .into_iter()
        .filter(|binding| {
            binding.runtime_product_id.as_str() == OPENCODE_RUNTIME_PRODUCT_ID
                && binding.installation_id.as_str() == OPENCODE_RUNTIME_INSTALLATION_ID
                && binding.adapter_id.as_str() == OPENCODE_RUNTIME_ADAPTER_ID
                && binding.connection_id.as_str() == OPENCODE_LOCAL_CONNECTION_ID
                && binding.archived_at.is_none()
        })
        .map(|binding| {
            Ok(OpenCodeSessionBinding {
                runtime: opencode_identity(),
                connection_id: binding.connection_id.into_inner(),
                native_session_id: binding.native_session_id.into_inner(),
                project_path: binding.working_copy_path,
                title: binding.title,
                created_at: u64::try_from(binding.created_at)
                    .map_err(|_| "Host OpenCode Session creation time is invalid".to_string())?,
                updated_at: u64::try_from(binding.updated_at)
                    .map_err(|_| "Host OpenCode Session update time is invalid".to_string())?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let host_native_ids = bindings
        .iter()
        .map(|binding| binding.native_session_id.clone())
        .collect::<HashSet<_>>();
    bindings.extend(
        legacy
            .iter()
            .filter(|binding| !host_native_ids.contains(binding.native_session_id.as_str()))
            .map(StoredOpenCodeBinding::output),
    );
    bindings.sort_by_key(|binding| std::cmp::Reverse(binding.updated_at));
    Ok(bindings)
}

#[tauri::command]
pub fn opencode_binding_remember(
    runtime: State<'_, OpenCodeRuntime>,
    host: State<'_, HostStore>,
    input: RememberOpenCodeBindingInput,
) -> Result<OpenCodeSessionBinding, String> {
    let native_session_id = input.native_session_id.trim();
    if !valid_native_session_id(native_session_id) {
        return Err("OpenCode native Session ID is invalid".to_string());
    }
    let connection = connection(&runtime)?;
    let native = list_sessions(&connection)?
        .into_iter()
        .find(|session| {
            session.get("id").and_then(serde_json::Value::as_str) == Some(native_session_id)
        })
        .ok_or_else(|| {
            "OpenCode native Session is not available from the active connection".to_string()
        })?;
    let directory = native
        .get("directory")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "OpenCode native Session has no Project directory".to_string())?;
    let directory = PathBuf::from(directory)
        .canonicalize()
        .map_err(|error| format!("Cannot resolve OpenCode native Session Project: {error}"))?;
    if directory != connection.project_path {
        return Err("OpenCode native Session belongs to a different active Project".to_string());
    }
    let title = native
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("OpenCode Session");
    let title = if title.trim().is_empty() {
        "OpenCode Session"
    } else {
        title.trim()
    };
    let time = native
        .get("time")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "OpenCode native Session has no timestamps".to_string())?;
    let created_at = time
        .get("created")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "OpenCode native Session creation time is invalid".to_string())?;
    let updated_at = time
        .get("updated")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "OpenCode native Session update time is invalid".to_string())?;
    register_managed_session(
        &host,
        OPENCODE_RUNTIME,
        ManagedSessionRegistrationInput {
            native_session_id,
            working_copy_path: &directory,
            title,
            created_at,
            updated_at,
        },
    )?;
    Ok(OpenCodeSessionBinding {
        runtime: opencode_identity(),
        connection_id: OPENCODE_LOCAL_CONNECTION_ID.to_string(),
        native_session_id: native_session_id.to_string(),
        project_path: directory.to_string_lossy().into_owned(),
        title: title.to_string(),
        created_at,
        updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        LegacyRememberOpenCodeBindingInput, OpenCodeBindingStore, read_store, remember_binding,
    };
    use std::{fs, path::PathBuf};

    fn test_directory(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "farfold-opencode-binding-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn native_session_binding_cannot_change_project() {
        let first_project = test_directory("immutable-first");
        let second_project = test_directory("immutable-second");
        let mut store = OpenCodeBindingStore::default();
        remember_binding(
            &mut store,
            LegacyRememberOpenCodeBindingInput {
                native_session_id: "ses_immutable".to_string(),
                project_path: first_project.to_string_lossy().into_owned(),
                title: "First".to_string(),
                created_at: 10,
                updated_at: 10,
            },
        )
        .unwrap();

        let error = remember_binding(
            &mut store,
            LegacyRememberOpenCodeBindingInput {
                native_session_id: "ses_immutable".to_string(),
                project_path: second_project.to_string_lossy().into_owned(),
                title: "Moved".to_string(),
                created_at: 10,
                updated_at: 20,
            },
        )
        .unwrap_err();

        assert!(error.contains("cannot be rebound"));
        assert_eq!(store.bindings[0].title, "First");
        let _ = fs::remove_dir_all(first_project);
        let _ = fs::remove_dir_all(second_project);
    }

    #[test]
    fn native_session_binding_cannot_change_installation() {
        let project = test_directory("immutable-installation");
        let mut store = OpenCodeBindingStore::default();
        remember_binding(
            &mut store,
            LegacyRememberOpenCodeBindingInput {
                native_session_id: "ses_installation".to_string(),
                project_path: project.to_string_lossy().into_owned(),
                title: "First".to_string(),
                created_at: 10,
                updated_at: 10,
            },
        )
        .unwrap();
        store.bindings[0].runtime.installation_id = "older-installation".to_string();

        let error = remember_binding(
            &mut store,
            LegacyRememberOpenCodeBindingInput {
                native_session_id: "ses_installation".to_string(),
                project_path: project.to_string_lossy().into_owned(),
                title: "Second".to_string(),
                created_at: 10,
                updated_at: 20,
            },
        )
        .unwrap_err();

        assert!(error.contains("installation or connection"));
        assert_eq!(store.bindings[0].title, "First");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn missing_store_is_an_empty_versioned_store() {
        let root = test_directory("missing-store");
        let store = read_store(&root.join("missing.json")).unwrap();
        assert_eq!(store.version, 1);
        assert!(store.bindings.is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
