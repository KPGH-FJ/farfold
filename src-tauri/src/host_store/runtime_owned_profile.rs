//! Immutable launch ownership, not the Provider selected for a later turn.
use super::{
    HostStore,
    records::{self, RuntimeRegistration},
};
use crate::{
    host_ids::{ProviderConfigVersionId, ProviderConnectionId, RuntimeProfileId},
    managed_provider::ManagedProviderSelection,
    runtime_registry::RuntimeBinding,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};

/// Non-secret launch facts subordinate to the existing owned profile row.
#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OwnedProfileLaunch {
    pub home: std::path::PathBuf,
    pub runtime_home: std::path::PathBuf,
    pub node: std::path::PathBuf,
    pub adapter: std::path::PathBuf,
    pub native: std::path::PathBuf,
    pub cwd: std::path::PathBuf,
    pub working_copy_id: crate::host_ids::WorkingCopyId,
    pub adapter_version: String,
    pub adapter_modules: std::collections::BTreeMap<String, String>,
    pub home_file_identity: [u64; 2],
    pub runtime_home_file_identity: [u64; 2],
    pub lease_file_identity: [u64; 2],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OwnedProfileLayout {
    LegacyProviderBoundV1,
    StableV1,
}

impl OwnedProfileLayout {
    fn as_str(self) -> &'static str {
        match self {
            Self::LegacyProviderBoundV1 => "legacy_provider_bound_v1",
            Self::StableV1 => "stable_v1",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeOwnedProfile {
    pub profile_id: RuntimeProfileId,
    pub layout: OwnedProfileLayout,
    pub binding: RuntimeBinding,
    pub bootstrap_managed_provider: Option<ManagedProviderSelection>,
}

impl RuntimeOwnedProfile {
    pub fn managed_bootstrap(&self) -> Result<&ManagedProviderSelection, String> {
        self.bootstrap_managed_provider
            .as_ref()
            .ok_or_else(|| "Runtime profile has no managed bootstrap".into())
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.bootstrap_managed_provider.is_none()
            && (self.layout != OwnedProfileLayout::StableV1
                || !matches!(
                    (
                        self.binding.product_id.as_str(),
                        self.binding.adapter_id.as_str()
                    ),
                    ("pi", "pi-acp-stdio-v1") | ("codex", "codex-acp-stdio-v1")
                ))
        {
            return Err("Only a stable Pi/Codex ACP profile may omit a managed Provider".into());
        }
        let id = self.profile_id.as_str();
        if id.is_empty()
            || id.len() > 120
            || matches!(id, "." | "..")
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("Runtime owned profile identifier is not a safe directory key".into());
        }
        Ok(())
    }
}

fn read(
    connection: &rusqlite::Connection,
    binding: &RuntimeBinding,
) -> Result<Option<RuntimeOwnedProfile>, String> {
    let row = connection
        .query_row(
            "SELECT profile_id, installation_id, runtime_product_id, runtime_build_id, adapter_id,
                bootstrap_provider_connection_id, bootstrap_provider_config_version_id, layout
         FROM runtime_owned_profiles WHERE connection_id = ?1",
            [binding.connection_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((profile, installation, product, build, adapter, provider, version, layout)) = row
    else {
        return Ok(None);
    };
    if installation != binding.installation_id.as_str()
        || product != binding.product_id.as_str()
        || build != binding.runtime_build_id.as_str()
        || adapter != binding.adapter_id.as_str()
    {
        return Err("Runtime owned profile does not match the original launch binding".into());
    }
    let result = RuntimeOwnedProfile {
        profile_id: RuntimeProfileId::parse(profile).map_err(|error| error.to_string())?,
        layout: match layout.as_str() {
            "legacy_provider_bound_v1" => OwnedProfileLayout::LegacyProviderBoundV1,
            "stable_v1" => OwnedProfileLayout::StableV1,
            _ => return Err("Unknown Runtime owned profile layout".into()),
        },
        binding: binding.clone(),
        bootstrap_managed_provider: match (provider, version) {
            (None, None) => None,
            (Some(provider), Some(version)) => Some(ManagedProviderSelection {
                provider_connection_id: ProviderConnectionId::parse(provider)
                    .map_err(|error| error.to_string())?,
                provider_config_version_id: ProviderConfigVersionId::parse(version)
                    .map_err(|error| error.to_string())?,
            }),
            _ => return Err("Runtime bootstrap Provider/version pair is incomplete".into()),
        },
    };
    result.validate()?;
    if result.layout == OwnedProfileLayout::StableV1
        && let Some(bootstrap) = &result.bootstrap_managed_provider
    {
        let versions = read_versions(connection, &result)?;
        if !versions
            .iter()
            .any(|version| same_version(version, bootstrap))
        {
            return Err(
                "Runtime profile bootstrap authorization is missing; refusing implicit repair"
                    .into(),
            );
        }
    }
    Ok(Some(result))
}

fn same_version(left: &ManagedProviderSelection, right: &ManagedProviderSelection) -> bool {
    left.provider_connection_id == right.provider_connection_id
        && left.provider_config_version_id == right.provider_config_version_id
}

fn read_versions(
    connection: &rusqlite::Connection,
    profile: &RuntimeOwnedProfile,
) -> Result<Vec<ManagedProviderSelection>, String> {
    let mut statement = connection.prepare(
        "SELECT a.provider_connection_id, a.provider_config_version_id, p.source
         FROM runtime_profile_provider_versions a
         JOIN provider_connections p ON p.provider_connection_id = a.provider_connection_id
         WHERE a.profile_id = ?1 ORDER BY a.authorized_at, a.provider_connection_id, a.provider_config_version_id"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([profile.profile_id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let (provider, version, source) = row.map_err(|error| error.to_string())?;
        if source != "farfold_managed" {
            return Err("Native Provider cannot acquire managed profile authorization".into());
        }
        Ok(ManagedProviderSelection {
            provider_connection_id: ProviderConnectionId::parse(provider)
                .map_err(|error| error.to_string())?,
            provider_config_version_id: ProviderConfigVersionId::parse(version)
                .map_err(|error| error.to_string())?,
        })
    })
    .collect()
}

pub(super) fn current_launch_from(
    connection: &rusqlite::Connection,
    binding: &RuntimeBinding,
    profile_id: &RuntimeProfileId,
    generation: u64,
) -> Result<OwnedProfileLaunch, String> {
    let profile = read(connection, binding)?.ok_or("Original owned profile missing")?;
    if &profile.profile_id != profile_id {
        return Err("Foreign owned profile".into());
    }
    let raw: String = connection.query_row(
                "SELECT launch_json FROM runtime_owned_profile_launches WHERE profile_id=?1 AND last_generation=?2",
                params![profile_id.as_str(), i64::try_from(generation).map_err(|_| "Invalid generation")?],
                |row| row.get(0)).map_err(|_| "Owned launch generation is no longer current")?;
    serde_json::from_str(&raw).map_err(|_| "Invalid saved owned launch".into())
}
impl HostStore {
    pub(crate) fn current_owned_profile_launch(
        &self,
        binding: &RuntimeBinding,
        profile_id: &RuntimeProfileId,
        generation: u64,
    ) -> Result<OwnedProfileLaunch, String> {
        self.with_ready_database(|database| {
            current_launch_from(&database.connection, binding, profile_id, generation)
        })
    }
    /// The persisted current generation for an existing owned launch.
    pub(crate) fn owned_profile_launch_generation(
        &self,
        binding: &RuntimeBinding,
        profile_id: &RuntimeProfileId,
    ) -> Result<u64, String> {
        self.with_ready_database(|database| {
            let profile = read(&database.connection, binding)?
                .ok_or("Original owned profile missing")?;
            if &profile.profile_id != profile_id {
                return Err("Foreign owned profile".into());
            }
            database
                .connection
                .query_row(
                    "SELECT last_generation FROM runtime_owned_profile_launches WHERE profile_id = ?1",
                    [profile_id.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|_| "Owned launch generation unavailable")?
                .ok_or("Owned launch generation missing".to_string())
                .and_then(|g| {
                    u64::try_from(g).map_err(|_| "Invalid owned launch generation".to_string())
                })
        })
    }
    /// Advances before launch; failed launches consume a generation, never reuse one.
    /// Existing metadata is immutable. Missing metadata cannot be repaired by restore.
    pub(crate) fn reserve_owned_profile_launch(
        &self,
        profile: &RuntimeOwnedProfile,
        launch: &OwnedProfileLaunch,
        create: bool,
    ) -> Result<u64, String> {
        let encoded = serde_json::to_string(launch).map_err(|_| "Invalid owned launch")?;
        self.with_ready_database(|database| {
            let transaction = database.connection.transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| "Owned launch unavailable")?;
            let saved = read(&transaction, &profile.binding)?.ok_or("Original owned profile missing")?;
            if saved.profile_id != profile.profile_id || saved.layout != profile.layout
                || saved.bootstrap_managed_provider != profile.bootstrap_managed_provider {
                return Err("Original owned profile mismatch".into());
            }
            let row: Option<(String, i64)> = transaction.query_row(
                "SELECT launch_json, last_generation FROM runtime_owned_profile_launches WHERE profile_id = ?1",
                [profile.profile_id.as_str()], |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional().map_err(|_| "Owned launch record unavailable")?;
            let generation = match row {
                None if create => {
                    transaction.execute("INSERT INTO runtime_owned_profile_launches VALUES (?1, ?2, 1)",
                        params![profile.profile_id.as_str(), encoded]).map_err(|_| "Cannot register owned launch")?;
                    1
                }
                Some((original, previous)) if !create => {
                    let original: OwnedProfileLaunch = serde_json::from_str(&original).map_err(|_| "Invalid saved owned launch")?;
                    if &original != launch || !(1..9_007_199_254_740_991).contains(&previous) {
                        return Err("Owned launch identity changed or generation exhausted".into());
                    }
                    let next = previous + 1;
                    transaction.execute("UPDATE runtime_owned_profile_launches SET last_generation = ?1 WHERE profile_id = ?2",
                        params![next, profile.profile_id.as_str()]).map_err(|_| "Cannot advance owned launch")?;
                    next
                }
                _ => return Err("Owned launch create/restore state mismatch".into()),
            };
            transaction.commit().map_err(|_| "Cannot commit owned launch")?;
            Ok(generation as u64)
        })
    }
    pub(crate) fn runtime_profile_provider_versions(
        &self,
        binding: &RuntimeBinding,
    ) -> Result<Vec<ManagedProviderSelection>, String> {
        self.with_ready_database(|database| {
            let profile =
                read(&database.connection, binding)?.ok_or("Runtime owned profile is missing")?;
            if profile.layout != OwnedProfileLayout::StableV1 {
                return Err("Legacy profile remains bound to its original Provider version".into());
            }
            read_versions(&database.connection, &profile)
        })
    }

    // Authorization permits projection; it is not an Applied state or model request receipt.
    pub(crate) fn authorize_runtime_profile_provider_version(
        &self,
        binding: &RuntimeBinding,
        selection: &ManagedProviderSelection,
    ) -> Result<(), String> {
        self.with_ready_database(|database| {
            let transaction = database.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
            let profile = read(&transaction, binding)?.ok_or("Runtime owned profile is missing")?;
            if profile.layout != OwnedProfileLayout::StableV1 { return Err("Cannot extend a legacy Provider-bound profile".into()); }
            if binding.product_id.as_str() != "pi" || binding.adapter_id.as_str() != crate::pi_acp_interactions::PI_ACP_ADAPTER_ID {
                return Err("Profile Provider authorization is not supported by this adapter".into());
            }
            let current: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM provider_connections p
                 JOIN provider_connection_versions v ON v.provider_connection_id = p.provider_connection_id AND v.config_version_id = p.current_config_version_id
                 WHERE p.provider_connection_id = ?1 AND p.current_config_version_id = ?2 AND p.source = 'farfold_managed')",
                params![selection.provider_connection_id.as_str(), selection.provider_config_version_id.as_str()], |row| row.get(0)
            ).map_err(|error| error.to_string())?;
            if !current { return Err("Profile authorization requires the explicitly selected current managed Provider version".into()); }
            transaction.execute(
                "INSERT INTO runtime_profile_provider_versions(profile_id, provider_connection_id, provider_config_version_id, authorized_at)
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT(profile_id, provider_connection_id, provider_config_version_id) DO NOTHING",
                params![profile.profile_id.as_str(), selection.provider_connection_id.as_str(), selection.provider_config_version_id.as_str(), super::now_millis()]
            ).map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())
        })
    }

    pub(crate) fn runtime_owned_profile(
        &self,
        binding: &RuntimeBinding,
    ) -> Result<Option<RuntimeOwnedProfile>, String> {
        self.with_ready_database(|database| read(&database.connection, binding))
    }

    pub(crate) fn register_runtime_owned_profile(
        &self,
        registration: &RuntimeRegistration,
        profile: &RuntimeOwnedProfile,
    ) -> Result<(), String> {
        profile.validate()?;
        records::validate_runtime_registration(registration)?;
        let binding = &profile.binding;
        if registration.runtime_product_id != binding.product_id
            || registration.installation_id != binding.installation_id
            || registration.runtime_build_id != binding.runtime_build_id
            || registration.adapter_id != binding.adapter_id
            || registration.connection_id != binding.connection_id
            || !(registration.connection_kind
                == super::records::RuntimeConnectionKind::ManagedLocal
                || (binding.product_id.as_str() == "codex"
                    && binding.adapter_id.as_str() == "codex-acp-stdio-v1"
                    && registration.connection_kind
                        == super::records::RuntimeConnectionKind::SystemLocal))
        {
            return Err(
                "Runtime owned profile registration has a different launch identity".into(),
            );
        }
        self.with_ready_database(|database| {
            let transaction = database.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
            if let Some(bootstrap) = &profile.bootstrap_managed_provider {
                let managed: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM provider_connections WHERE provider_connection_id = ?1 AND source = 'farfold_managed')",
                    [bootstrap.provider_connection_id.as_str()], |row| row.get(0)).map_err(|error| error.to_string())?;
                if !managed { return Err("Owned profile bootstrap requires an explicit managed Provider version".into()); }
            }
            records::register_runtime(&transaction, registration)?;
            if let Some(existing) = read(&transaction, binding)? {
                if existing.profile_id != profile.profile_id
                    || existing.layout != profile.layout
                    || existing.bootstrap_managed_provider != profile.bootstrap_managed_provider {
                    return Err("Runtime owned profile already has a different immutable launch reference".into());
                }
            } else {
                transaction.execute(
                    "INSERT INTO runtime_owned_profiles(profile_id, connection_id, installation_id, runtime_product_id,
                        runtime_build_id, adapter_id, bootstrap_provider_connection_id, bootstrap_provider_config_version_id, created_at, layout)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![profile.profile_id.as_str(), binding.connection_id.as_str(), binding.installation_id.as_str(),
                        binding.product_id.as_str(), binding.runtime_build_id.as_str(), binding.adapter_id.as_str(),
                        profile.bootstrap_managed_provider.as_ref().map(|provider| provider.provider_connection_id.as_str()),
                        profile.bootstrap_managed_provider.as_ref().map(|provider| provider.provider_config_version_id.as_str()), registration.created_at, profile.layout.as_str()],
                ).map_err(|error| format!("Cannot register Runtime owned profile: {error}"))?;
                if profile.layout == OwnedProfileLayout::StableV1 && let Some(bootstrap) = &profile.bootstrap_managed_provider {
                    transaction.execute(
                        "INSERT INTO runtime_profile_provider_versions(profile_id, provider_connection_id, provider_config_version_id, authorized_at) VALUES (?1, ?2, ?3, ?4)",
                        params![profile.profile_id.as_str(), bootstrap.provider_connection_id.as_str(),
                            bootstrap.provider_config_version_id.as_str(), registration.created_at]
                    ).map_err(|error| error.to_string())?;
                }
            }
            transaction.commit().map_err(|error| error.to_string())
        })
    }

    pub(crate) fn discard_unbound_owned_profile(
        &self,
        profile: &RuntimeOwnedProfile,
    ) -> Result<bool, String> {
        profile.validate()?;
        if profile.layout != OwnedProfileLayout::StableV1 {
            return Err(
                "An imported Runtime profile cannot be discarded as a failed new launch".into(),
            );
        }
        self.with_ready_database(|database| {
            let transaction = database.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
            let Some(existing) = read(&transaction, &profile.binding)? else {
                return Ok(false);
            };
            if existing.profile_id != profile.profile_id || existing.layout != profile.layout
                || existing.bootstrap_managed_provider != profile.bootstrap_managed_provider {
                return Err("Failed launch does not own the saved Runtime profile".into());
            }
            let referenced: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE connection_id = ?1)",
                [profile.binding.connection_id.as_str()], |row| row.get(0)).map_err(|error| error.to_string())?;
            if referenced { return Ok(false); }
            transaction.execute("DELETE FROM runtime_owned_profiles WHERE connection_id = ?1 AND profile_id = ?2",
                params![profile.binding.connection_id.as_str(), profile.profile_id.as_str()]).map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
            Ok(true)
        })
    }
}
