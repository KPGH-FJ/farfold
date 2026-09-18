use crate::host_ids::{ProviderConfigVersionId, ProviderConnectionId, derived_host_id};
use crate::host_store::{
    HostStore,
    provider_projection::{
        ProviderConnectionSource, ProviderConnectionUpsertInput, ProviderConnectionVersionRecord,
        ProviderProjectionSnapshot,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};
use tauri::Manager;

static MANAGED_PROVIDER_SAVE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedProviderSelection {
    pub(crate) provider_connection_id: ProviderConnectionId,
    pub(crate) provider_config_version_id: ProviderConfigVersionId,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedProviderApiKeySaveInput {
    pub(crate) provider_key: String,
    pub(crate) label: String,
    pub(crate) account_label: String,
    pub(crate) endpoint: String,
    pub(crate) api_kind: String,
    pub(crate) api_key: String,
    pub(crate) model_id: String,
    pub(crate) context_window: Option<u64>,
    pub(crate) max_tokens: Option<u64>,
    pub(crate) reasoning: Option<bool>,
    pub(crate) image_input: Option<bool>,
    pub(crate) supports_developer_role: Option<bool>,
    pub(crate) supports_reasoning_effort: Option<bool>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedProviderCompatibilityCorrectionInput {
    provider_connection_id: ProviderConnectionId,
    provider_config_version_id: ProviderConfigVersionId,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProviderApiKeySaveResult {
    pub(crate) provider_connection_id: ProviderConnectionId,
    pub(crate) current_config_version_id: ProviderConfigVersionId,
    pub(crate) provider_key: String,
    pub(crate) label: String,
    pub(crate) account_label: String,
    pub(crate) endpoint_fingerprint: String,
    pub(crate) credential_revision_fingerprint: String,
    pub(crate) model_mapping_fingerprint: String,
    pub(crate) projection_snapshot: ProviderProjectionSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProviderConnectionSummary {
    pub(crate) provider_connection_id: ProviderConnectionId,
    pub(crate) current_config_version_id: Option<ProviderConfigVersionId>,
    pub(crate) provider_key: String,
    pub(crate) label: String,
    pub(crate) account_label: String,
    pub(crate) endpoint: String,
    pub(crate) api_kind: String,
    pub(crate) model_id: String,
    pub(crate) context_window: u64,
    pub(crate) max_tokens: u64,
    pub(crate) reasoning: bool,
    pub(crate) image_input: bool,
    pub(crate) supports_developer_role: bool,
    pub(crate) supports_reasoning_effort: bool,
    pub(crate) credential_revision_fingerprint: String,
    pub(crate) updated_at: u64,
}

fn managed_model_limit(value: Option<u64>, fallback: u64, field: &str) -> Result<u64, String> {
    let limit = value.unwrap_or(fallback);
    if (1..=2_000_000).contains(&limit) {
        Ok(limit)
    } else {
        Err(format!("{field} is outside the supported range"))
    }
}

fn validate_public_text(field: &str, value: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} cannot be empty"));
    }
    if value.len() > max {
        return Err(format!("{field} is too long"));
    }
    if value.contains('\0') {
        return Err(format!("{field} contains a null byte"));
    }
    Ok(())
}

fn safe_fingerprint_segment(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars().take(160) {
        if character.is_ascii_alphanumeric()
            || matches!(character, '-' | '_' | '.' | ':' | '@' | '+')
        {
            output.push(character);
        } else {
            output.push('_');
        }
    }
    if output.is_empty() {
        "default".to_string()
    } else {
        output
    }
}

fn credential_revision() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        let fallback = format!(
            "{}:{}:{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("unnamed"),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        );
        let mut hasher = Sha256::new();
        hasher.update(fallback.as_bytes());
        let digest = hasher.finalize();
        bytes.copy_from_slice(&digest[..16]);
    }
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("managed-credential:{hex}")
}

fn normalize_endpoint(endpoint: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(endpoint)
        .map_err(|_| "Provider endpoint must be a valid URL".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("Provider endpoint must use http or https".to_string()),
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    url.set_query(None);
    let normalized = url.as_str().trim_end_matches('/').to_string();
    validate_public_text("Provider endpoint", &normalized, 300)?;
    Ok(normalized)
}

fn is_ordinary_zhipu_chat_completions(endpoint: &str, api_kind: &str) -> bool {
    if api_kind != "openai-chat-completions" {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("open.bigmodel.cn")
        && url.port().is_none()
        && url.path().trim_end_matches('/') == "/api/paas/v4"
        && url.query().is_none()
        && url.fragment().is_none()
}

fn connection_id(input: &ManagedProviderApiKeySaveInput) -> Result<ProviderConnectionId, String> {
    let endpoint = normalize_endpoint(&input.endpoint)?;
    ProviderConnectionId::parse(derived_host_id(
        "managed-provider",
        &[&input.provider_key, &endpoint, &input.account_label],
    ))
    .map_err(|error| format!("Cannot derive Provider connection id: {error}"))
}

fn managed_provider_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("managed-providers")
}

fn credential_path(app_data_dir: &Path, connection_id: &ProviderConnectionId) -> PathBuf {
    managed_provider_root(app_data_dir).join(format!("{}.json", connection_id.as_str()))
}

fn revision_file_name(connection_id: &ProviderConnectionId, revision: &str) -> String {
    format!(
        "{}.{}.secret.json",
        connection_id.as_str(),
        revision.replace(':', "-")
    )
}

fn credential_revision_path(
    app_data_dir: &Path,
    connection_id: &ProviderConnectionId,
    revision: &str,
) -> PathBuf {
    managed_provider_root(app_data_dir).join(revision_file_name(connection_id, revision))
}

fn summary_from_value(
    value: &serde_json::Value,
    updated_at: u64,
) -> Result<ManagedProviderConnectionSummary, String> {
    let string = |key: &str| -> Result<String, String> {
        value
            .get(key)
            .and_then(|entry| entry.as_str())
            .map(ToString::to_string)
            .ok_or_else(|| format!("Provider secret metadata is missing {key}"))
    };
    Ok(ManagedProviderConnectionSummary {
        provider_connection_id: ProviderConnectionId::parse(string("providerConnectionId")?)
            .map_err(|error| format!("Invalid Provider connection id: {error}"))?,
        current_config_version_id: None,
        provider_key: string("providerKey")?,
        label: string("label")?,
        account_label: string("accountLabel")?,
        endpoint: string("endpoint")?,
        api_kind: string("apiKind")?,
        model_id: string("modelId")?,
        context_window: managed_model_limit(
            value
                .get("contextWindow")
                .and_then(serde_json::Value::as_u64),
            128_000,
            "Provider context window",
        )?,
        max_tokens: managed_model_limit(
            value.get("maxTokens").and_then(serde_json::Value::as_u64),
            8_192,
            "Provider max tokens",
        )?,
        reasoning: value
            .get("reasoning")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        image_input: value
            .get("imageInput")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        supports_developer_role: value
            .get("supportsDeveloperRole")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        supports_reasoning_effort: value
            .get("supportsReasoningEffort")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        credential_revision_fingerprint: string("credentialRevisionFingerprint")?,
        updated_at,
    })
}

#[cfg(test)]
fn read_summary(path: &Path) -> Result<ManagedProviderConnectionSummary, String> {
    let value: serde_json::Value = serde_json::from_slice(
        &fs::read(path)
            .map_err(|error| format!("Cannot read Provider secret metadata: {error}"))?,
    )
    .map_err(|error| format!("Cannot parse Provider secret metadata: {error}"))?;
    let updated_at = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0);
    summary_from_value(&value, updated_at)
}

fn read_secret_revision(
    app_data_dir: &Path,
    provider_connection_id: &ProviderConnectionId,
    credential_revision_fingerprint: &str,
) -> Result<serde_json::Value, String> {
    let path = credential_revision_path(
        app_data_dir,
        provider_connection_id,
        credential_revision_fingerprint,
    );
    let value: serde_json::Value = serde_json::from_slice(
        &fs::read(path)
            .map_err(|error| format!("Cannot read Provider secret revision: {error}"))?,
    )
    .map_err(|error| format!("Cannot parse Provider secret revision: {error}"))?;
    if value
        .get("credentialRevisionFingerprint")
        .and_then(|entry| entry.as_str())
        != Some(credential_revision_fingerprint)
    {
        return Err("Provider secret revision does not match Host version".to_string());
    }
    Ok(value)
}

pub(crate) fn read_secret_for_version(
    app_data_dir: &Path,
    store: &HostStore,
    provider_connection_id: &ProviderConnectionId,
    config_version_id: &ProviderConfigVersionId,
) -> Result<(serde_json::Value, ProviderConnectionVersionRecord), String> {
    let version = store.provider_connection_version(provider_connection_id, config_version_id)?;
    let secret = read_secret_revision(
        app_data_dir,
        provider_connection_id,
        &version.credential_revision_fingerprint,
    )?;
    Ok((secret, version))
}

fn summary_for_version(
    app_data_dir: &Path,
    provider_connection_id: &ProviderConnectionId,
    version: &ProviderConnectionVersionRecord,
) -> Result<ManagedProviderConnectionSummary, String> {
    let path = credential_revision_path(
        app_data_dir,
        provider_connection_id,
        &version.credential_revision_fingerprint,
    );
    let value: serde_json::Value = serde_json::from_slice(
        &fs::read(&path)
            .map_err(|error| format!("Cannot read Provider committed secret metadata: {error}"))?,
    )
    .map_err(|error| format!("Cannot parse Provider committed secret metadata: {error}"))?;
    let updated_at = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0);
    let mut summary = summary_from_value(&value, updated_at)?;
    summary.current_config_version_id = Some(version.config_version_id.clone());
    Ok(summary)
}

#[derive(Clone)]
struct PrivateKeyWrite {
    provider_connection_id: ProviderConnectionId,
    credential_revision_fingerprint: String,
    endpoint_fingerprint: String,
    model_mapping_fingerprint: String,
    path: PathBuf,
    current_path: PathBuf,
    pointer_payload: serde_json::Value,
}

fn write_private_api_key(
    app_data_dir: &Path,
    input: &ManagedProviderApiKeySaveInput,
) -> Result<PrivateKeyWrite, String> {
    validate_public_text("Provider key", &input.provider_key, 120)?;
    validate_public_text("Provider label", &input.label, 200)?;
    validate_public_text("Provider account label", &input.account_label, 120)?;
    let endpoint = normalize_endpoint(&input.endpoint)?;
    validate_public_text("Provider API kind", &input.api_kind, 80)?;
    validate_public_text("Provider model id", &input.model_id, 200)?;
    validate_public_text("Provider API key", &input.api_key, 16 * 1024)?;
    let context_window = managed_model_limit(
        Some(
            input
                .context_window
                .ok_or("Provider context window must be explicitly configured")?,
        ),
        128_000,
        "Provider context window",
    )?;
    let max_tokens = managed_model_limit(
        Some(
            input
                .max_tokens
                .ok_or("Provider max tokens must be explicitly configured")?,
        ),
        8_192,
        "Provider max tokens",
    )?;
    let reasoning = input
        .reasoning
        .ok_or("Provider reasoning capability must be explicitly configured")?;
    let image_input = input
        .image_input
        .ok_or("Provider image capability must be explicitly configured")?;
    let requested_supports_developer_role = input
        .supports_developer_role
        .ok_or("Provider developer-role capability must be explicitly configured")?;
    let supports_developer_role = requested_supports_developer_role
        && !is_ordinary_zhipu_chat_completions(&endpoint, &input.api_kind);
    let supports_reasoning_effort = input
        .supports_reasoning_effort
        .ok_or("Provider reasoning-effort capability must be explicitly configured")?;
    if !matches!(
        input.api_kind.as_str(),
        "openai-responses" | "openai-chat-completions"
    ) {
        return Err(
            "Only OpenAI-compatible Responses or Chat Completions API is supported in this slice"
                .to_string(),
        );
    }
    let root = managed_provider_root(app_data_dir);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Cannot create Provider secret directory: {error}"))?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Cannot protect Provider secret directory: {error}"))?;
    let revision = credential_revision();
    let provider_connection_id = connection_id(input)?;
    let endpoint_fingerprint = format!(
        "managed:{}:{}:{}",
        safe_fingerprint_segment(&input.api_kind),
        safe_fingerprint_segment(&input.provider_key),
        safe_fingerprint_segment(&endpoint),
    );
    let model_mapping_fingerprint = format!(
        "model:{}:{}:{}:{}",
        safe_fingerprint_segment(&input.api_kind),
        safe_fingerprint_segment(&input.model_id),
        context_window,
        max_tokens,
    );
    let pointer_payload = serde_json::json!({
        "providerConnectionId": provider_connection_id.as_str(),
        "providerKey": input.provider_key,
        "label": input.label,
        "accountLabel": input.account_label,
        "endpoint": endpoint,
        "apiKind": input.api_kind,
        "modelId": input.model_id,
        "contextWindow": context_window,
        "maxTokens": max_tokens,
        "reasoning": reasoning,
        "imageInput": image_input,
        "supportsDeveloperRole": supports_developer_role,
        "supportsReasoningEffort": supports_reasoning_effort,
        "credentialRevisionFingerprint": revision,
    });
    let secret_payload = serde_json::json!({
        "providerConnectionId": provider_connection_id.as_str(),
        "providerKey": input.provider_key,
        "label": input.label,
        "accountLabel": input.account_label,
        "endpoint": endpoint,
        "apiKind": input.api_kind,
        "modelId": input.model_id,
        "contextWindow": context_window,
        "maxTokens": max_tokens,
        "reasoning": reasoning,
        "imageInput": image_input,
        "supportsDeveloperRole": supports_developer_role,
        "supportsReasoningEffort": supports_reasoning_effort,
        "credentialRevisionFingerprint": revision,
        "apiKey": input.api_key,
    });
    let path = credential_revision_path(app_data_dir, &provider_connection_id, &revision);
    let temporary = path.with_extension(format!("json.tmp.{}", revision.replace(':', "-")));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| format!("Cannot create Provider secret file: {error}"))?;
    let write_result = file.write_all(
        serde_json::to_string_pretty(&secret_payload)
            .map_err(|error| format!("Cannot encode Provider secret file: {error}"))?
            .as_bytes(),
    );
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot write Provider secret file: {error}"));
    }
    if let Err(error) = file.write_all(b"\n") {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot finish Provider secret file: {error}"));
    }
    if let Err(error) = file.sync_all() {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot sync Provider secret file: {error}"));
    }
    drop(file);
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot publish Provider secret file: {error}"));
    }
    if let Err(error) = fs::set_permissions(&path, fs::Permissions::from_mode(0o600)) {
        let _ = fs::remove_file(&path);
        return Err(format!("Cannot protect Provider secret file: {error}"));
    }
    Ok(PrivateKeyWrite {
        provider_connection_id: provider_connection_id.clone(),
        credential_revision_fingerprint: revision,
        endpoint_fingerprint,
        model_mapping_fingerprint,
        path,
        current_path: credential_path(app_data_dir, &provider_connection_id),
        pointer_payload,
    })
}

fn publish_current_pointer(written: &PrivateKeyWrite) -> Result<(), String> {
    let temporary = written.current_path.with_extension(format!(
        "json.current.tmp.{}",
        written.credential_revision_fingerprint.replace(':', "-")
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| format!("Cannot create Provider pointer file: {error}"))?;
    if let Err(error) = file.write_all(
        serde_json::to_string_pretty(&written.pointer_payload)
            .map_err(|error| format!("Cannot encode Provider pointer file: {error}"))?
            .as_bytes(),
    ) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot write Provider pointer file: {error}"));
    }
    if let Err(error) = file.write_all(b"\n") {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot finish Provider pointer file: {error}"));
    }
    if let Err(error) = file.sync_all() {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot sync Provider pointer file: {error}"));
    }
    drop(file);
    if let Err(error) = fs::rename(&temporary, &written.current_path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot publish Provider pointer file: {error}"));
    }
    fs::set_permissions(&written.current_path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Cannot protect Provider pointer file: {error}"))
}

fn current_pointer_revision(path: &Path) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(&fs::read(path).ok()?)
        .ok()?
        .get("credentialRevisionFingerprint")?
        .as_str()
        .map(ToString::to_string)
}

fn restore_previous_pointer_if_owned(
    current_path: &Path,
    owned_revision: &str,
    previous: Option<Vec<u8>>,
) {
    if current_pointer_revision(current_path).as_deref() != Some(owned_revision) {
        return;
    }
    match previous {
        Some(bytes) => {
            let temporary = current_path.with_extension(format!(
                "json.rollback.tmp.{}",
                owned_revision.replace(':', "-")
            ));
            if OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)
                .and_then(|mut file| {
                    file.write_all(&bytes)?;
                    file.sync_all()
                })
                .is_ok()
            {
                let _ = fs::rename(&temporary, current_path);
                let _ = fs::set_permissions(current_path, fs::Permissions::from_mode(0o600));
            } else {
                let _ = fs::remove_file(&temporary);
            }
        }
        None => {
            let _ = fs::remove_file(current_path);
        }
    }
}

fn save_api_key_in_dir_locked(
    app_data_dir: &Path,
    store: Option<&HostStore>,
    input: ManagedProviderApiKeySaveInput,
) -> Result<ManagedProviderApiKeySaveResult, String> {
    let written = write_private_api_key(app_data_dir, &input)?;
    let previous_pointer = fs::read(&written.current_path).ok();
    if let Err(error) = publish_current_pointer(&written) {
        let _ = fs::remove_file(&written.path);
        return Err(error);
    }
    let projection_snapshot = if let Some(store) = store {
        match store.upsert_provider_connection(&ProviderConnectionUpsertInput {
            provider_connection_id: written.provider_connection_id.clone(),
            provider_key: input.provider_key.clone(),
            label: input.label.clone(),
            source: ProviderConnectionSource::FarfoldManaged,
            endpoint_fingerprint: written.endpoint_fingerprint.clone(),
            credential_revision_fingerprint: written.credential_revision_fingerprint.clone(),
            model_mapping_fingerprint: written.model_mapping_fingerprint.clone(),
        }) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                restore_previous_pointer_if_owned(
                    &written.current_path,
                    &written.credential_revision_fingerprint,
                    previous_pointer,
                );
                let _ = fs::remove_file(&written.path);
                return Err(error);
            }
        }
    } else {
        ProviderProjectionSnapshot {
            connection: crate::host_store::provider_projection::ProviderConnectionRecord {
                provider_connection_id: written.provider_connection_id.clone(),
                provider_key: input.provider_key.clone(),
                label: input.label.clone(),
                source: ProviderConnectionSource::FarfoldManaged,
                current_config_version_id: ProviderConfigVersionId::parse(derived_host_id(
                    "test-provider-version",
                    &[
                        written.provider_connection_id.as_str(),
                        &written.credential_revision_fingerprint,
                    ],
                ))
                .map_err(|error| error.to_string())?,
                created_at: 0,
                updated_at: 0,
            },
            projections: Vec::new(),
        }
    };
    Ok(ManagedProviderApiKeySaveResult {
        endpoint_fingerprint: written.endpoint_fingerprint,
        model_mapping_fingerprint: written.model_mapping_fingerprint,
        provider_connection_id: written.provider_connection_id,
        current_config_version_id: projection_snapshot
            .connection
            .current_config_version_id
            .clone(),
        provider_key: input.provider_key,
        label: input.label,
        account_label: input.account_label,
        credential_revision_fingerprint: written.credential_revision_fingerprint,
        projection_snapshot,
    })
}

pub fn save_api_key_in_dir(
    app_data_dir: &Path,
    store: Option<&HostStore>,
    input: ManagedProviderApiKeySaveInput,
) -> Result<ManagedProviderApiKeySaveResult, String> {
    let _save_guard = MANAGED_PROVIDER_SAVE_LOCK
        .lock()
        .map_err(|_| "Managed Provider save lock is unavailable".to_string())?;
    save_api_key_in_dir_locked(app_data_dir, store, input)
}

fn correction_string(secret: &serde_json::Value, key: &str) -> Result<String, String> {
    secret
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Provider secret is missing {key}"))
}

fn correction_bool(secret: &serde_json::Value, key: &str) -> Result<bool, String> {
    secret
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| format!("Provider secret is missing {key}"))
}

pub fn correct_ordinary_zhipu_developer_role_in_dir(
    app_data_dir: &Path,
    store: &HostStore,
    input: ManagedProviderCompatibilityCorrectionInput,
) -> Result<ManagedProviderApiKeySaveResult, String> {
    let _save_guard = MANAGED_PROVIDER_SAVE_LOCK
        .lock()
        .map_err(|_| "Managed Provider save lock is unavailable".to_string())?;
    let snapshot = store.provider_projection_snapshot(&input.provider_connection_id)?;
    if snapshot.connection.current_config_version_id != input.provider_config_version_id {
        return Err("Managed Provider changed before compatibility correction".to_string());
    }
    let (secret, _) = read_secret_for_version(
        app_data_dir,
        store,
        &input.provider_connection_id,
        &input.provider_config_version_id,
    )?;
    let endpoint = correction_string(&secret, "endpoint")?;
    let api_kind = correction_string(&secret, "apiKind")?;
    if !is_ordinary_zhipu_chat_completions(&endpoint, &api_kind) {
        return Err(
            "Compatibility correction only applies to the ordinary Zhipu Chat Completions endpoint"
                .to_string(),
        );
    }
    if !correction_bool(&secret, "supportsDeveloperRole")? {
        return Err("Ordinary Zhipu connection already uses system role".to_string());
    }
    let corrected = ManagedProviderApiKeySaveInput {
        provider_key: correction_string(&secret, "providerKey")?,
        label: correction_string(&secret, "label")?,
        account_label: correction_string(&secret, "accountLabel")?,
        endpoint,
        api_kind,
        api_key: correction_string(&secret, "apiKey")?,
        model_id: correction_string(&secret, "modelId")?,
        context_window: secret
            .get("contextWindow")
            .and_then(serde_json::Value::as_u64),
        max_tokens: secret.get("maxTokens").and_then(serde_json::Value::as_u64),
        reasoning: Some(correction_bool(&secret, "reasoning")?),
        image_input: Some(correction_bool(&secret, "imageInput")?),
        supports_developer_role: Some(false),
        supports_reasoning_effort: Some(correction_bool(&secret, "supportsReasoningEffort")?),
    };
    let result = save_api_key_in_dir_locked(app_data_dir, Some(store), corrected)?;
    if result.provider_connection_id != input.provider_connection_id
        || result.current_config_version_id == input.provider_config_version_id
    {
        return Err(
            "Compatibility correction did not create the expected immutable version".into(),
        );
    }
    Ok(result)
}

#[cfg(test)]
pub fn list_api_keys_in_dir(
    app_data_dir: &Path,
) -> Result<Vec<ManagedProviderConnectionSummary>, String> {
    let root = managed_provider_root(app_data_dir);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot list Provider secrets: {error}")),
    };
    let mut summaries = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Cannot inspect Provider secret: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.ends_with(".secret.json"))
        {
            continue;
        }
        summaries.push(read_summary(&path)?);
    }
    summaries.sort_by_key(|summary| std::cmp::Reverse(summary.updated_at));
    Ok(summaries)
}

pub fn list_committed_api_keys_in_dir(
    app_data_dir: &Path,
    store: &HostStore,
) -> Result<Vec<ManagedProviderConnectionSummary>, String> {
    let mut committed = Vec::new();
    for connection in
        store.provider_connections_by_source(ProviderConnectionSource::FarfoldManaged)?
    {
        let version = store.provider_connection_version(
            &connection.provider_connection_id,
            &connection.current_config_version_id,
        )?;
        committed.push(summary_for_version(
            app_data_dir,
            &connection.provider_connection_id,
            &version,
        )?);
    }
    committed.sort_by_key(|summary| std::cmp::Reverse(summary.updated_at));
    Ok(committed)
}

#[tauri::command]
pub fn managed_provider_api_key_save(
    app: tauri::AppHandle,
    store: tauri::State<'_, HostStore>,
    input: ManagedProviderApiKeySaveInput,
) -> Result<ManagedProviderApiKeySaveResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate app data directory")?;
    save_api_key_in_dir(&app_data_dir, Some(&store), input)
}

#[tauri::command]
pub fn managed_provider_connection_list(
    app: tauri::AppHandle,
    store: tauri::State<'_, HostStore>,
) -> Result<Vec<ManagedProviderConnectionSummary>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate app data directory")?;
    list_committed_api_keys_in_dir(&app_data_dir, &store)
}

#[tauri::command]
pub fn managed_provider_correct_ordinary_zhipu_developer_role(
    app: tauri::AppHandle,
    store: tauri::State<'_, HostStore>,
    input: ManagedProviderCompatibilityCorrectionInput,
) -> Result<ManagedProviderApiKeySaveResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot locate app data directory")?;
    correct_ordinary_zhipu_developer_role_in_dir(&app_data_dir, &store, input)
}

#[cfg(test)]
mod tests {
    use super::{
        ManagedProviderApiKeySaveInput, ManagedProviderCompatibilityCorrectionInput,
        correct_ordinary_zhipu_developer_role_in_dir, list_api_keys_in_dir, save_api_key_in_dir,
    };
    use crate::host_store::HostStore;
    use std::os::unix::fs::PermissionsExt;

    fn read_current_secret(
        directory: &std::path::Path,
        provider_connection_id: &crate::host_ids::ProviderConnectionId,
    ) -> serde_json::Value {
        let pointer: serde_json::Value = serde_json::from_slice(
            &std::fs::read(super::credential_path(directory, provider_connection_id)).unwrap(),
        )
        .unwrap();
        let revision = pointer["credentialRevisionFingerprint"].as_str().unwrap();
        super::read_secret_revision(directory, provider_connection_id, revision).unwrap()
    }

    #[test]
    fn ordinary_zhipu_chat_completions_persists_system_role_compatibility() {
        let directory = tempfile::tempdir().unwrap();
        let result = save_api_key_in_dir(
            directory.path(),
            None,
            ManagedProviderApiKeySaveInput {
                provider_key: "zai".to_string(),
                label: "Zhipu BigModel".to_string(),
                account_label: "default".to_string(),
                endpoint: "https://open.bigmodel.cn/api/paas/v4/".to_string(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "fixture-secret".to_string(),
                model_id: "glm-4.6v".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(true),
                image_input: Some(true),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let secret = read_current_secret(directory.path(), &result.provider_connection_id);
        assert_eq!(secret["endpoint"], "https://open.bigmodel.cn/api/paas/v4");
        assert_eq!(secret["supportsDeveloperRole"], false);
        assert_eq!(secret["reasoning"], true);
        assert_eq!(secret["modelId"], "glm-4.6v");
    }

    #[test]
    fn ordinary_zhipu_correction_versions_existing_secret_without_overwriting_history() {
        let directory = tempfile::tempdir().unwrap();
        let store = HostStore::open(directory.path().join("host.sqlite3"));
        let first = save_api_key_in_dir(
            directory.path(),
            Some(&store),
            ManagedProviderApiKeySaveInput {
                provider_key: "zai".to_string(),
                label: "Zhipu BigModel".to_string(),
                account_label: "default".to_string(),
                endpoint: "https://open.bigmodel.cn/api/paas/v4".to_string(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "retained-fixture-secret".to_string(),
                model_id: "glm-4.6v".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(true),
                image_input: Some(true),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let first_version = store
            .provider_connection_version(
                &first.provider_connection_id,
                &first.current_config_version_id,
            )
            .unwrap();
        let old_path = super::credential_revision_path(
            directory.path(),
            &first.provider_connection_id,
            &first_version.credential_revision_fingerprint,
        );
        let current_path = super::credential_path(directory.path(), &first.provider_connection_id);
        for path in [&old_path, &current_path] {
            let mut value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            value["supportsDeveloperRole"] = serde_json::json!(true);
            std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        }

        let corrected = correct_ordinary_zhipu_developer_role_in_dir(
            directory.path(),
            &store,
            ManagedProviderCompatibilityCorrectionInput {
                provider_connection_id: first.provider_connection_id.clone(),
                provider_config_version_id: first.current_config_version_id.clone(),
            },
        )
        .unwrap();
        assert_ne!(
            corrected.current_config_version_id,
            first.current_config_version_id
        );
        let old_secret: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&old_path).unwrap()).unwrap();
        let new_secret = read_current_secret(directory.path(), &first.provider_connection_id);
        assert_eq!(old_secret["supportsDeveloperRole"], true);
        assert_eq!(new_secret["supportsDeveloperRole"], false);
        for key in [
            "providerConnectionId",
            "providerKey",
            "label",
            "accountLabel",
            "endpoint",
            "apiKind",
            "apiKey",
            "modelId",
            "contextWindow",
            "maxTokens",
            "reasoning",
            "imageInput",
            "supportsReasoningEffort",
        ] {
            assert_eq!(new_secret[key], old_secret[key], "changed {key}");
        }
        let versions = store
            .provider_connection_versions(&first.provider_connection_id)
            .unwrap();
        assert_eq!(versions.len(), 2);
        assert!(
            versions
                .iter()
                .any(|version| version.config_version_id == first.current_config_version_id)
        );
        assert!(
            versions
                .iter()
                .any(|version| version.config_version_id == corrected.current_config_version_id)
        );
    }

    #[test]
    fn api_key_is_private_and_only_revision_enters_the_public_result() {
        let directory = tempfile::tempdir().unwrap();
        let result = save_api_key_in_dir(
            directory.path(),
            None,
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Work".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://api.openai.com/v1".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-fixture-secret".to_string(),
                model_id: "gpt-test".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let public = serde_json::to_string(&result).unwrap();
        assert!(!public.contains("sk-fixture-secret"));
        assert!(
            result
                .credential_revision_fingerprint
                .starts_with("managed-credential:")
        );
        let secret_path = directory.path().join(format!(
            "managed-providers/{}.json",
            result.provider_connection_id.as_str()
        ));
        let revision_path = super::credential_revision_path(
            directory.path(),
            &result.provider_connection_id,
            &result.credential_revision_fingerprint,
        );
        assert_eq!(
            std::fs::metadata(&revision_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(
            !std::fs::read_to_string(&secret_path)
                .unwrap()
                .contains("sk-fixture-secret")
        );
        assert!(
            std::fs::read_to_string(revision_path)
                .unwrap()
                .contains("sk-fixture-secret")
        );
    }

    #[test]
    fn host_connection_id_uses_full_identity_not_sanitized_filename_segments() {
        fn input(account_label: &str, endpoint: &str) -> ManagedProviderApiKeySaveInput {
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI".to_string(),
                account_label: account_label.to_string(),
                endpoint: endpoint.to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-fixture-secret".to_string(),
                model_id: "gpt-test".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            }
        }
        assert_ne!(
            super::connection_id(&input("账号/一", "https://api.example.test/v1")).unwrap(),
            super::connection_id(&input("账号_一", "https://api.example.test/v1")).unwrap()
        );
        assert_ne!(
            super::connection_id(&input(
                "work",
                &format!("https://api.example.test/{}/a", "x".repeat(180))
            ))
            .unwrap(),
            super::connection_id(&input(
                "work",
                &format!("https://api.example.test/{}/b", "x".repeat(180))
            ))
            .unwrap()
        );
        assert_ne!(
            super::connection_id(&input("a/b", "https://api.example.test/v1")).unwrap(),
            super::connection_id(&input("a_b", "https://api.example.test/v1")).unwrap()
        );
    }

    #[test]
    fn list_returns_non_secret_connection_metadata_only() {
        let directory = tempfile::tempdir().unwrap();
        let saved = save_api_key_in_dir(
            directory.path(),
            None,
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Work".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://api.openai.com/v1".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-hidden".to_string(),
                model_id: "gpt-test".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let summaries = list_api_keys_in_dir(directory.path()).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].provider_connection_id,
            saved.provider_connection_id
        );
        let public = serde_json::to_string(&summaries).unwrap();
        assert!(!public.contains("sk-hidden"));
    }

    #[test]
    fn host_normalizes_endpoint_before_identity_and_public_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let result = save_api_key_in_dir(
            directory.path(),
            None,
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Proxy".to_string(),
                account_label: "proxy".to_string(),
                endpoint: "https://user:pass@proxy.example.test/v1/?token=secret#frag".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-hidden".to_string(),
                model_id: "gpt-test".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let summaries = list_api_keys_in_dir(directory.path()).unwrap();
        assert_eq!(summaries[0].endpoint, "https://proxy.example.test/v1");
        let public = serde_json::to_string(&result).unwrap();
        assert!(!public.contains("user"));
        assert!(!public.contains("pass"));
        assert!(!public.contains("token"));
        assert!(!public.contains("secret"));
    }

    #[test]
    fn host_store_receives_managed_connection_version_on_save() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("host.sqlite3");
        let store = HostStore::open(database);
        let result = save_api_key_in_dir(
            directory.path(),
            Some(&store),
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Work".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://api.openai.com/v1".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-hidden".to_string(),
                model_id: "gpt-test".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        assert_eq!(
            result.current_config_version_id,
            result
                .projection_snapshot
                .connection
                .current_config_version_id
        );
        assert_eq!(
            store
                .provider_projection_snapshot(&result.provider_connection_id)
                .unwrap()
                .connection
                .current_config_version_id,
            result.current_config_version_id
        );
    }

    #[test]
    fn failed_update_preserves_previous_current_secret() {
        let directory = tempfile::tempdir().unwrap();
        let store = HostStore::open(directory.path().join("host.sqlite3"));
        let first = save_api_key_in_dir(
            directory.path(),
            Some(&store),
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Work".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://api.openai.com/v1".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-first".to_string(),
                model_id: "gpt-test".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let previous = read_current_secret(directory.path(), &first.provider_connection_id);
        assert_eq!(previous["apiKey"], "sk-first");
        let current = super::credential_path(directory.path(), &first.provider_connection_id);
        let pointer_before = std::fs::read_to_string(&current).unwrap();
        assert!(pointer_before.contains(&first.credential_revision_fingerprint));
        let blocked_database = directory.path().join("blocked-host.sqlite3");
        std::fs::create_dir(&blocked_database).unwrap();
        let broken_store = HostStore::open(&blocked_database);
        let failed = save_api_key_in_dir(
            directory.path(),
            Some(&broken_store),
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Work".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://api.openai.com/v1".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-second".to_string(),
                model_id: "gpt-test".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        );
        assert!(failed.is_err());
        let pointer_after = std::fs::read_to_string(&current).unwrap();
        assert_eq!(pointer_before, pointer_after);
        let current_secret = read_current_secret(directory.path(), &first.provider_connection_id);
        assert_eq!(current_secret["apiKey"], "sk-first");
    }

    #[test]
    fn orphan_revision_file_is_not_listed_without_current_pointer() {
        let directory = tempfile::tempdir().unwrap();
        let input = ManagedProviderApiKeySaveInput {
            provider_key: "openai".to_string(),
            label: "OpenAI Work".to_string(),
            account_label: "work".to_string(),
            endpoint: "https://api.openai.com/v1".to_string(),
            api_kind: "openai-responses".to_string(),
            api_key: "sk-first".to_string(),
            model_id: "gpt-test".to_string(),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            reasoning: Some(false),
            image_input: Some(false),
            supports_developer_role: Some(true),
            supports_reasoning_effort: Some(false),
        };
        let written = super::write_private_api_key(directory.path(), &input).unwrap();
        assert!(written.path.exists());
        assert!(list_api_keys_in_dir(directory.path()).unwrap().is_empty());
    }

    #[test]
    fn committed_list_and_secret_ignore_uncommitted_pointer_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("host.sqlite3");
        let store = HostStore::open(&database);
        let first = save_api_key_in_dir(
            directory.path(),
            Some(&store),
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Work".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://api.openai.com/v1".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-first".to_string(),
                model_id: "gpt-first".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let uncommitted = super::write_private_api_key(
            directory.path(),
            &ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Work".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://api.openai.com/v1".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-second".to_string(),
                model_id: "gpt-second".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        super::publish_current_pointer(&uncommitted).unwrap();
        let reopened = HostStore::open(&database);
        let summaries = super::list_committed_api_keys_in_dir(directory.path(), &reopened).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].model_id, "gpt-first");
        assert_eq!(
            summaries[0].current_config_version_id,
            Some(first.current_config_version_id.clone())
        );
        let (secret, _) = super::read_secret_for_version(
            directory.path(),
            &reopened,
            &first.provider_connection_id,
            &first.current_config_version_id,
        )
        .unwrap();
        assert_eq!(secret["apiKey"], "sk-first");
        assert_ne!(secret["apiKey"], "sk-second");
    }

    #[test]
    fn committed_list_survives_missing_current_pointer() {
        let directory = tempfile::tempdir().unwrap();
        let store = HostStore::open(directory.path().join("host.sqlite3"));
        let saved = save_api_key_in_dir(
            directory.path(),
            Some(&store),
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Work".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://api.openai.com/v1".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-first".to_string(),
                model_id: "gpt-first".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        std::fs::remove_file(super::credential_path(
            directory.path(),
            &saved.provider_connection_id,
        ))
        .unwrap();

        assert!(list_api_keys_in_dir(directory.path()).unwrap().is_empty());
        let summaries = super::list_committed_api_keys_in_dir(directory.path(), &store).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].provider_connection_id,
            saved.provider_connection_id
        );
        assert_eq!(summaries[0].model_id, "gpt-first");
        assert_eq!(
            summaries[0].current_config_version_id,
            Some(saved.current_config_version_id)
        );
    }

    #[test]
    fn committed_list_survives_corrupt_current_pointer() {
        let directory = tempfile::tempdir().unwrap();
        let store = HostStore::open(directory.path().join("host.sqlite3"));
        let saved = save_api_key_in_dir(
            directory.path(),
            Some(&store),
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Work".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://api.openai.com/v1".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-first".to_string(),
                model_id: "gpt-first".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        std::fs::write(
            super::credential_path(directory.path(), &saved.provider_connection_id),
            b"{not-json",
        )
        .unwrap();

        assert!(list_api_keys_in_dir(directory.path()).is_err());
        let summaries = super::list_committed_api_keys_in_dir(directory.path(), &store).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].provider_connection_id,
            saved.provider_connection_id
        );
        assert_eq!(summaries[0].model_id, "gpt-first");
    }

    #[test]
    fn concurrent_saves_expose_only_one_committed_current_revision() {
        let directory = tempfile::tempdir().unwrap();
        let store = HostStore::open(directory.path().join("host.sqlite3"));
        let save_dir_a = directory.path().to_path_buf();
        let save_dir_b = directory.path().to_path_buf();
        let store_a = store.clone();
        let store_b = store.clone();
        let handle_a = std::thread::spawn(move || {
            save_api_key_in_dir(
                &save_dir_a,
                Some(&store_a),
                ManagedProviderApiKeySaveInput {
                    provider_key: "openai".to_string(),
                    label: "OpenAI Work".to_string(),
                    account_label: "work".to_string(),
                    endpoint: "https://api.openai.com/v1".to_string(),
                    api_kind: "openai-responses".to_string(),
                    api_key: "sk-a".to_string(),
                    model_id: "gpt-test".to_string(),
                    context_window: Some(128_000),
                    max_tokens: Some(8_192),
                    reasoning: Some(false),
                    image_input: Some(false),
                    supports_developer_role: Some(true),
                    supports_reasoning_effort: Some(false),
                },
            )
            .unwrap()
        });
        let handle_b = std::thread::spawn(move || {
            save_api_key_in_dir(
                &save_dir_b,
                Some(&store_b),
                ManagedProviderApiKeySaveInput {
                    provider_key: "openai".to_string(),
                    label: "OpenAI Work".to_string(),
                    account_label: "work".to_string(),
                    endpoint: "https://api.openai.com/v1".to_string(),
                    api_kind: "openai-responses".to_string(),
                    api_key: "sk-b".to_string(),
                    model_id: "gpt-test".to_string(),
                    context_window: Some(128_000),
                    max_tokens: Some(8_192),
                    reasoning: Some(false),
                    image_input: Some(false),
                    supports_developer_role: Some(true),
                    supports_reasoning_effort: Some(false),
                },
            )
            .unwrap()
        });
        let a = handle_a.join().unwrap();
        let b = handle_b.join().unwrap();
        assert_eq!(a.provider_connection_id, b.provider_connection_id);
        let summaries = list_api_keys_in_dir(directory.path()).unwrap();
        assert_eq!(summaries.len(), 1);
        let current_secret = read_current_secret(directory.path(), &a.provider_connection_id);
        assert!(
            current_secret["apiKey"] == "sk-a" || current_secret["apiKey"] == "sk-b",
            "{current_secret:?}"
        );
        let snapshot = store
            .provider_projection_snapshot(&a.provider_connection_id)
            .unwrap();
        assert!(
            snapshot.connection.current_config_version_id == a.current_config_version_id
                || snapshot.connection.current_config_version_id == b.current_config_version_id
        );
    }

    #[test]
    fn custom_endpoint_is_stored_verbatim_for_provider_connections() {
        let directory = tempfile::tempdir().unwrap();
        let saved = save_api_key_in_dir(
            directory.path(),
            None,
            ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Proxy".to_string(),
                account_label: "proxy".to_string(),
                endpoint: "https://proxy.example.test/v1".to_string(),
                api_kind: "openai-responses".to_string(),
                api_key: "sk-hidden".to_string(),
                model_id: "gpt-test".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let summaries = list_api_keys_in_dir(directory.path()).unwrap();
        assert_eq!(
            summaries[0].provider_connection_id,
            saved.provider_connection_id
        );
        assert_eq!(summaries[0].endpoint, "https://proxy.example.test/v1");
        assert_ne!(summaries[0].endpoint, "https://api.openai.com/v1");
    }
}
