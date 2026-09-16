use super::{HostDatabase, HostStore, now_millis};
use crate::host_ids::{
    ConnectionId, FarfoldSessionId, HostTurnId, InstallationId, NativeSessionId,
    ProviderConfigVersionId, ProviderConnectionId, RuntimeProductId, derived_host_id,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderConnectionSource {
    FarfoldManaged,
    NativeUnmanaged,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSaveState {
    NotSaved,
    Saved,
    Failed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderApplyState {
    NotApplicable,
    Pending,
    Applied,
    NeedsRestart,
    Failed,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRequestState {
    NotRequested,
    VerifiedSuccess,
    VerifiedFailure,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderActiveTaskPolicy {
    CurrentTaskKeepsBoundConfig,
    AppliesImmediately,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConnectionUpsertInput {
    pub(crate) provider_connection_id: ProviderConnectionId,
    pub(crate) provider_key: String,
    pub(crate) label: String,
    pub(crate) source: ProviderConnectionSource,
    pub(crate) endpoint_fingerprint: String,
    pub(crate) credential_revision_fingerprint: String,
    pub(crate) model_mapping_fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderTargetProjectionInput {
    pub(crate) provider_connection_id: ProviderConnectionId,
    pub(crate) config_version_id: ProviderConfigVersionId,
    pub(crate) runtime_product_id: RuntimeProductId,
    pub(crate) installation_id: InstallationId,
    pub(crate) runtime_connection_id: ConnectionId,
    pub(crate) runtime_provider_id: String,
    pub(crate) runtime_model_id: String,
    pub(crate) save_state: ProviderSaveState,
    pub(crate) apply_state: ProviderApplyState,
    pub(crate) request_state: ProviderRequestState,
    pub(crate) request_verified_version_id: Option<ProviderConfigVersionId>,
    pub(crate) active_task_policy: ProviderActiveTaskPolicy,
    pub(crate) detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProjectionSnapshotInput {
    provider_connection_id: ProviderConnectionId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnProviderBindingInput {
    pub(crate) host_turn_id: HostTurnId,
    pub(crate) provider_connection_id: ProviderConnectionId,
    pub(crate) provider_config_version_id: ProviderConfigVersionId,
    pub(crate) runtime_product_id: RuntimeProductId,
    pub(crate) installation_id: InstallationId,
    pub(crate) runtime_connection_id: ConnectionId,
    pub(crate) runtime_provider_id: String,
    pub(crate) runtime_model_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct NativeTurnModelObservationInput {
    pub host_turn_id: HostTurnId,
    pub farfold_session_id: FarfoldSessionId,
    pub native_session_id: NativeSessionId,
    pub runtime: crate::runtime_registry::RuntimeBinding,
    pub runtime_generation: u64,
    pub runtime_provider_id: String,
    pub runtime_model_id: String,
    pub native_model_id: String,
    pub observed_at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TurnProviderBindingAuthority {
    CurrentAppliedProjection,
    ActiveRuntimeSessionBinding,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnectionRecord {
    pub(crate) provider_connection_id: ProviderConnectionId,
    pub(crate) provider_key: String,
    pub(crate) label: String,
    pub(crate) source: ProviderConnectionSource,
    pub(crate) current_config_version_id: ProviderConfigVersionId,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTargetProjectionRecord {
    pub(crate) provider_connection_id: ProviderConnectionId,
    pub(crate) runtime_product_id: RuntimeProductId,
    pub(crate) installation_id: InstallationId,
    pub(crate) runtime_connection_id: ConnectionId,
    pub(crate) config_version_id: ProviderConfigVersionId,
    pub(crate) runtime_provider_id: String,
    pub(crate) runtime_model_id: String,
    pub(crate) save_state: ProviderSaveState,
    pub(crate) apply_state: ProviderApplyState,
    pub(crate) request_state: ProviderRequestState,
    pub(crate) request_verified_version_id: Option<ProviderConfigVersionId>,
    pub(crate) active_task_policy: ProviderActiveTaskPolicy,
    pub(crate) detail: Option<String>,
    pub(crate) updated_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProjectionSnapshot {
    pub(crate) connection: ProviderConnectionRecord,
    pub(crate) projections: Vec<ProviderTargetProjectionRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderRequestVerificationOutcome {
    Recorded,
    StaleConfig,
}

#[derive(Clone, Copy)]
enum StaleProjectionPolicy {
    Reject,
    SkipVerifiedRequest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderConnectionVersionRecord {
    pub(crate) provider_connection_id: ProviderConnectionId,
    pub(crate) config_version_id: ProviderConfigVersionId,
    pub(crate) endpoint_fingerprint: String,
    pub(crate) credential_revision_fingerprint: String,
    pub(crate) model_mapping_fingerprint: String,
}

fn source_str(value: ProviderConnectionSource) -> &'static str {
    match value {
        ProviderConnectionSource::FarfoldManaged => "farfold_managed",
        ProviderConnectionSource::NativeUnmanaged => "native_unmanaged",
    }
}

fn save_state_str(value: ProviderSaveState) -> &'static str {
    match value {
        ProviderSaveState::NotSaved => "not_saved",
        ProviderSaveState::Saved => "saved",
        ProviderSaveState::Failed => "failed",
    }
}

fn apply_state_str(value: ProviderApplyState) -> &'static str {
    match value {
        ProviderApplyState::NotApplicable => "not_applicable",
        ProviderApplyState::Pending => "pending",
        ProviderApplyState::Applied => "applied",
        ProviderApplyState::NeedsRestart => "needs_restart",
        ProviderApplyState::Failed => "failed",
    }
}

fn request_state_str(value: ProviderRequestState) -> &'static str {
    match value {
        ProviderRequestState::NotRequested => "not_requested",
        ProviderRequestState::VerifiedSuccess => "verified_success",
        ProviderRequestState::VerifiedFailure => "verified_failure",
    }
}

fn active_task_policy_str(value: ProviderActiveTaskPolicy) -> &'static str {
    match value {
        ProviderActiveTaskPolicy::CurrentTaskKeepsBoundConfig => "current_task_keeps_bound_config",
        ProviderActiveTaskPolicy::AppliesImmediately => "applies_immediately",
    }
}

fn parse_source(value: String) -> Result<ProviderConnectionSource, String> {
    match value.as_str() {
        "farfold_managed" => Ok(ProviderConnectionSource::FarfoldManaged),
        "native_unmanaged" => Ok(ProviderConnectionSource::NativeUnmanaged),
        _ => Err(format!("Unknown Provider connection source {value}")),
    }
}

fn parse_save_state(value: String) -> Result<ProviderSaveState, String> {
    match value.as_str() {
        "not_saved" => Ok(ProviderSaveState::NotSaved),
        "saved" => Ok(ProviderSaveState::Saved),
        "failed" => Ok(ProviderSaveState::Failed),
        _ => Err(format!("Unknown Provider save state {value}")),
    }
}

fn parse_apply_state(value: String) -> Result<ProviderApplyState, String> {
    match value.as_str() {
        "not_applicable" => Ok(ProviderApplyState::NotApplicable),
        "pending" => Ok(ProviderApplyState::Pending),
        "applied" => Ok(ProviderApplyState::Applied),
        "needs_restart" => Ok(ProviderApplyState::NeedsRestart),
        "failed" => Ok(ProviderApplyState::Failed),
        _ => Err(format!("Unknown Provider apply state {value}")),
    }
}

fn parse_request_state(value: String) -> Result<ProviderRequestState, String> {
    match value.as_str() {
        "not_requested" => Ok(ProviderRequestState::NotRequested),
        "verified_success" => Ok(ProviderRequestState::VerifiedSuccess),
        "verified_failure" => Ok(ProviderRequestState::VerifiedFailure),
        _ => Err(format!("Unknown Provider request state {value}")),
    }
}

fn parse_active_task_policy(value: String) -> Result<ProviderActiveTaskPolicy, String> {
    match value.as_str() {
        "current_task_keeps_bound_config" => {
            Ok(ProviderActiveTaskPolicy::CurrentTaskKeepsBoundConfig)
        }
        "applies_immediately" => Ok(ProviderActiveTaskPolicy::AppliesImmediately),
        _ => Err(format!("Unknown Provider active task policy {value}")),
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

fn validate_fingerprint(field: &str, value: &str) -> Result<(), String> {
    validate_public_text(field, value, 200)?;
    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'@' | b'+')
    }) {
        return Err(format!("{field} contains an unsafe character"));
    }
    Ok(())
}

fn provider_version_id(input: &ProviderConnectionUpsertInput) -> ProviderConfigVersionId {
    ProviderConfigVersionId::parse(derived_host_id(
        "provider-version",
        &[
            input.provider_connection_id.as_str(),
            &input.provider_key,
            source_str(input.source),
            &input.endpoint_fingerprint,
            &input.credential_revision_fingerprint,
            &input.model_mapping_fingerprint,
        ],
    ))
    .expect("derived Provider version ID is valid")
}

impl HostDatabase {
    pub(crate) fn upsert_provider_connection(
        &mut self,
        input: &ProviderConnectionUpsertInput,
    ) -> Result<ProviderProjectionSnapshot, String> {
        validate_public_text("Provider key", &input.provider_key, 200)?;
        validate_public_text("Provider label", &input.label, 200)?;
        validate_fingerprint("Provider endpoint fingerprint", &input.endpoint_fingerprint)?;
        validate_fingerprint(
            "Provider credential revision fingerprint",
            &input.credential_revision_fingerprint,
        )?;
        validate_fingerprint(
            "Provider model mapping fingerprint",
            &input.model_mapping_fingerprint,
        )?;
        let now = now_millis();
        let version = provider_version_id(input);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin Provider connection update: {error}"))?;
        let previous_version: Option<String> = transaction
            .query_row(
                "SELECT current_config_version_id FROM provider_connections WHERE provider_connection_id = ?1",
                [input.provider_connection_id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Cannot read Provider connection: {error}"))?;
        transaction
            .execute(
                "INSERT INTO provider_connections(
                    provider_connection_id, provider_key, label, source, current_config_version_id,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(provider_connection_id) DO UPDATE SET
                    provider_key = excluded.provider_key,
                    label = excluded.label,
                    source = excluded.source,
                    current_config_version_id = excluded.current_config_version_id,
                    updated_at = excluded.updated_at",
                params![
                    input.provider_connection_id.as_str(),
                    input.provider_key,
                    input.label,
                    source_str(input.source),
                    version.as_str(),
                    now,
                ],
            )
            .map_err(|error| format!("Cannot write Provider connection: {error}"))?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO provider_connection_versions(
                    provider_connection_id, config_version_id, endpoint_fingerprint,
                    credential_revision_fingerprint, model_mapping_fingerprint, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    input.provider_connection_id.as_str(),
                    version.as_str(),
                    input.endpoint_fingerprint,
                    input.credential_revision_fingerprint,
                    input.model_mapping_fingerprint,
                    now,
                ],
            )
            .map_err(|error| format!("Cannot write Provider connection version: {error}"))?;
        if previous_version
            .as_deref()
            .is_some_and(|old| old != version.as_str())
        {
            transaction
                .execute(
                    "UPDATE provider_target_projections
                     SET config_version_id = ?2,
                         request_state = 'not_requested',
                         request_verified_version_id = NULL,
                         apply_state = CASE
                            WHEN apply_state IN ('applied', 'needs_restart') THEN 'pending'
                            ELSE apply_state
                         END,
                         updated_at = ?3
                     WHERE provider_connection_id = ?1",
                    params![input.provider_connection_id.as_str(), version.as_str(), now],
                )
                .map_err(|error| {
                    format!("Cannot invalidate Provider target projections: {error}")
                })?;
        }
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Provider connection update: {error}"))?;
        self.provider_projection_snapshot(&input.provider_connection_id)
    }

    pub(crate) fn record_provider_target_projection(
        &mut self,
        input: &ProviderTargetProjectionInput,
    ) -> Result<ProviderProjectionSnapshot, String> {
        self.record_provider_projection(input, StaleProjectionPolicy::Reject)?;
        self.provider_projection_snapshot(&input.provider_connection_id)
    }

    pub(crate) fn record_provider_request_verification_if_current(
        &mut self,
        input: &ProviderTargetProjectionInput,
    ) -> Result<ProviderRequestVerificationOutcome, String> {
        if input.request_state == ProviderRequestState::NotRequested {
            return Err("Conditional Provider verification requires a request result".into());
        }
        self.record_provider_projection(input, StaleProjectionPolicy::SkipVerifiedRequest)
    }

    fn record_provider_projection(
        &mut self,
        input: &ProviderTargetProjectionInput,
        stale_policy: StaleProjectionPolicy,
    ) -> Result<ProviderRequestVerificationOutcome, String> {
        if let Some(detail) = &input.detail {
            validate_public_text("Provider projection detail", detail, 1000)?;
        }
        validate_public_text("Runtime Provider ID", &input.runtime_provider_id, 200)?;
        validate_public_text("Runtime model ID", &input.runtime_model_id, 512)?;
        let now = now_millis();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin Provider projection update: {error}"))?;
        let (source, current_version): (String, String) = transaction
            .query_row(
                "SELECT source, current_config_version_id
                 FROM provider_connections WHERE provider_connection_id = ?1",
                [input.provider_connection_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("Cannot read Provider connection: {error}"))?
            .ok_or_else(|| "Unknown Provider connection".to_string())?;
        if source == source_str(ProviderConnectionSource::NativeUnmanaged)
            && input.request_state == ProviderRequestState::VerifiedSuccess
        {
            return Err(
                "Native unmanaged Provider configuration cannot be recorded as Farfold verified"
                    .to_string(),
            );
        }
        transaction
            .query_row(
                "SELECT 1 FROM runtime_connections
                 WHERE connection_id = ?1 AND installation_id = ?2 AND runtime_product_id = ?3",
                params![
                    input.runtime_connection_id.as_str(),
                    input.installation_id.as_str(),
                    input.runtime_product_id.as_str(),
                ],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| format!("Cannot verify target Runtime connection: {error}"))?
            .ok_or_else(|| {
                "Provider projection target Runtime connection is unknown".to_string()
            })?;
        let verified_version = match input.request_state {
            ProviderRequestState::VerifiedSuccess | ProviderRequestState::VerifiedFailure => {
                Some(input.request_verified_version_id.as_ref().ok_or_else(|| {
                    "Provider request verification must name the config version".to_string()
                })?)
            }
            ProviderRequestState::NotRequested => {
                if input.request_verified_version_id.is_some() {
                    return Err(
                        "Provider request verification version is only valid for verification results"
                            .to_string(),
                    );
                }
                None
            }
        };
        if verified_version
            .as_ref()
            .is_some_and(|version| version.as_str() != input.config_version_id.as_str())
        {
            return Err(
                "Provider request verification belongs to a stale config version".to_string(),
            );
        }
        if input.config_version_id.as_str() != current_version {
            if matches!(stale_policy, StaleProjectionPolicy::Reject) {
                return Err("Provider projection update targets a stale config version".into());
            }
            transaction.query_row(
                "SELECT 1 FROM provider_connection_versions WHERE provider_connection_id = ?1 AND config_version_id = ?2",
                params![input.provider_connection_id.as_str(), input.config_version_id.as_str()], |_| Ok(()),
            ).optional().map_err(|error| format!("Cannot verify historical Provider config: {error}"))?
                .ok_or("Provider request config does not belong to this connection")?;
            // The same IMMEDIATE transaction observes the winning save. A genuine
            // older request is skipped, while identity and storage errors still fail.
            return Ok(ProviderRequestVerificationOutcome::StaleConfig);
        }
        transaction
            .execute(
                "INSERT INTO provider_target_projections(
                    provider_connection_id, runtime_product_id, installation_id, runtime_connection_id,
                    config_version_id, runtime_provider_id, runtime_model_id, save_state, apply_state,
                    request_state, request_verified_version_id, active_task_policy, detail, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(provider_connection_id, runtime_product_id, installation_id, runtime_connection_id)
                 DO UPDATE SET
                    config_version_id = excluded.config_version_id,
                    runtime_provider_id = excluded.runtime_provider_id,
                    runtime_model_id = excluded.runtime_model_id,
                    save_state = excluded.save_state,
                    apply_state = excluded.apply_state,
                    request_state = excluded.request_state,
                    request_verified_version_id = excluded.request_verified_version_id,
                    active_task_policy = excluded.active_task_policy,
                    detail = excluded.detail,
                    updated_at = excluded.updated_at",
                params![
                    input.provider_connection_id.as_str(),
                    input.runtime_product_id.as_str(),
                    input.installation_id.as_str(),
                    input.runtime_connection_id.as_str(),
                    input.config_version_id.as_str(),
                    input.runtime_provider_id.as_str(),
                    input.runtime_model_id.as_str(),
                    save_state_str(input.save_state),
                    apply_state_str(input.apply_state),
                    request_state_str(input.request_state),
                    verified_version.map(|version| version.as_str()),
                    active_task_policy_str(input.active_task_policy),
                    input.detail,
                    now,
                ],
            )
            .map_err(|error| format!("Cannot write Provider target projection: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Provider projection update: {error}"))?;
        Ok(ProviderRequestVerificationOutcome::Recorded)
    }

    pub(crate) fn bind_turn_provider_config(
        &mut self,
        input: &TurnProviderBindingInput,
        authority: TurnProviderBindingAuthority,
    ) -> Result<(), String> {
        validate_public_text("Runtime Provider ID", &input.runtime_provider_id, 200)?;
        validate_public_text("Runtime model ID", &input.runtime_model_id, 512)?;
        match authority {
            TurnProviderBindingAuthority::CurrentAppliedProjection => {
                let apply_state: String = self
                    .connection
                    .query_row(
                        "SELECT apply_state
                         FROM provider_target_projections
                         WHERE provider_connection_id = ?1
                            AND config_version_id = ?2
                            AND runtime_product_id = ?3
                            AND installation_id = ?4
                            AND runtime_connection_id = ?5
                            AND runtime_provider_id = ?6
                            AND runtime_model_id = ?7",
                        params![
                            input.provider_connection_id.as_str(),
                            input.provider_config_version_id.as_str(),
                            input.runtime_product_id.as_str(),
                            input.installation_id.as_str(),
                            input.runtime_connection_id.as_str(),
                            input.runtime_provider_id.as_str(),
                            input.runtime_model_id.as_str(),
                        ],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| format!("Cannot verify Provider target projection: {error}"))?
                    .ok_or_else(|| {
                        "Host Turn Provider binding has no matching target projection".to_string()
                    })?;
                if apply_state != apply_state_str(ProviderApplyState::Applied) {
                    return Err(
                        "Host Turn Provider binding requires an applied target projection"
                            .to_string(),
                    );
                }
            }
            TurnProviderBindingAuthority::ActiveRuntimeSessionBinding => {
                let source: String = self
                    .connection
                    .query_row(
                        "SELECT provider_connections.source
                         FROM provider_connections
                         INNER JOIN provider_connection_versions
                            ON provider_connection_versions.provider_connection_id =
                                provider_connections.provider_connection_id
                         WHERE provider_connections.provider_connection_id = ?1
                            AND provider_connection_versions.config_version_id = ?2",
                        params![
                            input.provider_connection_id.as_str(),
                            input.provider_config_version_id.as_str(),
                        ],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| {
                        format!("Cannot verify Provider config version binding: {error}")
                    })?
                    .ok_or_else(|| {
                        "Host Turn Provider binding has no matching Provider config version"
                            .to_string()
                    })?;
                if parse_source(source)? != ProviderConnectionSource::FarfoldManaged {
                    return Err(
                        "Host Turn Provider binding requires a Farfold managed Provider version"
                            .to_string(),
                    );
                }
            }
        }
        let now = now_millis();
        self.connection
            .execute(
                "INSERT INTO turn_provider_bindings(
                    host_turn_id, provider_connection_id, provider_config_version_id,
                    runtime_product_id, installation_id, runtime_connection_id,
                    runtime_provider_id, runtime_model_id, bound_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    input.host_turn_id.as_str(),
                    input.provider_connection_id.as_str(),
                    input.provider_config_version_id.as_str(),
                    input.runtime_product_id.as_str(),
                    input.installation_id.as_str(),
                    input.runtime_connection_id.as_str(),
                    input.runtime_provider_id.as_str(),
                    input.runtime_model_id.as_str(),
                    now,
                ],
            )
            .map_err(|error| format!("Cannot bind Provider config to Host turn: {error}"))?;
        Ok(())
    }

    pub(crate) fn provider_projection_snapshot(
        &self,
        provider_connection_id: &ProviderConnectionId,
    ) -> Result<ProviderProjectionSnapshot, String> {
        let connection = self
            .connection
            .query_row(
                "SELECT provider_connection_id, provider_key, label, source,
                        current_config_version_id, created_at, updated_at
                 FROM provider_connections WHERE provider_connection_id = ?1",
                [provider_connection_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read Provider projection snapshot: {error}"))?
            .ok_or_else(|| "Unknown Provider connection".to_string())?;
        let connection = ProviderConnectionRecord {
            provider_connection_id: ProviderConnectionId::parse(connection.0)
                .map_err(|error| error.to_string())?,
            provider_key: connection.1,
            label: connection.2,
            source: parse_source(connection.3)?,
            current_config_version_id: ProviderConfigVersionId::parse(connection.4)
                .map_err(|error| error.to_string())?,
            created_at: connection.5,
            updated_at: connection.6,
        };
        let mut statement = self.connection.prepare(
            "SELECT provider_connection_id, runtime_product_id, installation_id, runtime_connection_id,
                    config_version_id, runtime_provider_id, runtime_model_id, save_state, apply_state, request_state,
                    request_verified_version_id, active_task_policy, detail, updated_at
             FROM provider_target_projections
             WHERE provider_connection_id = ?1
             ORDER BY runtime_product_id, installation_id, runtime_connection_id",
        ).map_err(|error| format!("Cannot read Provider target projections: {error}"))?;
        let rows = statement
            .query_map([provider_connection_id.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, i64>(13)?,
                ))
            })
            .map_err(|error| format!("Cannot read Provider target projections: {error}"))?;
        let projections = rows
            .map(|row| {
                let raw = row.map_err(|error| error.to_string())?;
                Ok(ProviderTargetProjectionRecord {
                    provider_connection_id: ProviderConnectionId::parse(raw.0)
                        .map_err(|error| error.to_string())?,
                    runtime_product_id: RuntimeProductId::parse(raw.1)
                        .map_err(|error| error.to_string())?,
                    installation_id: InstallationId::parse(raw.2)
                        .map_err(|error| error.to_string())?,
                    runtime_connection_id: ConnectionId::parse(raw.3)
                        .map_err(|error| error.to_string())?,
                    config_version_id: ProviderConfigVersionId::parse(raw.4)
                        .map_err(|error| error.to_string())?,
                    runtime_provider_id: raw.5,
                    runtime_model_id: raw.6,
                    save_state: parse_save_state(raw.7)?,
                    apply_state: parse_apply_state(raw.8)?,
                    request_state: parse_request_state(raw.9)?,
                    request_verified_version_id: raw
                        .10
                        .map(ProviderConfigVersionId::parse)
                        .transpose()
                        .map_err(|error| error.to_string())?,
                    active_task_policy: parse_active_task_policy(raw.11)?,
                    detail: raw.12,
                    updated_at: raw.13,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(ProviderProjectionSnapshot {
            connection,
            projections,
        })
    }

    pub(crate) fn provider_connection_version(
        &self,
        provider_connection_id: &ProviderConnectionId,
        config_version_id: &ProviderConfigVersionId,
    ) -> Result<ProviderConnectionVersionRecord, String> {
        let record = self
            .connection
            .query_row(
                "SELECT provider_connection_id, config_version_id, endpoint_fingerprint,
                        credential_revision_fingerprint, model_mapping_fingerprint
                 FROM provider_connection_versions
                 WHERE provider_connection_id = ?1 AND config_version_id = ?2",
                params![provider_connection_id.as_str(), config_version_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read Provider connection version: {error}"))?
            .ok_or_else(|| "Unknown Provider connection version".to_string())?;
        Ok(ProviderConnectionVersionRecord {
            provider_connection_id: ProviderConnectionId::parse(record.0)
                .map_err(|error| error.to_string())?,
            config_version_id: ProviderConfigVersionId::parse(record.1)
                .map_err(|error| error.to_string())?,
            endpoint_fingerprint: record.2,
            credential_revision_fingerprint: record.3,
            model_mapping_fingerprint: record.4,
        })
    }

    pub(crate) fn provider_connection_versions(
        &self,
        provider_connection_id: &ProviderConnectionId,
    ) -> Result<Vec<ProviderConnectionVersionRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT provider_connection_id, config_version_id, endpoint_fingerprint,
                        credential_revision_fingerprint, model_mapping_fingerprint
                 FROM provider_connection_versions
                 WHERE provider_connection_id = ?1
                 ORDER BY created_at DESC, config_version_id",
            )
            .map_err(|error| format!("Cannot list Provider connection versions: {error}"))?;
        let rows = statement
            .query_map([provider_connection_id.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| format!("Cannot list Provider connection versions: {error}"))?;
        rows.map(|row| {
            let raw = row.map_err(|error| error.to_string())?;
            Ok(ProviderConnectionVersionRecord {
                provider_connection_id: ProviderConnectionId::parse(raw.0)
                    .map_err(|error| error.to_string())?,
                config_version_id: ProviderConfigVersionId::parse(raw.1)
                    .map_err(|error| error.to_string())?,
                endpoint_fingerprint: raw.2,
                credential_revision_fingerprint: raw.3,
                model_mapping_fingerprint: raw.4,
            })
        })
        .collect()
    }

    pub(crate) fn provider_connections_by_source(
        &self,
        source: ProviderConnectionSource,
    ) -> Result<Vec<ProviderConnectionRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT provider_connection_id, provider_key, label, source,
                        current_config_version_id, created_at, updated_at
                 FROM provider_connections
                 WHERE source = ?1
                 ORDER BY updated_at DESC, provider_connection_id",
            )
            .map_err(|error| format!("Cannot list Provider connections: {error}"))?;
        let rows = statement
            .query_map([source_str(source)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .map_err(|error| format!("Cannot list Provider connections: {error}"))?;
        rows.map(|row| {
            let raw = row.map_err(|error| error.to_string())?;
            Ok(ProviderConnectionRecord {
                provider_connection_id: ProviderConnectionId::parse(raw.0)
                    .map_err(|error| error.to_string())?,
                provider_key: raw.1,
                label: raw.2,
                source: parse_source(raw.3)?,
                current_config_version_id: ProviderConfigVersionId::parse(raw.4)
                    .map_err(|error| error.to_string())?,
                created_at: raw.5,
                updated_at: raw.6,
            })
        })
        .collect()
    }
}

impl HostStore {
    pub(crate) fn upsert_provider_connection(
        &self,
        input: &ProviderConnectionUpsertInput,
    ) -> Result<ProviderProjectionSnapshot, String> {
        self.with_ready_database(|database| database.upsert_provider_connection(input))
    }

    pub(crate) fn record_provider_target_projection(
        &self,
        input: &ProviderTargetProjectionInput,
    ) -> Result<ProviderProjectionSnapshot, String> {
        self.with_ready_database(|database| database.record_provider_target_projection(input))
    }

    pub(crate) fn record_provider_request_verification_if_current(
        &self,
        input: &ProviderTargetProjectionInput,
    ) -> Result<ProviderRequestVerificationOutcome, String> {
        self.with_ready_database(|database| {
            database.record_provider_request_verification_if_current(input)
        })
    }

    pub(crate) fn bind_turn_provider_config(
        &self,
        input: &TurnProviderBindingInput,
        authority: TurnProviderBindingAuthority,
    ) -> Result<(), String> {
        self.with_ready_database(|database| database.bind_turn_provider_config(input, authority))
    }

    pub(crate) fn bind_native_turn_model_observation(
        &self,
        input: &NativeTurnModelObservationInput,
    ) -> Result<(), String> {
        validate_public_text("Runtime Provider ID", &input.runtime_provider_id, 200)?;
        validate_public_text("Runtime model ID", &input.runtime_model_id, 512)?;
        validate_public_text("Native model ID", &input.native_model_id, 512)?;
        let generation = i64::try_from(input.runtime_generation)
            .ok()
            .filter(|generation| *generation > 0)
            .ok_or("Native model observation requires a valid Runtime generation")?;
        let observed_at = i64::try_from(input.observed_at)
            .map_err(|_| "Native model observation timestamp is invalid")?;
        let bound_at = now_millis();
        if observed_at > bound_at {
            return Err("Native model observation cannot be from the future".into());
        }
        if input.runtime.product_id.as_str() == "pi"
            && (input.runtime_provider_id.starts_with("farfold-managed-")
                || input.runtime_model_id
                    != format!("{}/{}", input.runtime_provider_id, input.native_model_id))
        {
            return Err(
                "Pi native observation cannot substitute an unmatched managed source or model"
                    .into(),
            );
        }
        self.with_ready_database(|database| {
            database.connection.execute(
                "INSERT INTO turn_provider_bindings(
                    host_turn_id, source_kind, runtime_product_id, installation_id, runtime_connection_id,
                    runtime_provider_id, runtime_model_id, bound_at, farfold_session_id, native_session_id,
                    runtime_build_id, adapter_id, runtime_generation, native_model_id, observed_at
                 ) VALUES (?1, 'native_observation', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![input.host_turn_id.as_str(), input.runtime.product_id.as_str(), input.runtime.installation_id.as_str(),
                    input.runtime.connection_id.as_str(), input.runtime_provider_id, input.runtime_model_id, bound_at,
                    input.farfold_session_id.as_str(), input.native_session_id.as_str(), input.runtime.runtime_build_id.as_str(),
                    input.runtime.adapter_id.as_str(), generation, input.native_model_id, observed_at],
            ).map_err(|error| format!("Cannot bind native model observation to Host Turn: {error}"))?;
            Ok(())
        })
    }

    pub(crate) fn provider_projection_snapshot(
        &self,
        provider_connection_id: &ProviderConnectionId,
    ) -> Result<ProviderProjectionSnapshot, String> {
        self.with_ready_database(|database| {
            database.provider_projection_snapshot(provider_connection_id)
        })
    }

    pub(crate) fn provider_connection_version(
        &self,
        provider_connection_id: &ProviderConnectionId,
        config_version_id: &ProviderConfigVersionId,
    ) -> Result<ProviderConnectionVersionRecord, String> {
        self.with_ready_database(|database| {
            database.provider_connection_version(provider_connection_id, config_version_id)
        })
    }

    pub(crate) fn provider_connection_versions(
        &self,
        provider_connection_id: &ProviderConnectionId,
    ) -> Result<Vec<ProviderConnectionVersionRecord>, String> {
        self.with_ready_database(|database| {
            database.provider_connection_versions(provider_connection_id)
        })
    }

    pub(crate) fn provider_connections_by_source(
        &self,
        source: ProviderConnectionSource,
    ) -> Result<Vec<ProviderConnectionRecord>, String> {
        self.with_ready_database(|database| database.provider_connections_by_source(source))
    }

    #[cfg(test)]
    pub(crate) fn test_turn_provider_binding(
        &self,
        host_turn_id: &HostTurnId,
    ) -> Result<Option<(ProviderConfigVersionId, String, ConnectionId)>, String> {
        self.with_ready_database(|database| {
            database
                .connection
                .query_row(
                    "SELECT provider_config_version_id, runtime_model_id, runtime_connection_id
                     FROM turn_provider_bindings
                     WHERE host_turn_id = ?1",
                    [host_turn_id.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| error.to_string())?
                .map(|raw| {
                    Ok((
                        ProviderConfigVersionId::parse(raw.0).map_err(|error| error.to_string())?,
                        raw.1,
                        ConnectionId::parse(raw.2).map_err(|error| error.to_string())?,
                    ))
                })
                .transpose()
        })
    }
}

#[tauri::command]
pub fn host_provider_connection_upsert(
    store: tauri::State<'_, HostStore>,
    input: ProviderConnectionUpsertInput,
) -> Result<ProviderProjectionSnapshot, String> {
    store.upsert_provider_connection(&input)
}

#[tauri::command]
pub fn host_provider_projection_record(
    store: tauri::State<'_, HostStore>,
    input: ProviderTargetProjectionInput,
) -> Result<ProviderProjectionSnapshot, String> {
    store.record_provider_target_projection(&input)
}

#[tauri::command]
pub fn host_provider_projection_snapshot(
    store: tauri::State<'_, HostStore>,
    input: ProviderProjectionSnapshotInput,
) -> Result<ProviderProjectionSnapshot, String> {
    store.provider_projection_snapshot(&input.provider_connection_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        host_ids::{AdapterId, RuntimeBuildId},
        host_store::{
            HostDatabaseOpen,
            records::{RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration},
        },
        runtime_registry::PI_RUNTIME,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DATABASE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn ready(open: HostDatabaseOpen) -> HostDatabase {
        match open {
            HostDatabaseOpen::Ready(database) => database,
            HostDatabaseOpen::Recovery(recovery) => panic!("{}", recovery.reason()),
        }
    }

    fn test_database() -> HostDatabase {
        let path = std::env::temp_dir().join(format!(
            "farfold-provider-projection-{}-{}-{}.sqlite3",
            std::process::id(),
            now_millis(),
            TEST_DATABASE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&path);
        let mut database = ready(HostDatabaseOpen::open(path));
        database
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
        database
    }

    fn upsert(database: &mut HostDatabase, endpoint: &str) -> ProviderProjectionSnapshot {
        database
            .upsert_provider_connection(&ProviderConnectionUpsertInput {
                provider_connection_id: ProviderConnectionId::parse("provider-zai-primary")
                    .unwrap(),
                provider_key: "zai".to_string(),
                label: "Z.AI primary".to_string(),
                source: ProviderConnectionSource::FarfoldManaged,
                endpoint_fingerprint: endpoint.to_string(),
                credential_revision_fingerprint: "credential-revision-1".to_string(),
                model_mapping_fingerprint: "glm-4.5-air".to_string(),
            })
            .unwrap()
    }

    fn projection_input(
        version: ProviderConfigVersionId,
        request_state: ProviderRequestState,
        request_verified_version_id: Option<ProviderConfigVersionId>,
    ) -> ProviderTargetProjectionInput {
        ProviderTargetProjectionInput {
            provider_connection_id: ProviderConnectionId::parse("provider-zai-primary").unwrap(),
            config_version_id: version,
            runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
            installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
            runtime_connection_id: ConnectionId::parse(PI_RUNTIME.default_connection_id).unwrap(),
            runtime_provider_id: "zai".to_string(),
            runtime_model_id: "glm-4.5-air".to_string(),
            save_state: ProviderSaveState::Saved,
            apply_state: ProviderApplyState::Applied,
            request_state,
            request_verified_version_id,
            active_task_policy: ProviderActiveTaskPolicy::CurrentTaskKeepsBoundConfig,
            detail: None,
        }
    }

    #[test]
    fn config_update_invalidates_request_verification_without_losing_target_binding() {
        let mut database = test_database();
        let first = upsert(&mut database, "endpoint-a");
        let version = first.connection.current_config_version_id.clone();
        let verified = database
            .record_provider_target_projection(&projection_input(
                version.clone(),
                ProviderRequestState::VerifiedSuccess,
                Some(version.clone()),
            ))
            .unwrap();
        assert_eq!(
            verified.projections[0].request_state,
            ProviderRequestState::VerifiedSuccess
        );

        let changed = upsert(&mut database, "endpoint-b");
        assert_ne!(changed.connection.current_config_version_id, version);
        assert_eq!(
            changed.projections[0].request_state,
            ProviderRequestState::NotRequested
        );
        assert_eq!(changed.projections[0].request_verified_version_id, None);
        assert_eq!(
            changed.projections[0].apply_state,
            ProviderApplyState::Pending
        );
        assert_eq!(
            changed.projections[0].runtime_connection_id.as_str(),
            PI_RUNTIME.default_connection_id
        );
    }

    #[test]
    fn stale_or_unmanaged_verification_is_rejected() {
        let mut database = test_database();
        let first = upsert(&mut database, "endpoint-a");
        let changed = upsert(&mut database, "endpoint-b");
        let mut input = projection_input(
            changed.connection.current_config_version_id.clone(),
            ProviderRequestState::VerifiedSuccess,
            Some(first.connection.current_config_version_id),
        );
        assert!(
            database
                .record_provider_target_projection(&input)
                .unwrap_err()
                .contains("stale")
        );

        database
            .upsert_provider_connection(&ProviderConnectionUpsertInput {
                provider_connection_id: ProviderConnectionId::parse("native-pi-zai").unwrap(),
                provider_key: "zai".to_string(),
                label: "Native Z.AI".to_string(),
                source: ProviderConnectionSource::NativeUnmanaged,
                endpoint_fingerprint: "native".to_string(),
                credential_revision_fingerprint: "native".to_string(),
                model_mapping_fingerprint: "native".to_string(),
            })
            .unwrap();
        input.provider_connection_id = ProviderConnectionId::parse("native-pi-zai").unwrap();
        input.config_version_id = changed.connection.current_config_version_id.clone();
        input.request_verified_version_id = Some(changed.connection.current_config_version_id);
        assert!(
            database
                .record_provider_target_projection(&input)
                .unwrap_err()
                .contains("Native unmanaged")
        );
    }

    #[test]
    fn request_verification_skips_config_saved_after_prior_observation() {
        let mut database = test_database();
        let first = upsert(&mut database, "endpoint-a");
        let version = first.connection.current_config_version_id.clone();
        let input = projection_input(
            version.clone(),
            ProviderRequestState::VerifiedSuccess,
            Some(version),
        );
        let observed = database
            .provider_projection_snapshot(&input.provider_connection_id)
            .unwrap();
        assert_eq!(
            observed.connection.current_config_version_id,
            input.config_version_id
        );
        let next = upsert(&mut database, "endpoint-b");
        // Deterministically place save between the old Host helper's read and write.
        let recorded = database
            .record_provider_request_verification_if_current(&input)
            .unwrap();
        assert_eq!(
            recorded,
            super::ProviderRequestVerificationOutcome::StaleConfig
        );
        let current = database
            .provider_projection_snapshot(&input.provider_connection_id)
            .unwrap();
        assert_eq!(
            current.connection.current_config_version_id,
            next.connection.current_config_version_id
        );
        assert!(current.projections.is_empty());
        let mut wrong_target = input.clone();
        wrong_target.runtime_connection_id =
            ConnectionId::parse("not-a-runtime-connection").unwrap();
        assert!(
            database
                .record_provider_request_verification_if_current(&wrong_target)
                .is_err()
        );
        let mut wrong_version = input;
        wrong_version.config_version_id =
            ProviderConfigVersionId::parse("unknown-version").unwrap();
        wrong_version.request_verified_version_id = Some(wrong_version.config_version_id.clone());
        assert!(
            database
                .record_provider_request_verification_if_current(&wrong_version)
                .is_err()
        );

        let version = next.connection.current_config_version_id;
        let current_input = projection_input(
            version.clone(),
            ProviderRequestState::VerifiedSuccess,
            Some(version),
        );
        assert_eq!(
            database
                .record_provider_request_verification_if_current(&current_input)
                .unwrap(),
            super::ProviderRequestVerificationOutcome::Recorded
        );
        database
            .connection
            .execute_batch("DROP TABLE provider_target_projections")
            .unwrap();
        assert!(
            database
                .record_provider_request_verification_if_current(&current_input)
                .unwrap_err()
                .contains("Cannot write")
        );
    }

    #[test]
    fn turn_provider_binding_is_persisted_to_the_exact_config_version() {
        let mut database = test_database();
        let snapshot = upsert(&mut database, "endpoint-a");
        database
            .record_provider_target_projection(&projection_input(
                snapshot.connection.current_config_version_id.clone(),
                ProviderRequestState::NotRequested,
                None,
            ))
            .unwrap();
        database
            .bind_turn_provider_config(
                &TurnProviderBindingInput {
                    host_turn_id: HostTurnId::parse("turn-provider-bound").unwrap(),
                    provider_connection_id: snapshot.connection.provider_connection_id,
                    provider_config_version_id: snapshot
                        .connection
                        .current_config_version_id
                        .clone(),
                    runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
                    installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
                    runtime_connection_id: ConnectionId::parse(PI_RUNTIME.default_connection_id)
                        .unwrap(),
                    runtime_provider_id: "zai".to_string(),
                    runtime_model_id: "glm-4.5-air".to_string(),
                },
                TurnProviderBindingAuthority::CurrentAppliedProjection,
            )
            .unwrap();

        let stored: String = database
            .connection
            .query_row(
                "SELECT provider_config_version_id FROM turn_provider_bindings WHERE host_turn_id = 'turn-provider-bound'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stored,
            snapshot.connection.current_config_version_id.as_str()
        );
    }

    #[test]
    fn late_apply_result_for_old_config_cannot_update_the_current_projection() {
        let mut database = test_database();
        let first = upsert(&mut database, "endpoint-a");
        let _second = upsert(&mut database, "endpoint-b");

        let result = database.record_provider_target_projection(&projection_input(
            first.connection.current_config_version_id,
            ProviderRequestState::NotRequested,
            None,
        ));

        assert!(result.unwrap_err().contains("stale config version"));
    }

    #[test]
    fn historical_runtime_session_binding_uses_existing_managed_version_not_current_projection() {
        let mut database = test_database();
        let first = upsert(&mut database, "endpoint-a");
        let provider_connection_id = first.connection.provider_connection_id.clone();
        let first_version = first.connection.current_config_version_id.clone();
        database
            .record_provider_target_projection(&projection_input(
                first_version.clone(),
                ProviderRequestState::NotRequested,
                None,
            ))
            .unwrap();
        let second = upsert(&mut database, "endpoint-b");
        let binding = TurnProviderBindingInput {
            host_turn_id: HostTurnId::parse("turn-historical-provider-bound").unwrap(),
            provider_connection_id,
            provider_config_version_id: first_version.clone(),
            runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
            installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
            runtime_connection_id: ConnectionId::parse(PI_RUNTIME.default_connection_id).unwrap(),
            runtime_provider_id: "zai".to_string(),
            runtime_model_id: "glm-4.5-air".to_string(),
        };

        assert!(
            database
                .bind_turn_provider_config(
                    &binding,
                    TurnProviderBindingAuthority::CurrentAppliedProjection
                )
                .unwrap_err()
                .contains("no matching target projection")
        );
        database
            .bind_turn_provider_config(
                &binding,
                TurnProviderBindingAuthority::ActiveRuntimeSessionBinding,
            )
            .unwrap();

        let stored: (String, String) = database
            .connection
            .query_row(
                "SELECT provider_config_version_id, runtime_model_id
                 FROM turn_provider_bindings
                 WHERE host_turn_id = 'turn-historical-provider-bound'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored.0, first_version.as_str());
        assert_eq!(stored.1, "glm-4.5-air");
        assert_eq!(
            second.connection.current_config_version_id.as_str(),
            database
                .provider_projection_snapshot(&binding.provider_connection_id)
                .unwrap()
                .connection
                .current_config_version_id
                .as_str()
        );
    }

    #[test]
    fn turn_binding_requires_matching_applied_target_and_runtime_model() {
        let mut database = test_database();
        let snapshot = upsert(&mut database, "endpoint-a");
        let version = snapshot.connection.current_config_version_id.clone();
        database
            .record_provider_target_projection(&projection_input(
                version.clone(),
                ProviderRequestState::NotRequested,
                None,
            ))
            .unwrap();

        let mut binding = TurnProviderBindingInput {
            host_turn_id: HostTurnId::parse("turn-provider-bound").unwrap(),
            provider_connection_id: snapshot.connection.provider_connection_id,
            provider_config_version_id: version,
            runtime_product_id: RuntimeProductId::parse(PI_RUNTIME.product_id).unwrap(),
            installation_id: InstallationId::parse(PI_RUNTIME.installation_id).unwrap(),
            runtime_connection_id: ConnectionId::parse(PI_RUNTIME.default_connection_id).unwrap(),
            runtime_provider_id: "zai".to_string(),
            runtime_model_id: "wrong-model".to_string(),
        };
        assert!(
            database
                .bind_turn_provider_config(
                    &binding,
                    TurnProviderBindingAuthority::CurrentAppliedProjection
                )
                .unwrap_err()
                .contains("no matching target projection")
        );

        binding.runtime_model_id = "glm-4.5-air".to_string();
        database
            .bind_turn_provider_config(
                &binding,
                TurnProviderBindingAuthority::CurrentAppliedProjection,
            )
            .unwrap();
    }

    #[test]
    fn provider_key_or_source_change_invalidates_existing_verification() {
        let mut database = test_database();
        let first = upsert(&mut database, "endpoint-a");
        let version = first.connection.current_config_version_id.clone();
        database
            .record_provider_target_projection(&projection_input(
                version.clone(),
                ProviderRequestState::VerifiedSuccess,
                Some(version),
            ))
            .unwrap();

        let changed = database
            .upsert_provider_connection(&ProviderConnectionUpsertInput {
                provider_connection_id: ProviderConnectionId::parse("provider-zai-primary")
                    .unwrap(),
                provider_key: "zai-renamed".to_string(),
                label: "Z.AI renamed".to_string(),
                source: ProviderConnectionSource::FarfoldManaged,
                endpoint_fingerprint: "endpoint-a".to_string(),
                credential_revision_fingerprint: "credential-revision-1".to_string(),
                model_mapping_fingerprint: "glm-4.5-air".to_string(),
            })
            .unwrap();

        assert_ne!(
            changed.connection.current_config_version_id,
            first.connection.current_config_version_id
        );
        assert_eq!(
            changed.projections[0].request_state,
            ProviderRequestState::NotRequested
        );
        assert_eq!(changed.projections[0].request_verified_version_id, None);
    }

    #[test]
    fn credential_revision_change_invalidates_existing_verification_without_storing_the_secret() {
        let mut database = test_database();
        let first = upsert(&mut database, "endpoint-a");
        let version = first.connection.current_config_version_id.clone();
        database
            .record_provider_target_projection(&projection_input(
                version.clone(),
                ProviderRequestState::VerifiedSuccess,
                Some(version),
            ))
            .unwrap();

        let changed = database
            .upsert_provider_connection(&ProviderConnectionUpsertInput {
                provider_connection_id: ProviderConnectionId::parse("provider-zai-primary")
                    .unwrap(),
                provider_key: "zai".to_string(),
                label: "Z.AI primary".to_string(),
                source: ProviderConnectionSource::FarfoldManaged,
                endpoint_fingerprint: "endpoint-a".to_string(),
                credential_revision_fingerprint: "credential-revision-2".to_string(),
                model_mapping_fingerprint: "glm-4.5-air".to_string(),
            })
            .unwrap();

        assert_ne!(
            changed.connection.current_config_version_id,
            first.connection.current_config_version_id
        );
        assert_eq!(
            changed.projections[0].request_state,
            ProviderRequestState::NotRequested
        );
        assert_eq!(
            changed.projections[0].apply_state,
            ProviderApplyState::Pending
        );
        let stored_fingerprint: String = database
            .connection
            .query_row(
                "SELECT credential_revision_fingerprint
                 FROM provider_connection_versions
                 WHERE config_version_id = ?1",
                [changed.connection.current_config_version_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_fingerprint, "credential-revision-2");
        assert!(!stored_fingerprint.contains("secret"));
    }
}
