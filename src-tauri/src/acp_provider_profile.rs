use crate::{
    host_ids::{ProviderConfigVersionId, ProviderConnectionId},
    host_store::HostStore,
    managed_provider::ManagedProviderSelection,
    runtime_registry::RuntimeBinding,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAcpProviderBinding {
    pub(crate) provider_connection_id: ProviderConnectionId,
    pub(crate) provider_config_version_id: ProviderConfigVersionId,
    pub(crate) runtime_provider_id: String,
    pub(crate) runtime_model_id: String,
}

// Contains launch credentials. Never serialize or derive Debug for this value.
pub(crate) struct PreparedAcpProfile<Bootstrap = ManagedAcpProviderBinding> {
    pub binding: Bootstrap,
    pub managed_versions: Vec<ManagedAcpProviderBinding>,
    pub profile_root: PathBuf,
    pub config_root: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub integrity: Option<PiManagedProfileIntegrity>,
}

pub(crate) type PreparedPiProfile = PreparedAcpProfile<Option<ManagedAcpProviderBinding>>;

impl PreparedAcpProfile {
    pub(crate) fn into_optional_bootstrap(self) -> PreparedPiProfile {
        PreparedPiProfile {
            binding: Some(self.binding),
            managed_versions: self.managed_versions,
            profile_root: self.profile_root,
            config_root: self.config_root,
            environment: self.environment,
            integrity: self.integrity,
        }
    }
}

#[derive(Clone)]
pub(crate) struct PiManagedProfileIntegrity {
    config_root: PathBuf,
    provider_ids: Vec<String>,
    model_digest: Vec<u8>,
}

pub(crate) struct PiProfileProjection {
    pub selected: ManagedAcpProviderBinding,
    pub managed_versions: Vec<ManagedAcpProviderBinding>,
    pub integrity: PiManagedProfileIntegrity,
}

impl PiManagedProfileIntegrity {
    // Caller holds the existing Host configuration operation and lifecycle exclusion.
    // Success means committed configuration only, never native refresh/application.
    pub(crate) fn project_version(
        &self,
        app_data: &Path,
        store: &HostStore,
        runtime: &RuntimeBinding,
        selection: &ManagedProviderSelection,
    ) -> Result<PiProfileProjection, String> {
        self.verify()?;
        let profile = store
            .runtime_owned_profile(runtime)?
            .ok_or("Pi owned profile missing")?;
        if profile.layout != crate::host_store::runtime_owned_profile::OwnedProfileLayout::StableV1
            || self.config_root
                != app_data
                    .join("pi-acp/profiles")
                    .join(profile.profile_id.as_str())
                    .join("agent")
        {
            return Err(
                "Pi Provider projection does not target the original stable profile".into(),
            );
        }
        let path = self.config_root.join("models.json");
        let original = PiModelFileSnapshot::read(&path)?;
        let mut config: Value = serde_json::from_slice(&original.bytes)
            .map_err(|_| "Pi models configuration is invalid")?;
        if Sha256::digest(serde_json::to_vec(&config).map_err(|_| "Pi models digest unavailable")?)
            .as_slice()
            != self.model_digest
        {
            return Err("Pi models configuration changed before projection".into());
        }
        validate_owned_pi_config(app_data, store, &profile, &config)?;
        let (selected, next) = stable_version_config(app_data, store, selection)?;
        reject_native_credential_shadow(&self.config_root, &selected.runtime_provider_id)?;
        config["providers"]
            .as_object_mut()
            .ok_or("Pi Provider configuration missing")?
            .entry(selected.runtime_provider_id.clone())
            .or_insert_with(|| next["providers"][&selected.runtime_provider_id].clone());
        let mut bytes =
            serde_json::to_vec_pretty(&config).map_err(|_| "Pi models serialization failed")?;
        bytes.push(b'\n');
        if bytes.len() > 1024 * 1024 {
            return Err("Pi projected configuration exceeds inspection limit".into());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.config_root)
            .map_err(|_| "Pi private projection staging failed")?;
        temporary
            .write_all(&bytes)
            .map_err(|_| "Pi projection staging write failed")?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "Pi projection staging sync failed")?;
        store.authorize_runtime_profile_provider_version(runtime, selection)?;
        let managed_versions = validate_owned_pi_config(app_data, store, &profile, &config)?;
        let integrity = Self {
            config_root: self.config_root.clone(),
            provider_ids: managed_versions
                .iter()
                .map(|binding| binding.runtime_provider_id.clone())
                .collect(),
            model_digest: Sha256::digest(
                serde_json::to_vec(&config).map_err(|_| "Pi models digest unavailable")?,
            )
            .to_vec(),
        };
        self.verify()?;
        reject_native_credential_shadow(&self.config_root, &selected.runtime_provider_id)?;
        if PiModelFileSnapshot::read(&path)? != original {
            return Err("Pi models file changed before commit; refusing to overwrite it".into());
        }
        // Atomic replacement with a final original-file check, not an external-writer CAS.
        if bytes != original.bytes {
            temporary
                .persist(&path)
                .map_err(|_| "Pi projection commit failed")?;
        }
        Ok(PiProfileProjection {
            selected,
            managed_versions,
            integrity,
        })
    }

    pub(crate) fn verify(&self) -> Result<(), String> {
        for path in self.config_root.ancestors().take(4) {
            let metadata = fs::symlink_metadata(path)
                .map_err(|_| "Pi managed profile directory unavailable")?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.permissions().mode() & 0o077 != 0
            {
                return Err("Pi managed profile directory is no longer private and owned".into());
            }
        }
        let value = read_private_pi_models(&self.config_root.join("models.json"))?;
        if Sha256::digest(
            serde_json::to_vec(&value)
                .map_err(|_| "Pi managed configuration digest unavailable")?,
        )
        .as_slice()
            != self.model_digest
        {
            return Err(
                "Pi managed model configuration changed; Provider version cannot be confirmed"
                    .into(),
            );
        }
        for provider in &self.provider_ids {
            reject_native_credential_shadow(&self.config_root, provider)?;
        }
        Ok(())
    }
}

fn read_private_pi_models(path: &Path) -> Result<Value, String> {
    let snapshot = PiModelFileSnapshot::read(path)?;
    serde_json::from_slice(&snapshot.bytes)
        .map_err(|_| "Pi managed model configuration is invalid".into())
}

#[derive(PartialEq, Eq)]
struct PiModelFileSnapshot {
    bytes: Vec<u8>,
    device: u64,
    inode: u64,
}

impl PiModelFileSnapshot {
    fn read(path: &Path) -> Result<Self, String> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| "Pi managed model configuration cannot be safely inspected")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Pi model metadata unavailable")?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
            return Err("Pi managed model configuration is not a private regular file".into());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Pi managed model configuration unreadable")?;
        if bytes.len() > 1024 * 1024 {
            return Err("Pi managed model configuration exceeds inspection limit".into());
        }
        let after = file
            .metadata()
            .map_err(|_| "Pi model metadata unavailable")?;
        if metadata.len() != after.len()
            || metadata.mtime() != after.mtime()
            || metadata.mtime_nsec() != after.mtime_nsec()
            || metadata.ctime() != after.ctime()
            || metadata.ctime_nsec() != after.ctime_nsec()
        {
            return Err("Pi models file changed during inspection".into());
        }
        Ok(Self {
            bytes,
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

pub(crate) fn protect_directory(path: &Path) -> Result<(), String> {
    if path.is_symlink() {
        return Err("ACP 私有目录不能是符号链接".into());
    }
    fs::create_dir_all(path).map_err(|error| format!("无法创建 ACP 私有目录：{error}"))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("无法保护 ACP 私有目录：{error}"))
}

pub(crate) fn safe_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect()
}

fn write_private_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        protect_directory(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| format!("无法创建 ACP 私有配置：{error}"))?;
    let result = (|| {
        serde_json::to_writer_pretty(&mut file, value).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(crate) fn prepare(
    app_data: &Path,
    acp_root: &Path,
    operation_id: &str,
    runtime: &RuntimeBinding,
    store: &HostStore,
    selection: &ManagedProviderSelection,
    require_current: bool,
) -> Result<PreparedAcpProfile, String> {
    prepare_at(
        app_data,
        acp_root,
        operation_id,
        runtime,
        store,
        selection,
        require_current,
        None,
    )
}

pub(crate) fn prepare_owned(
    app_data: &Path,
    acp_root: &Path,
    store: &HostStore,
    profile: &crate::host_store::runtime_owned_profile::RuntimeOwnedProfile,
    require_current: bool,
) -> Result<PreparedPiProfile, String> {
    profile.validate()?;
    if !require_current {
        for path in [
            acp_root.to_path_buf(),
            acp_root.join("profiles"),
            acp_root.join("profiles").join(profile.profile_id.as_str()),
            acp_root
                .join("profiles")
                .join(profile.profile_id.as_str())
                .join("agent"),
            acp_root
                .join("profiles")
                .join(profile.profile_id.as_str())
                .join("sessions"),
        ] {
            let metadata = fs::symlink_metadata(path).map_err(
                |_| "Pi ACP original profile directory is missing; refusing to recreate it",
            )?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("Pi ACP original profile directory is not an owned directory".into());
            }
        }
    }
    if profile.bootstrap_managed_provider.is_none() {
        let profile_root = acp_root.join("profiles").join(profile.profile_id.as_str());
        let config_root = profile_root.join("agent");
        let config = if require_current {
            protect_directory(acp_root)?;
            protect_directory(&acp_root.join("profiles"))?;
            fs::create_dir(&profile_root)
                .map_err(|_| "New Pi profile already exists or cannot be created")?;
            protect_directory(&profile_root)?;
            protect_directory(&config_root)?;
            protect_directory(&profile_root.join("sessions"))?;
            let config = json!({"providers":{}});
            write_private_json(&config_root.join("models.json"), &config)?;
            write_private_json(
                &config_root.join("settings.json"),
                &json!({"quietStartup":true}),
            )?;
            config
        } else {
            read_private_pi_models(&config_root.join("models.json"))?
        };
        let managed_versions = if require_current {
            Vec::new()
        } else {
            validate_owned_pi_config(app_data, store, profile, &config)?
        };
        let integrity = PiManagedProfileIntegrity {
            config_root: config_root.clone(),
            provider_ids: managed_versions
                .iter()
                .map(|provider| provider.runtime_provider_id.clone())
                .collect(),
            model_digest: Sha256::digest(
                serde_json::to_vec(&config).map_err(|_| "Pi configuration digest unavailable")?,
            )
            .to_vec(),
        };
        integrity.verify()?;
        return Ok(PreparedPiProfile {
            binding: None,
            managed_versions,
            profile_root,
            config_root,
            environment: BTreeMap::new(),
            integrity: Some(integrity),
        });
    }
    prepare_at(
        app_data,
        acp_root,
        "host-session",
        &profile.binding,
        store,
        profile.managed_bootstrap()?,
        require_current,
        Some(profile),
    )
    .map(PreparedAcpProfile::into_optional_bootstrap)
}

pub(crate) fn legacy_pi_profile_id(
    runtime: &RuntimeBinding,
    selection: &ManagedProviderSelection,
) -> String {
    crate::host_ids::derived_host_id(
        "pi-acp-profile",
        &[
            runtime.product_id.as_str(),
            runtime.installation_id.as_str(),
            runtime.runtime_build_id.as_str(),
            runtime.adapter_id.as_str(),
            runtime.connection_id.as_str(),
            selection.provider_connection_id.as_str(),
            selection.provider_config_version_id.as_str(),
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare_at(
    app_data: &Path,
    acp_root: &Path,
    operation_id: &str,
    runtime: &RuntimeBinding,
    store: &HostStore,
    selection: &ManagedProviderSelection,
    require_current: bool,
    owned_profile: Option<&crate::host_store::runtime_owned_profile::RuntimeOwnedProfile>,
) -> Result<PreparedAcpProfile, String> {
    if operation_id.is_empty()
        || operation_id.len() > 120
        || matches!(operation_id, "." | "..")
        || !operation_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
    {
        return Err("ACP managed operation id is invalid".into());
    }
    let pi = match (runtime.product_id.as_str(), runtime.adapter_id.as_str()) {
        ("pi", crate::pi_acp_interactions::PI_ACP_ADAPTER_ID) => true,
        ("opencode", "opencode-acp-stdio-v1") => false,
        _ => return Err("Provider profile target is not a supported ACP adapter".into()),
    };
    let snapshot = store.provider_projection_snapshot(&selection.provider_connection_id)?;
    if require_current
        && snapshot.connection.current_config_version_id != selection.provider_config_version_id
    {
        return Err("ACP managed Provider targets a stale config version".into());
    }
    let (secret, _) = crate::managed_provider::read_secret_for_version(
        app_data,
        store,
        &selection.provider_connection_id,
        &selection.provider_config_version_id,
    )?;
    let string = |key: &str| {
        secret
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("ACP managed Provider secret missing {key}"))
    };
    let stable = owned_profile.is_some_and(|profile| {
        profile.layout == crate::host_store::runtime_owned_profile::OwnedProfileLayout::StableV1
    });
    let provider_id = if stable {
        crate::host_ids::derived_host_id(
            "farfold-managed",
            &[
                selection.provider_connection_id.as_str(),
                selection.provider_config_version_id.as_str(),
            ],
        )
    } else {
        selection.provider_connection_id.to_string()
    };
    let model_id = string("modelId")?;
    let api_kind = string("apiKind")?;
    let api_key = string("apiKey")?;
    let endpoint = string("endpoint")?;
    let context_window = secret
        .get("contextWindow")
        .and_then(Value::as_u64)
        .unwrap_or(128_000);
    let max_tokens = secret
        .get("maxTokens")
        .and_then(Value::as_u64)
        .unwrap_or(8_192);
    let model_selector = format!("{provider_id}/{model_id}");
    let mut environment = BTreeMap::new();
    let mut config = if pi {
        pi_version_config(&secret, &provider_id, stable, &mut environment)?
    } else {
        if api_kind != "openai-chat-completions" {
            return Err("OpenCode ACP managed Provider requires openai-chat-completions; openai-responses is not compatible with the fixed 1.18.30 openai-compatible provider".into());
        }
        json!({"model":model_selector,"provider":{provider_id.clone():{
            "name":string("label")?,"npm":"@ai-sdk/openai-compatible",
            "options":{"baseURL":endpoint,"apiKey":api_key},
            "models":{model_id.clone():{"name":model_id,"limit":{"context":context_window,"output":max_tokens}}}
        }}})
    };
    let profile_segment = if let Some(profile) = owned_profile {
        if !pi {
            return Err("Owned profile preparation is not supported by this adapter".into());
        }
        profile.profile_id.to_string()
    } else if pi {
        legacy_pi_profile_id(runtime, selection)
    } else {
        safe_path_segment(runtime.connection_id.as_str())
    };
    protect_directory(acp_root)?;
    let profile_root = acp_root.join("profiles").join(profile_segment);
    protect_directory(&acp_root.join("profiles"))?;
    protect_directory(&profile_root)?;
    let config_root = if pi {
        profile_root.join("agent")
    } else {
        acp_root
            .join("launch-configs")
            .join(safe_path_segment(operation_id))
    };
    if let Some(parent) = config_root.parent() {
        protect_directory(parent)?;
    }
    let created = match fs::create_dir(&config_root) {
        Ok(()) => true,
        Err(error) if pi && error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => {
            return Err(format!(
                "ACP launch config already exists or cannot be created; refusing to overwrite: {error}"
            ));
        }
    };
    let initial_binding = ManagedAcpProviderBinding {
        provider_connection_id: selection.provider_connection_id.clone(),
        provider_config_version_id: selection.provider_config_version_id.clone(),
        runtime_provider_id: provider_id.clone(),
        runtime_model_id: model_selector.clone(),
    };
    let mut managed_versions = vec![initial_binding.clone()];
    let prepare_files = (|| {
        protect_directory(&config_root)?;
        if pi {
            if stable {
                reject_native_credential_shadow(&config_root, &provider_id)?;
            }
            let path = config_root.join("models.json");
            if created {
                write_private_json(&path, &config)?;
                write_private_json(
                    &config_root.join("settings.json"),
                    &json!({"defaultProvider":provider_id,"defaultModel":model_id,"quietStartup":true}),
                )?;
            } else {
                if path.is_symlink() {
                    return Err("Pi ACP model configuration cannot be a symlink".into());
                }
                let existing = read_private_pi_models(&path)?;
                if stable {
                    managed_versions = validate_owned_pi_config(
                        app_data,
                        store,
                        owned_profile.expect("stable owned profile"),
                        &existing,
                    )?;
                    config = existing;
                } else if existing != config {
                    return Err("Pi ACP model configuration changed; refusing to overwrite native configuration".into());
                }
            }
            protect_directory(&profile_root.join("sessions"))?;
        } else {
            write_private_json(&config_root.join("config/opencode.json"), &config)?;
            write_private_json(
                &config_root.join("xdg-config/opencode/opencode.json"),
                &config,
            )?;
        }
        Ok(())
    })();
    if let Err(error) = prepare_files {
        if created {
            let _ = fs::remove_dir_all(&config_root);
        }
        return Err(error);
    }
    let integrity = stable.then(|| PiManagedProfileIntegrity {
        config_root: config_root.clone(),
        provider_ids: managed_versions
            .iter()
            .map(|binding| binding.runtime_provider_id.clone())
            .collect(),
        model_digest: Sha256::digest(
            serde_json::to_vec(&config).expect("JSON configuration serialization cannot fail"),
        )
        .to_vec(),
    });
    if let Some(integrity) = &integrity {
        integrity.verify()?;
    }
    Ok(PreparedAcpProfile {
        binding: initial_binding,
        managed_versions,
        profile_root,
        config_root,
        environment,
        integrity,
    })
}

fn pi_version_config(
    secret: &Value,
    provider_id: &str,
    stable: bool,
    environment: &mut BTreeMap<String, String>,
) -> Result<Value, String> {
    let field = |name: &str| {
        secret
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Pi Provider secret missing {name}"))
    };
    let api = match field("apiKind")? {
        "openai-chat-completions" => "openai-completions",
        "openai-responses" => "openai-responses",
        _ => return Err("Managed Provider API kind is not supported by Pi".into()),
    };
    let api_key = field("apiKey")?;
    let native_key = if stable {
        pi_literal_config_value(api_key)
    } else {
        environment.insert("FARFOLD_PI_MANAGED_KEY".into(), api_key.into());
        "$FARFOLD_PI_MANAGED_KEY".into()
    };
    Ok(json!({"providers":{provider_id:{
        "baseUrl":field("endpoint")?,"api":api,"apiKey":native_key,
        "compat":{"supportsDeveloperRole":secret.get("supportsDeveloperRole").and_then(Value::as_bool).unwrap_or(true),
            "supportsReasoningEffort":secret.get("supportsReasoningEffort").and_then(Value::as_bool).unwrap_or(false)},
        "models":[{"id":field("modelId")?,"name":field("label")?,
            "contextWindow":secret.get("contextWindow").and_then(Value::as_u64).unwrap_or(128_000),
            "maxTokens":secret.get("maxTokens").and_then(Value::as_u64).unwrap_or(8_192),
            "reasoning":secret.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
            "input":if secret.get("imageInput").and_then(Value::as_bool).unwrap_or(false) {json!(["text","image"])} else {json!(["text"])}
        }]
    }}}))
}

fn stable_version_config(
    app_data: &Path,
    store: &HostStore,
    selection: &ManagedProviderSelection,
) -> Result<(ManagedAcpProviderBinding, Value), String> {
    let (secret, _) = crate::managed_provider::read_secret_for_version(
        app_data,
        store,
        &selection.provider_connection_id,
        &selection.provider_config_version_id,
    )?;
    let provider = crate::host_ids::derived_host_id(
        "farfold-managed",
        &[
            selection.provider_connection_id.as_str(),
            selection.provider_config_version_id.as_str(),
        ],
    );
    let model = secret
        .get("modelId")
        .and_then(Value::as_str)
        .ok_or("Pi Provider model missing")?;
    let config = pi_version_config(&secret, &provider, true, &mut BTreeMap::new())?;
    Ok((
        ManagedAcpProviderBinding {
            provider_connection_id: selection.provider_connection_id.clone(),
            provider_config_version_id: selection.provider_config_version_id.clone(),
            runtime_model_id: format!("{provider}/{model}"),
            runtime_provider_id: provider,
        },
        config,
    ))
}

fn validate_owned_pi_config(
    app_data: &Path,
    store: &HostStore,
    profile: &crate::host_store::runtime_owned_profile::RuntimeOwnedProfile,
    config: &Value,
) -> Result<Vec<ManagedAcpProviderBinding>, String> {
    let saved = store
        .runtime_owned_profile(&profile.binding)?
        .ok_or("Pi owned profile reference missing")?;
    if saved.profile_id != profile.profile_id
        || saved.layout != profile.layout
        || saved.bootstrap_managed_provider != profile.bootstrap_managed_provider
    {
        return Err("Pi owned profile reference changed".into());
    }
    let versions = store.runtime_profile_provider_versions(&profile.binding)?;
    let providers = config
        .get("providers")
        .and_then(Value::as_object)
        .ok_or("Pi models configuration has no Provider object")?;
    let mut bindings = Vec::new();
    for (alias, entry) in providers {
        if !alias.starts_with("farfold-managed-") {
            continue;
        }
        let selection = versions
            .iter()
            .find(|selection| {
                crate::host_ids::derived_host_id(
                    "farfold-managed",
                    &[
                        selection.provider_connection_id.as_str(),
                        selection.provider_config_version_id.as_str(),
                    ],
                ) == *alias
            })
            .ok_or("Pi models configuration contains an unauthorized managed version")?;
        let (binding, expected) = stable_version_config(app_data, store, selection)?;
        if expected["providers"][alias] != *entry {
            return Err("Pi managed version configuration changed; refusing to overwrite native configuration".into());
        }
        bindings.push(binding);
    }
    if let Some(bootstrap) = &profile.bootstrap_managed_provider
        && !bindings.iter().any(|binding| {
            binding.provider_connection_id == bootstrap.provider_connection_id
                && binding.provider_config_version_id == bootstrap.provider_config_version_id
        })
    {
        return Err("Pi original bootstrap Provider projection is missing".into());
    }
    Ok(bindings)
}

// Pi config values are templates, not JSON literals. Escape dollars everywhere and a leading shell marker.
fn pi_literal_config_value(value: &str) -> String {
    let escaped = value.replace('$', "$$");
    if escaped.starts_with('!') {
        format!("${escaped}")
    } else {
        escaped
    }
}

fn reject_native_credential_shadow(config_root: &Path, provider_id: &str) -> Result<(), String> {
    let path = config_root.join("auth.json");
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Pi native credential storage cannot be safely inspected".into()),
    };
    if !file
        .metadata()
        .map_err(|_| "Pi credential metadata unavailable")?
        .is_file()
    {
        return Err("Pi native credential storage is not a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Pi credential storage unreadable")?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Pi credential storage exceeds inspection limit".into());
    }
    let value: Value =
        serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
            .map_err(|_| "Pi native credential storage is invalid")?;
    let credentials = value
        .as_object()
        .ok_or("Pi native credential storage is not an object")?;
    if credentials.contains_key(provider_id) {
        return Err("Pi native credentials conflict with the managed Provider version; refusing to override either source".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn register_profile(
        store: &HostStore,
        profile: &crate::host_store::runtime_owned_profile::RuntimeOwnedProfile,
    ) {
        use crate::host_store::records::{
            RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration,
        };
        let binding = &profile.binding;
        let pi = crate::runtime_registry::PI_ACP_RUNTIME;
        store
            .register_runtime_owned_profile(
                &RuntimeRegistration {
                    runtime_product_id: binding.product_id.clone(),
                    display_name: "Pi".into(),
                    installation_id: binding.installation_id.clone(),
                    runtime_build_id: binding.runtime_build_id.clone(),
                    adapter_id: binding.adapter_id.clone(),
                    distribution: RuntimeDistribution::Managed,
                    observed_version: pi.version.into(),
                    artifact_sha256: pi.binary_sha256.into(),
                    connection_id: binding.connection_id.clone(),
                    connection_label: "isolated profile fixture".into(),
                    connection_kind: RuntimeConnectionKind::ManagedLocal,
                    created_at: 1,
                    verified_at: 1,
                },
                profile,
            )
            .unwrap();
    }

    pub(crate) fn save_fixture(
        app_data: &Path,
        store: &HostStore,
        endpoint: &str,
        api_kind: &str,
        key: &str,
    ) -> ManagedProviderSelection {
        let saved = crate::managed_provider::save_api_key_in_dir(
            app_data,
            Some(store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "custom".into(),
                label: "Pi Profile Fixture".into(),
                account_label: "profile-test".into(),
                endpoint: endpoint.into(),
                api_kind: api_kind.into(),
                api_key: key.into(),
                model_id: "fixture-only".into(),
                context_window: Some(32768),
                max_tokens: Some(1024),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(false),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        ManagedProviderSelection {
            provider_connection_id: saved.provider_connection_id,
            provider_config_version_id: saved.current_config_version_id,
        }
    }

    pub(crate) fn pi_binding() -> RuntimeBinding {
        let mut binding = RuntimeBinding::from(crate::runtime_registry::PI_RUNTIME);
        binding.adapter_id =
            crate::host_ids::AdapterId::parse(crate::pi_acp_interactions::PI_ACP_ADAPTER_ID)
                .unwrap();
        binding.connection_id =
            crate::host_ids::ConnectionId::parse("pi-acp-isolated-profile").unwrap();
        binding
    }

    #[test]
    fn native_only_profile_preparation_and_restore_do_not_invent_managed_authorization() {
        use crate::host_store::runtime_owned_profile::{OwnedProfileLayout, RuntimeOwnedProfile};
        let root = tempfile::tempdir().unwrap();
        let store = HostStore::open(root.path().join("host.sqlite3"));
        let acp = root.path().join("pi-acp");
        let profile = RuntimeOwnedProfile {
            profile_id: crate::host_ids::RuntimeProfileId::parse("native-only-profile").unwrap(),
            layout: OwnedProfileLayout::StableV1,
            binding: pi_binding(),
            bootstrap_managed_provider: None,
        };
        let prepared = prepare_owned(root.path(), &acp, &store, &profile, true).unwrap();
        assert!(prepared.binding.is_none());
        assert!(prepared.managed_versions.is_empty());
        assert!(prepared.environment.is_empty());
        assert!(!prepared.config_root.join("auth.json").exists());
        assert!(prepare_owned(root.path(), &acp, &store, &profile, true).is_err());
        assert!(prepare_owned(root.path(), &acp, &store, &profile, false).is_err());
        register_profile(&store, &profile);
        let auth_path = prepared.config_root.join("auth.json");
        write_private_json(
            &auth_path,
            &json!({"anthropic":{"type":"api_key","key":"synthetic-only"}}),
        )
        .unwrap();
        let auth_before = fs::read(&auth_path).unwrap();
        let models_path = prepared.config_root.join("models.json");
        let models_before = fs::read(&models_path).unwrap();
        let restored = prepare_owned(root.path(), &acp, &store, &profile, false).unwrap();
        assert!(restored.binding.is_none());
        assert!(restored.managed_versions.is_empty());
        assert!(
            store
                .runtime_profile_provider_versions(&profile.binding)
                .unwrap()
                .is_empty()
        );
        assert_eq!(fs::read(&auth_path).unwrap(), auth_before);
        assert_eq!(fs::read(&models_path).unwrap(), models_before);
        restored.integrity.as_ref().unwrap().verify().unwrap();
        write_private_json(
            &models_path,
            &json!({"providers":{"farfold-managed-unowned":{}}}),
        )
        .unwrap();
        assert!(prepare_owned(root.path(), &acp, &store, &profile, false).is_err());
        assert_eq!(fs::read(&auth_path).unwrap(), auth_before);
        fs::remove_dir_all(prepared.profile_root.join("sessions")).unwrap();
        assert!(prepare_owned(root.path(), &acp, &store, &profile, false).is_err());
        assert!(!prepared.profile_root.join("sessions").exists());
    }

    #[test]
    fn stable_pi_projection_keeps_version_aliases_private_literals_and_native_credentials_separate()
    {
        use crate::host_store::runtime_owned_profile::{OwnedProfileLayout, RuntimeOwnedProfile};
        let root = tempfile::tempdir().unwrap();
        let store = HostStore::open(root.path().join("host.sqlite3"));
        let acp = root.path().join("pi-acp");
        let selection = save_fixture(
            root.path(),
            &store,
            "https://fixture.invalid/v1",
            "openai-chat-completions",
            "!not-a-command-${HOME}-$!$$",
        );
        let profile = RuntimeOwnedProfile {
            profile_id: crate::host_ids::RuntimeProfileId::parse("literal-profile").unwrap(),
            layout: OwnedProfileLayout::StableV1,
            binding: pi_binding(),
            bootstrap_managed_provider: Some(selection.clone()),
        };
        let first = prepare_owned(root.path(), &acp, &store, &profile, true).unwrap();
        assert!(prepare_owned(root.path(), &acp, &store, &profile, false).is_err());
        register_profile(&store, &profile);
        assert!(first.environment.is_empty());
        assert!(
            first
                .binding
                .as_ref()
                .unwrap()
                .runtime_provider_id
                .starts_with("farfold-managed-")
        );
        let path = first.config_root.join("models.json");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&first.config_root)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let original = fs::read(&path).unwrap();
        let config: Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(
            config["providers"][&first.binding.clone().unwrap().runtime_provider_id]["apiKey"],
            "$!not-a-command-$${HOME}-$$!$$$$"
        );
        let public = serde_json::to_string(&first.binding.clone().unwrap()).unwrap();
        assert!(!public.contains("not-a-command"));
        let second_selection = save_fixture(
            root.path(),
            &store,
            "https://fixture.invalid/v1",
            "openai-chat-completions",
            "changed-synthetic-key",
        );
        let second_profile = RuntimeOwnedProfile {
            profile_id: crate::host_ids::RuntimeProfileId::parse("literal-profile-second").unwrap(),
            bootstrap_managed_provider: Some(second_selection),
            ..profile.clone()
        };
        let second = prepare_owned(root.path(), &acp, &store, &second_profile, true).unwrap();
        assert_ne!(
            first.binding.clone().unwrap().runtime_provider_id,
            second.binding.clone().unwrap().runtime_provider_id
        );
        let restored = prepare_owned(root.path(), &acp, &store, &profile, false).unwrap();
        assert_eq!(
            restored.binding.clone().unwrap(),
            first.binding.clone().unwrap()
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        let auth = first.config_root.join("auth.json");
        fs::write(
            &auth,
            serde_json::to_vec(
                &json!({"unrelated-native":{"type":"api_key","key":"unrelated-synthetic-key"}}),
            )
            .unwrap(),
        )
        .unwrap();
        prepare_owned(root.path(), &acp, &store, &profile, false).unwrap();
        let shadow = serde_json::to_vec(&json!({first.binding.clone().unwrap().runtime_provider_id.clone():{"type":"api_key","key":"shadow-synthetic-key"}})).unwrap();
        fs::write(&auth, &shadow).unwrap();
        let error = prepare_owned(root.path(), &acp, &store, &profile, false)
            .err()
            .unwrap();
        assert!(error.contains("conflict"));
        assert!(!error.contains("shadow-synthetic-key"));
        assert_eq!(fs::read(&auth).unwrap(), shadow);
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_file(&auth).unwrap();
        std::os::unix::fs::symlink(&path, &auth).unwrap();
        assert!(prepare_owned(root.path(), &acp, &store, &profile, false).is_err());
    }

    #[test]
    fn controlled_projection_preserves_native_content_and_rejects_stale_drift_and_shadow() {
        use crate::host_store::runtime_owned_profile::{OwnedProfileLayout, RuntimeOwnedProfile};
        let root = tempfile::tempdir().unwrap();
        let store = HostStore::open(root.path().join("host.sqlite3"));
        let acp = root.path().join("pi-acp");
        let original_selection = save_fixture(
            root.path(),
            &store,
            "https://fixture.invalid/v1",
            "openai-chat-completions",
            "first-synthetic-key",
        );
        let profile = RuntimeOwnedProfile {
            profile_id: crate::host_ids::RuntimeProfileId::parse("controlled-profile").unwrap(),
            layout: OwnedProfileLayout::StableV1,
            binding: pi_binding(),
            bootstrap_managed_provider: Some(original_selection.clone()),
        };
        let first = prepare_owned(root.path(), &acp, &store, &profile, true).unwrap();
        register_profile(&store, &profile);
        let path = first.config_root.join("models.json");
        let mut original = read_private_pi_models(&path).unwrap();
        let native = json!({"apiKey":"unrelated-native-key","baseUrl":"https://native.invalid/v1","models":[{"id":"native"}]});
        original["providers"]["native-provider"] = native.clone();
        original["nativeOption"] = json!({"keep":[1,2,3]});
        write_private_json(&path, &original).unwrap();
        let prepared = prepare_owned(root.path(), &acp, &store, &profile, false).unwrap();
        let integrity = prepared.integrity.unwrap();
        let selected = save_fixture(
            root.path(),
            &store,
            "https://fixture.invalid/v1",
            "openai-chat-completions",
            "second-synthetic-key",
        );
        let before = PiModelFileSnapshot::read(&path).unwrap();
        assert!(
            integrity
                .project_version(root.path(), &store, &profile.binding, &original_selection)
                .is_err()
        );
        assert!(PiModelFileSnapshot::read(&path).unwrap() == before);
        let projected = integrity
            .project_version(root.path(), &store, &profile.binding, &selected)
            .unwrap();
        let after = read_private_pi_models(&path).unwrap();
        assert_eq!(after["providers"]["native-provider"], native);
        assert_eq!(after["nativeOption"], original["nativeOption"]);
        assert_eq!(
            after["providers"][&first.binding.clone().unwrap().runtime_provider_id],
            original["providers"][&first.binding.clone().unwrap().runtime_provider_id]
        );
        assert_eq!(projected.managed_versions.len(), 2);
        assert_eq!(
            projected.selected.provider_config_version_id,
            selected.provider_config_version_id
        );
        projected.integrity.verify().unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let committed = PiModelFileSnapshot::read(&path).unwrap();
        projected
            .integrity
            .project_version(root.path(), &store, &profile.binding, &selected)
            .unwrap();
        assert!(PiModelFileSnapshot::read(&path).unwrap() == committed);
        let third = save_fixture(
            root.path(),
            &store,
            "https://fixture.invalid/v1",
            "openai-chat-completions",
            "third-synthetic-key",
        );
        let (third_binding, _) = stable_version_config(root.path(), &store, &third).unwrap();
        write_private_json(&first.config_root.join("auth.json"), &json!({third_binding.runtime_provider_id:{"type":"api_key","key":"native-owned-conflict"}})).unwrap();
        let error = projected
            .integrity
            .project_version(root.path(), &store, &profile.binding, &third)
            .err()
            .unwrap();
        assert!(error.contains("conflict"));
        assert!(!error.contains("native-owned-conflict"));
        assert!(PiModelFileSnapshot::read(&path).unwrap() == committed);
        fs::remove_file(first.config_root.join("auth.json")).unwrap();
        let mut drift = after;
        drift["nativeOption"] = json!({"externalChange":true});
        write_private_json(&path, &drift).unwrap();
        let changed = PiModelFileSnapshot::read(&path).unwrap();
        assert!(
            projected
                .integrity
                .project_version(root.path(), &store, &profile.binding, &third)
                .is_err()
        );
        assert!(PiModelFileSnapshot::read(&path).unwrap() == changed);
    }

    #[test]
    fn stable_restore_accepts_only_authorized_exact_slots_and_keeps_native_configuration() {
        let root = tempfile::tempdir().unwrap();
        let store = HostStore::open(root.path().join("host.sqlite3"));
        let acp = root.path().join("pi-acp");
        let first_selection = save_fixture(
            root.path(),
            &store,
            "https://fixture.invalid/v1",
            "openai-chat-completions",
            "first-synthetic-key",
        );
        let profile = crate::host_store::runtime_owned_profile::RuntimeOwnedProfile {
            profile_id: crate::host_ids::RuntimeProfileId::parse("multi-version-profile").unwrap(),
            layout: crate::host_store::runtime_owned_profile::OwnedProfileLayout::StableV1,
            binding: pi_binding(),
            bootstrap_managed_provider: Some(first_selection.clone()),
        };
        let first = prepare_owned(root.path(), &acp, &store, &profile, true).unwrap();
        register_profile(&store, &profile);
        let path = first.config_root.join("models.json");
        let original = fs::read(&path).unwrap();
        let second_selection = save_fixture(
            root.path(),
            &store,
            "https://fixture.invalid/v1",
            "openai-chat-completions",
            "second-synthetic-key",
        );
        let (second_binding, second_config) =
            stable_version_config(root.path(), &store, &second_selection).unwrap();
        let mut config: Value = serde_json::from_slice(&original).unwrap();
        config["providers"][&second_binding.runtime_provider_id] =
            second_config["providers"][&second_binding.runtime_provider_id].clone();
        config["providers"]["native-provider"] = json!({"baseUrl":"https://native.invalid/v1","apiKey":"native-synthetic-key","models":[{"id":"native-model"}]});
        config["nativeTopLevel"] = json!({"preserve":true});
        write_private_json(&path, &config).unwrap();
        let projected = fs::read(&path).unwrap();
        assert!(
            prepare_owned(root.path(), &acp, &store, &profile, false)
                .err()
                .unwrap()
                .contains("unauthorized")
        );
        assert_eq!(fs::read(&path).unwrap(), projected);

        store
            .authorize_runtime_profile_provider_version(&profile.binding, &second_selection)
            .unwrap();
        fs::write(&path, &original).unwrap();
        let authorized_only = prepare_owned(root.path(), &acp, &store, &profile, false).unwrap();
        assert_eq!(
            authorized_only.managed_versions,
            vec![first.binding.clone().unwrap().clone()]
        );
        fs::write(&path, &projected).unwrap();
        let restored = prepare_owned(root.path(), &acp, &store, &profile, false).unwrap();
        assert_eq!(
            restored.binding.clone().unwrap(),
            first.binding.clone().unwrap()
        );
        assert_eq!(restored.managed_versions.len(), 2);
        assert!(restored.managed_versions.contains(&second_binding));
        assert_eq!(fs::read(&path).unwrap(), projected);
        restored.integrity.as_ref().unwrap().verify().unwrap();
        assert!(first.integrity.as_ref().unwrap().verify().is_err());
        assert!(
            store
                .provider_projection_snapshot(&second_selection.provider_connection_id)
                .unwrap()
                .projections
                .is_empty()
        );

        let auth = first.config_root.join("auth.json");
        let shadow = json!({second_binding.runtime_provider_id.clone():{"type":"api_key","key":"conflicting-synthetic-key"}});
        write_private_json(&auth, &shadow).unwrap();
        assert!(restored.integrity.as_ref().unwrap().verify().is_err());
        assert!(
            prepare_owned(root.path(), &acp, &store, &profile, false)
                .err()
                .unwrap()
                .contains("conflict")
        );
        assert_eq!(fs::read(&path).unwrap(), projected);
        fs::remove_file(auth).unwrap();

        config["providers"][&second_binding.runtime_provider_id]["baseUrl"] =
            json!("https://changed.invalid/v1");
        write_private_json(&path, &config).unwrap();
        let changed = fs::read(&path).unwrap();
        assert!(
            prepare_owned(root.path(), &acp, &store, &profile, false)
                .err()
                .unwrap()
                .contains("configuration changed")
        );
        assert_eq!(fs::read(&path).unwrap(), changed);
        config["providers"][&second_binding.runtime_provider_id] =
            second_config["providers"][&second_binding.runtime_provider_id].clone();
        config["providers"]
            .as_object_mut()
            .unwrap()
            .remove(&first.binding.clone().unwrap().runtime_provider_id);
        write_private_json(&path, &config).unwrap();
        assert!(
            prepare_owned(root.path(), &acp, &store, &profile, false)
                .err()
                .unwrap()
                .contains("bootstrap Provider projection is missing")
        );
        fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(
            prepare_owned(root.path(), &acp, &store, &profile, false)
                .err()
                .unwrap()
                .contains("inspection limit")
        );
    }

    #[test]
    #[ignore = "fixed official SDK resolver, synthetic credentials only; no model calls"]
    fn fixed_pi_literal_config_codec_never_executes_or_interpolates_credentials() {
        let cases: Vec<_> = [
            "plain",
            "!not-a-command",
            "$HOME",
            "${HOME}",
            "$$",
            "$!",
            "prefix${HOME}suffix",
            "!$!${HOME}$$",
            "trailing$",
            "unicode-\u{4e2d}\u{6587}",
        ]
        .into_iter()
        .map(|value| json!({"encoded":pi_literal_config_value(value),"original":value}))
        .collect();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("capability-bridge/runtime/node");
        assert_eq!(
            crate::runtime_registry::file_sha256(&node).unwrap(),
            "5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c"
        );
        let mut child = std::process::Command::new(node)
            .arg(manifest.join("../scripts/fixtures/pi-literal-secret-probe.mjs"))
            .env_clear()
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&cases).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "fixed resolver contract failed");
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value, json!({"version":"0.84.3","checked":cases.len()}));
    }

    #[test]
    fn pi_profile_uses_committed_versions_without_storing_credentials_or_marking_applied() {
        let root = tempfile::tempdir().unwrap();
        let store = HostStore::open(root.path().join("host.sqlite3"));
        let acp = root.path().join("pi-acp");
        let selection = save_fixture(
            root.path(),
            &store,
            "https://fixture.invalid/v1",
            "openai-chat-completions",
            "fixture-key-one",
        );
        let first = prepare(
            root.path(),
            &acp,
            "first",
            &pi_binding(),
            &store,
            &selection,
            true,
        )
        .unwrap();
        let models = fs::read_to_string(first.config_root.join("models.json")).unwrap();
        assert!(!models.contains("fixture-key-one"));
        assert_eq!(
            first.environment["FARFOLD_PI_MANAGED_KEY"],
            "fixture-key-one"
        );
        let config: Value = serde_json::from_str(&models).unwrap();
        let provider = &config["providers"][selection.provider_connection_id.as_str()];
        assert_eq!(provider["api"], "openai-completions");
        assert_eq!(provider["apiKey"], "$FARFOLD_PI_MANAGED_KEY");
        assert_eq!(provider["models"][0]["contextWindow"], 32768);
        assert_eq!(provider["compat"]["supportsDeveloperRole"], false);
        assert_eq!(
            fs::metadata(first.config_root.join("models.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&first.config_root)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let snapshot = serde_json::to_value(
            store
                .provider_projection_snapshot(&selection.provider_connection_id)
                .unwrap(),
        )
        .unwrap();
        assert!(snapshot["projections"].as_array().unwrap().is_empty());

        fs::write(
            first.profile_root.join("sessions/retained.jsonl"),
            b"native history",
        )
        .unwrap();
        fs::write(
            first.config_root.join("settings.json"),
            b"{\"nativeSetting\":true}",
        )
        .unwrap();
        let next = save_fixture(
            root.path(),
            &store,
            "https://fixture.invalid/v1",
            "openai-chat-completions",
            "fixture-key-two",
        );
        assert_ne!(
            next.provider_config_version_id,
            selection.provider_config_version_id
        );
        assert!(
            prepare(
                root.path(),
                &acp,
                "stale",
                &pi_binding(),
                &store,
                &selection,
                true
            )
            .is_err()
        );
        let restored = prepare(
            root.path(),
            &acp,
            "restore",
            &pi_binding(),
            &store,
            &selection,
            false,
        )
        .unwrap();
        assert_eq!(restored.profile_root, first.profile_root);
        assert_eq!(
            restored.environment["FARFOLD_PI_MANAGED_KEY"],
            "fixture-key-one"
        );
        assert_eq!(
            fs::read(first.config_root.join("settings.json")).unwrap(),
            b"{\"nativeSetting\":true}"
        );
        let updated = prepare(
            root.path(),
            &acp,
            "updated",
            &pi_binding(),
            &store,
            &next,
            true,
        )
        .unwrap();
        assert_ne!(updated.profile_root, first.profile_root);
        let mut other_installation = pi_binding();
        other_installation.installation_id =
            crate::host_ids::InstallationId::parse("another-pi-installation").unwrap();
        let peer = prepare(
            root.path(),
            &acp,
            "other-installation",
            &other_installation,
            &store,
            &next,
            true,
        )
        .unwrap();
        assert_ne!(peer.profile_root, updated.profile_root);
        assert_eq!(
            fs::read(first.profile_root.join("sessions/retained.jsonl")).unwrap(),
            b"native history"
        );
    }

    #[test]
    fn pi_profile_preserves_drift_and_rejects_symlink_or_unrelated_adapter() {
        let root = tempfile::tempdir().unwrap();
        let store = HostStore::open(root.path().join("host.sqlite3"));
        let acp = root.path().join("pi-acp");
        let selection = save_fixture(
            root.path(),
            &store,
            "https://fixture.invalid/v1",
            "openai-responses",
            "fixture-only",
        );
        let first = prepare(
            root.path(),
            &acp,
            "first",
            &pi_binding(),
            &store,
            &selection,
            true,
        )
        .unwrap();
        let models = first.config_root.join("models.json");
        let native: Value = serde_json::from_slice(&fs::read(&models).unwrap()).unwrap();
        assert_eq!(
            native["providers"][selection.provider_connection_id.as_str()]["api"],
            "openai-responses"
        );
        fs::write(&models, b"{\"userEdited\":true}").unwrap();
        assert!(
            prepare(
                root.path(),
                &acp,
                "again",
                &pi_binding(),
                &store,
                &selection,
                true
            )
            .is_err()
        );
        assert_eq!(fs::read(&models).unwrap(), b"{\"userEdited\":true}");
        fs::remove_file(&models).unwrap();
        let external = root.path().join("daily-config.json");
        fs::write(&external, b"protected").unwrap();
        std::os::unix::fs::symlink(&external, &models).unwrap();
        assert!(
            prepare(
                root.path(),
                &acp,
                "symlink",
                &pi_binding(),
                &store,
                &selection,
                true
            )
            .is_err()
        );
        assert_eq!(fs::read(&external).unwrap(), b"protected");
        assert!(
            prepare(
                root.path(),
                &acp,
                "old-pi",
                &RuntimeBinding::from(crate::runtime_registry::PI_RUNTIME),
                &store,
                &selection,
                true
            )
            .is_err()
        );
    }
}
