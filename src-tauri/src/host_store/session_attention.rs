use super::{HostDatabase, HostStore, now_millis};
use crate::{
    host_ids::{FarfoldSessionId, NativeSessionId, derived_host_id},
    host_store::records::WriteOutcome,
    runtime_registry::RuntimeBinding,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionAttentionKind {
    RuntimeInteraction,
    OutcomeUnknown,
    ReconciliationRequired,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionAttentionStatus {
    Open,
    Closed,
    Stale,
}

#[derive(Debug, Clone)]
pub(crate) struct OpenSessionAttention<'a> {
    pub farfold_session_id: &'a FarfoldSessionId,
    pub kind: SessionAttentionKind,
    pub runtime_generation: u64,
    pub native_interaction_id: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttention {
    pub(crate) attention_id: String,
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) kind: SessionAttentionKind,
    pub(crate) runtime_generation: u64,
    pub(crate) native_interaction_id: Option<String>,
    pub(crate) status: SessionAttentionStatus,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

impl SessionAttentionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeInteraction => "runtime_interaction",
            Self::OutcomeUnknown => "outcome_unknown",
            Self::ReconciliationRequired => "reconciliation_required",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "runtime_interaction" => Ok(Self::RuntimeInteraction),
            "outcome_unknown" => Ok(Self::OutcomeUnknown),
            "reconciliation_required" => Ok(Self::ReconciliationRequired),
            _ => Err(format!("Unknown Session attention kind {value}")),
        }
    }
}

impl SessionAttentionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Stale => "stale",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "open" => Ok(Self::Open),
            "closed" => Ok(Self::Closed),
            "stale" => Ok(Self::Stale),
            _ => Err(format!("Unknown Session attention status {value}")),
        }
    }
}

impl HostStore {
    pub(crate) fn resolve_farfold_session(
        &self,
        definition: impl Into<RuntimeBinding>,
        native_session_id: &NativeSessionId,
    ) -> Result<Option<FarfoldSessionId>, String> {
        self.with_ready_database(|database| {
            resolve_farfold_session(database, definition, native_session_id)
        })
    }

    pub(crate) fn open_session_attention(
        &self,
        input: OpenSessionAttention<'_>,
    ) -> Result<(SessionAttention, WriteOutcome), String> {
        self.with_ready_database(|database| open_attention(database, input))
    }

    pub(crate) fn transition_matching_session_attention(
        &self,
        input: OpenSessionAttention<'_>,
        target: SessionAttentionStatus,
    ) -> Result<Option<SessionAttention>, String> {
        validate_attention(&input)?;
        let attention_id = attention_id(&input);
        self.with_ready_database(|database| {
            if read_attention(&database.connection, &attention_id)?.is_none() {
                return Ok(None);
            }
            transition_attention(database, &attention_id, target).map(Some)
        })
    }

    pub fn session_attention_snapshot(&self) -> Result<Vec<SessionAttention>, String> {
        self.with_ready_database(snapshot)
    }
}

fn resolve_farfold_session(
    database: &mut HostDatabase,
    definition: impl Into<RuntimeBinding>,
    native_session_id: &NativeSessionId,
) -> Result<Option<FarfoldSessionId>, String> {
    let definition = definition.into();
    database
        .connection
        .query_row(
            "SELECT farfold_session_id
             FROM sessions
             WHERE runtime_product_id = ?1
               AND installation_id = ?2
               AND adapter_id = ?3
               AND connection_id = ?4
               AND native_session_id = ?5
               AND runtime_build_id = ?6
               AND archived_at IS NULL",
            params![
                definition.product_id.as_str(),
                definition.installation_id.as_str(),
                definition.adapter_id.as_str(),
                definition.connection_id.as_str(),
                native_session_id.as_str(),
                definition.runtime_build_id.as_str()
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot resolve Farfold Session binding: {error}"))?
        .map(FarfoldSessionId::parse)
        .transpose()
        .map_err(|error| error.to_string())
}

fn validate_attention(input: &OpenSessionAttention<'_>) -> Result<i64, String> {
    let runtime_generation = i64::try_from(input.runtime_generation)
        .map_err(|_| "Runtime generation is out of range".to_string())?;
    if input.kind == SessionAttentionKind::RuntimeInteraction
        && input
            .native_interaction_id
            .is_none_or(|id| id.trim().is_empty())
    {
        return Err("Runtime interaction attention requires a native interaction ID".to_string());
    }
    if input
        .native_interaction_id
        .is_some_and(|id| id.len() > 200 || id.contains('\0'))
    {
        return Err("Native interaction ID is invalid".to_string());
    }
    Ok(runtime_generation)
}

fn attention_id(input: &OpenSessionAttention<'_>) -> String {
    derived_host_id(
        "attention",
        &[
            input.farfold_session_id.as_str(),
            input.kind.as_str(),
            &input.runtime_generation.to_string(),
            input.native_interaction_id.unwrap_or(""),
        ],
    )
}

fn open_attention(
    database: &mut HostDatabase,
    input: OpenSessionAttention<'_>,
) -> Result<(SessionAttention, WriteOutcome), String> {
    let runtime_generation = validate_attention(&input)?;
    let attention_id = attention_id(&input);
    let timestamp = now_millis();
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin Session attention write: {error}"))?;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO session_attention(
                attention_id, farfold_session_id, kind, runtime_generation,
                native_interaction_id, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?6)",
            params![
                attention_id,
                input.farfold_session_id.as_str(),
                input.kind.as_str(),
                runtime_generation,
                input.native_interaction_id,
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot open Session attention: {error}"))?
        > 0;
    let attention = read_attention(&transaction, &attention_id)?.ok_or_else(|| {
        "Session attention identity is already bound to invalid metadata".to_string()
    })?;
    if attention.farfold_session_id != *input.farfold_session_id
        || attention.kind != input.kind
        || attention.runtime_generation != input.runtime_generation
        || attention.native_interaction_id.as_deref() != input.native_interaction_id
    {
        return Err("Session attention ID is already bound to different metadata".to_string());
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Session attention: {error}"))?;
    Ok((
        attention,
        if inserted {
            WriteOutcome::Inserted
        } else {
            WriteOutcome::AlreadyPresent
        },
    ))
}

fn transition_attention(
    database: &mut HostDatabase,
    attention_id: &str,
    target: SessionAttentionStatus,
) -> Result<SessionAttention, String> {
    if target == SessionAttentionStatus::Open {
        return Err("A terminal Session attention cannot be reopened".to_string());
    }
    let timestamp = now_millis();
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin Session attention transition: {error}"))?;
    transaction
        .execute(
            "UPDATE session_attention
             SET status = ?1, updated_at = ?2
             WHERE attention_id = ?3 AND status = 'open'",
            params![target.as_str(), timestamp, attention_id],
        )
        .map_err(|error| format!("Cannot transition Session attention: {error}"))?;
    let attention = read_attention(&transaction, attention_id)?
        .ok_or_else(|| "Session attention does not exist".to_string())?;
    if attention.status != target {
        return Err(format!(
            "Session attention is already terminal as {}",
            attention.status.as_str()
        ));
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Session attention transition: {error}"))?;
    Ok(attention)
}

fn read_attention(
    connection: &rusqlite::Connection,
    attention_id: &str,
) -> Result<Option<SessionAttention>, String> {
    let attention = connection
        .query_row(
            "SELECT attention_id, farfold_session_id, kind, runtime_generation,
                    native_interaction_id, status, created_at, updated_at
             FROM session_attention WHERE attention_id = ?1",
            [attention_id],
            parse_attention,
        )
        .optional()
        .map_err(|error| format!("Cannot read Session attention: {error}"))?;
    attention.transpose()
}

fn parse_attention(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<SessionAttention, String>> {
    let farfold_session_id = row.get::<_, String>(1)?;
    let kind = row.get::<_, String>(2)?;
    let runtime_generation = row.get::<_, i64>(3)?;
    let status = row.get::<_, String>(5)?;
    Ok((|| {
        Ok(SessionAttention {
            attention_id: row.get::<_, String>(0).map_err(|error| error.to_string())?,
            farfold_session_id: FarfoldSessionId::parse(farfold_session_id)
                .map_err(|error| error.to_string())?,
            kind: SessionAttentionKind::parse(&kind)?,
            runtime_generation: u64::try_from(runtime_generation)
                .map_err(|_| "Stored Runtime generation is invalid".to_string())?,
            native_interaction_id: row
                .get::<_, Option<String>>(4)
                .map_err(|error| error.to_string())?,
            status: SessionAttentionStatus::parse(&status)?,
            created_at: row.get::<_, i64>(6).map_err(|error| error.to_string())?,
            updated_at: row.get::<_, i64>(7).map_err(|error| error.to_string())?,
        })
    })())
}

fn snapshot(database: &mut HostDatabase) -> Result<Vec<SessionAttention>, String> {
    let mut statement = database
        .connection
        .prepare(
            "SELECT attention_id, farfold_session_id, kind, runtime_generation,
                    native_interaction_id, status, created_at, updated_at
             FROM session_attention
             ORDER BY status = 'open' DESC, updated_at DESC, attention_id ASC",
        )
        .map_err(|error| format!("Cannot prepare Session attention snapshot: {error}"))?;
    statement
        .query_map([], parse_attention)
        .map_err(|error| format!("Cannot query Session attention snapshot: {error}"))?
        .map(|row| row.map_err(|error| format!("Cannot read Session attention row: {error}"))?)
        .collect()
}

#[tauri::command]
pub fn session_attention_snapshot(
    store: State<'_, HostStore>,
) -> Result<Vec<SessionAttention>, String> {
    store.session_attention_snapshot()
}

#[cfg(test)]
mod tests {
    use super::{
        OpenSessionAttention, SessionAttentionKind, SessionAttentionStatus, open_attention,
        resolve_farfold_session, snapshot, transition_attention,
    };
    use crate::{
        host_ids::{
            AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
            RuntimeBuildId, RuntimeProductId, WorkingCopyId,
        },
        host_store::{
            HostDatabase, HostDatabaseOpen,
            records::{
                RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration,
                SessionRegistration, SessionTitleSource, WorkingCopyKind, WriteOutcome,
            },
        },
        runtime_registry::PI_ACP_RUNTIME,
    };
    use std::{fs, path::PathBuf};

    struct TestStore(PathBuf);

    impl TestStore {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "farfold-session-attention-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn database(&self) -> HostDatabase {
            match HostDatabaseOpen::open(self.0.join("host.sqlite3")) {
                HostDatabaseOpen::Ready(database) => database,
                HostDatabaseOpen::Recovery(recovery) => panic!("{}", recovery.reason()),
            }
        }
    }

    impl Drop for TestStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn register_session(database: &mut HostDatabase, root: &TestStore) -> FarfoldSessionId {
        database
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(PI_ACP_RUNTIME.product_id).unwrap(),
                display_name: PI_ACP_RUNTIME.display_name.to_string(),
                installation_id: InstallationId::parse(PI_ACP_RUNTIME.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(PI_ACP_RUNTIME.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(PI_ACP_RUNTIME.adapter_id).unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: PI_ACP_RUNTIME.version.to_string(),
                artifact_sha256: PI_ACP_RUNTIME.binary_sha256.to_string(),
                connection_id: ConnectionId::parse(PI_ACP_RUNTIME.default_connection_id).unwrap(),
                connection_label: "Pi native configuration".to_string(),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();
        let project = root.0.join("project");
        fs::create_dir_all(&project).unwrap();
        let farfold_session_id = FarfoldSessionId::parse("farfold-session-1").unwrap();
        database
            .register_session(&SessionRegistration {
                farfold_session_id: farfold_session_id.clone(),
                runtime_product_id: RuntimeProductId::parse(PI_ACP_RUNTIME.product_id).unwrap(),
                installation_id: InstallationId::parse(PI_ACP_RUNTIME.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(PI_ACP_RUNTIME.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(PI_ACP_RUNTIME.adapter_id).unwrap(),
                connection_id: ConnectionId::parse(PI_ACP_RUNTIME.default_connection_id).unwrap(),
                project_id: ProjectId::parse("project-1").unwrap(),
                project_path: project.clone(),
                project_name: "Project".to_string(),
                working_copy_id: WorkingCopyId::parse("working-copy-1").unwrap(),
                working_copy_path: project,
                working_copy_kind: WorkingCopyKind::Root,
                branch_name: None,
                native_session_id: NativeSessionId::parse("native-session-1").unwrap(),
                title: "Session".to_string(),
                title_source: SessionTitleSource::Native,
                created_at: 2,
                updated_at: 2,
            })
            .unwrap();
        farfold_session_id
    }

    #[test]
    fn attention_is_deterministic_bounded_metadata_and_idempotent() {
        let root = TestStore::new("idempotent");
        let mut database = root.database();
        let session_id = register_session(&mut database, &root);

        let first = open_attention(
            &mut database,
            OpenSessionAttention {
                farfold_session_id: &session_id,
                kind: SessionAttentionKind::RuntimeInteraction,
                runtime_generation: 7,
                native_interaction_id: Some("dialog-1"),
            },
        )
        .unwrap();
        let second = open_attention(
            &mut database,
            OpenSessionAttention {
                farfold_session_id: &session_id,
                kind: SessionAttentionKind::RuntimeInteraction,
                runtime_generation: 7,
                native_interaction_id: Some("dialog-1"),
            },
        )
        .unwrap();

        assert_eq!(first.1, WriteOutcome::Inserted);
        assert_eq!(second.1, WriteOutcome::AlreadyPresent);
        assert_eq!(first.0, second.0);
        assert_eq!(snapshot(&mut database).unwrap(), vec![first.0]);
    }

    #[test]
    fn terminal_attention_cannot_be_reopened_or_retargeted() {
        let root = TestStore::new("terminal");
        let mut database = root.database();
        let session_id = register_session(&mut database, &root);
        let (opened, _) = open_attention(
            &mut database,
            OpenSessionAttention {
                farfold_session_id: &session_id,
                kind: SessionAttentionKind::OutcomeUnknown,
                runtime_generation: 8,
                native_interaction_id: None,
            },
        )
        .unwrap();

        let closed = transition_attention(
            &mut database,
            &opened.attention_id,
            SessionAttentionStatus::Closed,
        )
        .unwrap();
        assert_eq!(closed.status, SessionAttentionStatus::Closed);
        assert!(
            transition_attention(
                &mut database,
                &opened.attention_id,
                SessionAttentionStatus::Stale
            )
            .unwrap_err()
            .contains("already terminal")
        );
        let reopened = open_attention(
            &mut database,
            OpenSessionAttention {
                farfold_session_id: &session_id,
                kind: SessionAttentionKind::OutcomeUnknown,
                runtime_generation: 8,
                native_interaction_id: None,
            },
        )
        .unwrap();
        assert_eq!(reopened.0.status, SessionAttentionStatus::Closed);
        assert_eq!(reopened.1, WriteOutcome::AlreadyPresent);
    }

    #[test]
    fn native_session_resolution_is_exact_and_excludes_archived_sessions() {
        let root = TestStore::new("resolution");
        let mut database = root.database();
        let session_id = register_session(&mut database, &root);
        let native_session_id = NativeSessionId::parse("native-session-1").unwrap();

        assert_eq!(
            resolve_farfold_session(&mut database, PI_ACP_RUNTIME, &native_session_id).unwrap(),
            Some(session_id)
        );
        let mut wrong_build = crate::runtime_registry::RuntimeBinding::from(PI_ACP_RUNTIME);
        wrong_build.runtime_build_id =
            crate::host_ids::RuntimeBuildId::parse("pi@another-build").unwrap();
        assert_eq!(
            resolve_farfold_session(&mut database, wrong_build, &native_session_id).unwrap(),
            None
        );
        database
            .connection
            .execute(
                "UPDATE sessions SET archived_at = 3 WHERE farfold_session_id = 'farfold-session-1'",
                [],
            )
            .unwrap();
        assert_eq!(
            resolve_farfold_session(&mut database, PI_ACP_RUNTIME, &native_session_id).unwrap(),
            None
        );
    }

    #[test]
    fn runtime_interaction_requires_native_identity_and_existing_session() {
        let root = TestStore::new("validation");
        let mut database = root.database();
        let session_id = FarfoldSessionId::parse("missing-session").unwrap();

        assert!(
            open_attention(
                &mut database,
                OpenSessionAttention {
                    farfold_session_id: &session_id,
                    kind: SessionAttentionKind::RuntimeInteraction,
                    runtime_generation: 1,
                    native_interaction_id: None,
                }
            )
            .unwrap_err()
            .contains("requires a native interaction ID")
        );
        assert!(
            open_attention(
                &mut database,
                OpenSessionAttention {
                    farfold_session_id: &session_id,
                    kind: SessionAttentionKind::ReconciliationRequired,
                    runtime_generation: 1,
                    native_interaction_id: None,
                }
            )
            .unwrap_err()
            .contains("FOREIGN KEY constraint failed")
        );
    }
}
