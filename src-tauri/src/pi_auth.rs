use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Manager, State};

use crate::pi_runtime::{PiRuntime, stop_process};

struct ProviderDefinition {
    id: &'static str,
    name: &'static str,
    environment_variable: &'static str,
}

const PROVIDERS: &[ProviderDefinition] = &[
    ProviderDefinition {
        id: "anthropic",
        name: "Anthropic",
        environment_variable: "ANTHROPIC_API_KEY",
    },
    ProviderDefinition {
        id: "openai",
        name: "OpenAI",
        environment_variable: "OPENAI_API_KEY",
    },
    ProviderDefinition {
        id: "google",
        name: "Google Gemini",
        environment_variable: "GEMINI_API_KEY",
    },
    ProviderDefinition {
        id: "deepseek",
        name: "DeepSeek",
        environment_variable: "DEEPSEEK_API_KEY",
    },
    ProviderDefinition {
        id: "openrouter",
        name: "OpenRouter",
        environment_variable: "OPENROUTER_API_KEY",
    },
    ProviderDefinition {
        id: "mistral",
        name: "Mistral",
        environment_variable: "MISTRAL_API_KEY",
    },
    ProviderDefinition {
        id: "groq",
        name: "Groq",
        environment_variable: "GROQ_API_KEY",
    },
    ProviderDefinition {
        id: "xai",
        name: "xAI",
        environment_variable: "XAI_API_KEY",
    },
    ProviderDefinition {
        id: "nvidia",
        name: "NVIDIA NIM",
        environment_variable: "NVIDIA_API_KEY",
    },
    ProviderDefinition {
        id: "cerebras",
        name: "Cerebras",
        environment_variable: "CEREBRAS_API_KEY",
    },
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthStatus {
    id: String,
    name: String,
    configured: bool,
    source: Option<String>,
    credential_kind: Option<String>,
}

fn provider_definition(provider: &str) -> Result<&'static ProviderDefinition, String> {
    PROVIDERS
        .iter()
        .find(|candidate| candidate.id == provider)
        .ok_or_else(|| format!("Unsupported built-in Provider: {provider}"))
}

fn auth_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .home_dir()
        .map_err(|error| format!("Cannot resolve the user home directory: {error}"))?
        .join(".pi/agent/auth.json"))
}

fn read_auth(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let body = fs::read(path).map_err(|error| format!("Cannot read Pi auth file: {error}"))?;
    let value: Value = serde_json::from_slice(&body)
        .map_err(|error| format!("Pi auth file is invalid JSON; it was not changed: {error}"))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "Pi auth file must contain a JSON object; it was not changed".to_string())
}

fn atomic_write_auth(path: &Path, auth: &Map<String, Value>) -> Result<(), String> {
    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    let parent = path
        .parent()
        .ok_or_else(|| "Pi auth path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create Pi auth directory: {error}"))?;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Cannot secure Pi auth directory: {error}"))?;

    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(".auth.json.tmp-{}-{sequence}", std::process::id()));
    let body = serde_json::to_vec_pretty(auth)
        .map_err(|error| format!("Cannot encode Pi auth file: {error}"))?;
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| format!("Cannot create temporary Pi auth file: {error}"))?;
        file.write_all(&body)
            .map_err(|error| format!("Cannot write Pi auth file: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("Cannot finish Pi auth file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Cannot sync Pi auth file: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Cannot replace Pi auth file: {error}"))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Cannot secure Pi auth file: {error}"))?;
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn credential_kind(value: &Value) -> String {
    value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

fn valid_auth_entry(value: &Value) -> bool {
    match value.get("type").and_then(Value::as_str) {
        Some("api_key") => value
            .get("key")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.trim().is_empty()),
        Some("oauth") => true,
        Some(_) => true,
        None => false,
    }
}

fn auth_statuses(auth: &Map<String, Value>) -> Vec<ProviderAuthStatus> {
    PROVIDERS
        .iter()
        .map(|provider| {
            let stored = auth.get(provider.id);
            let environment_configured = std::env::var_os(provider.environment_variable)
                .is_some_and(|value| !value.is_empty());
            let stored_configured = stored.is_some_and(valid_auth_entry);
            ProviderAuthStatus {
                id: provider.id.to_string(),
                name: provider.name.to_string(),
                configured: stored_configured || environment_configured,
                source: if stored_configured {
                    Some("auth_file".to_string())
                } else if environment_configured {
                    Some("environment".to_string())
                } else {
                    None
                },
                credential_kind: stored.map(credential_kind),
            }
        })
        .collect()
}

fn validate_api_key(api_key: String) -> Result<String, String> {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("API Key cannot be empty".to_string());
    }
    if key.len() > 16_384 || key.chars().any(char::is_control) {
        return Err("API Key contains unsupported characters".to_string());
    }
    Ok(key)
}

#[tauri::command]
pub fn pi_auth_status(app: AppHandle) -> Result<Vec<ProviderAuthStatus>, String> {
    let auth = read_auth(&auth_path(&app)?)?;
    Ok(auth_statuses(&auth))
}

#[tauri::command]
pub fn pi_auth_set_api_key(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
    provider: String,
    api_key: String,
) -> Result<Vec<ProviderAuthStatus>, String> {
    provider_definition(&provider)?;
    let api_key = validate_api_key(api_key)?;
    let path = auth_path(&app)?;
    let mut auth = read_auth(&path)?;
    stop_process(&runtime, Some(&app))?;
    auth.insert(
        provider,
        json!({
            "type": "api_key",
            "key": api_key,
        }),
    );
    atomic_write_auth(&path, &auth)?;
    Ok(auth_statuses(&auth))
}

#[tauri::command]
pub fn pi_auth_remove(
    app: AppHandle,
    runtime: State<'_, PiRuntime>,
    provider: String,
) -> Result<Vec<ProviderAuthStatus>, String> {
    provider_definition(&provider)?;
    let path = auth_path(&app)?;
    let mut auth = read_auth(&path)?;
    if auth.remove(&provider).is_some() {
        stop_process(&runtime, Some(&app))?;
        atomic_write_auth(&path, &auth)?;
    }
    Ok(auth_statuses(&auth))
}

#[cfg(test)]
mod tests {
    use super::{atomic_write_auth, auth_statuses, read_auth, validate_api_key};
    use serde_json::{Map, Value, json};
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

    fn test_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "farfold-auth-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn updating_one_provider_preserves_oauth_and_unknown_entries() {
        let root = test_directory("preserve");
        let path = root.join("agent/auth.json");
        let mut auth = Map::new();
        auth.insert(
            "anthropic".to_string(),
            json!({ "type": "oauth", "access": "secret" }),
        );
        auth.insert("custom-provider".to_string(), json!({ "future": true }));
        auth.insert(
            "openai".to_string(),
            json!({ "type": "api_key", "key": "old" }),
        );
        auth.insert(
            "openai".to_string(),
            json!({ "type": "api_key", "key": "new" }),
        );

        atomic_write_auth(&path, &auth).unwrap();
        let saved = read_auth(&path).unwrap();
        assert_eq!(saved["anthropic"]["type"], "oauth");
        assert_eq!(saved["custom-provider"]["future"], true);
        assert_eq!(saved["openai"]["key"], "new");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_auth_json_is_never_replaced_with_an_empty_object() {
        let root = test_directory("invalid");
        let path = root.join("auth.json");
        fs::write(&path, b"not-json").unwrap();
        assert!(read_auth(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"not-json");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_never_contains_the_stored_key() {
        let auth = serde_json::from_value::<Map<String, Value>>(json!({
            "deepseek": { "type": "api_key", "key": "do-not-return" }
        }))
        .unwrap();
        let encoded = serde_json::to_string(&auth_statuses(&auth)).unwrap();
        assert!(!encoded.contains("do-not-return"));
        assert!(encoded.contains("deepseek"));
    }

    #[test]
    fn api_key_validation_rejects_empty_and_control_characters() {
        assert!(validate_api_key("  ".to_string()).is_err());
        assert!(validate_api_key("abc\n123".to_string()).is_err());
        assert_eq!(
            validate_api_key("  sk-test  ".to_string()).unwrap(),
            "sk-test"
        );
    }
}
