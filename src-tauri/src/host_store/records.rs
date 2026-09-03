use super::{HostDatabase, now_millis};
use crate::host_ids::{
    AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
    RuntimeBuildId, RuntimeProductId, WorkingCopyId,
};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeDistribution {
    Managed,
    System,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeConnectionKind {
    ManagedLocal,
    SystemLocal,
    Remote,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkingCopyKind {
    Root,
    Worktree,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionTitleSource {
    Native,
    FirstUser,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOutcome {
    Inserted,
    AlreadyPresent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeSessionLocatorKind {
    PiSessionFile,
}

#[derive(Debug, Clone)]
pub struct NativeSessionLocatorRegistration {
    pub kind: NativeSessionLocatorKind,
    pub locator_path: PathBuf,
    pub allowed_root: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RuntimeRegistration {
    pub runtime_product_id: RuntimeProductId,
    pub display_name: String,
    pub installation_id: InstallationId,
    pub runtime_build_id: RuntimeBuildId,
    pub adapter_id: AdapterId,
    pub distribution: RuntimeDistribution,
    pub observed_version: String,
    pub artifact_sha256: String,
    pub connection_id: ConnectionId,
    pub connection_label: String,
    pub connection_kind: RuntimeConnectionKind,
    pub created_at: i64,
    pub verified_at: i64,
}

#[derive(Debug, Clone)]
pub struct SessionRegistration {
    pub farfold_session_id: FarfoldSessionId,
    pub runtime_product_id: RuntimeProductId,
    pub installation_id: InstallationId,
    pub runtime_build_id: RuntimeBuildId,
    pub adapter_id: AdapterId,
    pub connection_id: ConnectionId,
    pub project_id: ProjectId,
    pub project_path: PathBuf,
    pub project_name: String,
    pub working_copy_id: WorkingCopyId,
    pub working_copy_path: PathBuf,
    pub working_copy_kind: WorkingCopyKind,
    pub branch_name: Option<String>,
    pub native_session_id: NativeSessionId,
    pub title: String,
    pub title_source: SessionTitleSource,
    pub created_at: i64,
    pub updated_at: i64,
}

impl RuntimeDistribution {
    fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::System => "system",
            Self::Remote => "remote",
        }
    }
}

impl RuntimeConnectionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::ManagedLocal => "managed_local",
            Self::SystemLocal => "system_local",
            Self::Remote => "remote",
        }
    }
}

impl WorkingCopyKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Root => "root",
            Self::Worktree => "worktree",
        }
    }

    pub(super) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "root" => Ok(Self::Root),
            "worktree" => Ok(Self::Worktree),
            _ => Err(format!("Unknown Working Copy kind {value}")),
        }
    }
}

impl SessionTitleSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::FirstUser => "first_user",
            Self::Manual => "manual",
        }
    }

    pub(super) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "native" => Ok(Self::Native),
            "first_user" => Ok(Self::FirstUser),
            "manual" => Ok(Self::Manual),
            _ => Err(format!("Unknown Session title source {value}")),
        }
    }
}

impl NativeSessionLocatorKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::PiSessionFile => "pi_session_file",
        }
    }
}

impl HostDatabase {
    pub fn register_runtime(
        &mut self,
        registration: &RuntimeRegistration,
    ) -> Result<WriteOutcome, String> {
        validate_runtime_registration(registration)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin Runtime registration: {error}"))?;
        let inserted = register_runtime(&transaction, registration)?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Runtime registration: {error}"))?;
        Ok(if inserted {
            WriteOutcome::Inserted
        } else {
            WriteOutcome::AlreadyPresent
        })
    }

    pub fn register_session(
        &mut self,
        registration: &SessionRegistration,
    ) -> Result<WriteOutcome, String> {
        self.register_session_internal(registration, None, false)
    }

    pub fn register_active_session(
        &mut self,
        registration: &SessionRegistration,
    ) -> Result<WriteOutcome, String> {
        self.register_session_internal(registration, None, true)
    }

    pub fn register_session_with_native_locator(
        &mut self,
        registration: &SessionRegistration,
        locator: &NativeSessionLocatorRegistration,
    ) -> Result<WriteOutcome, String> {
        self.register_session_internal(registration, Some(locator), false)
    }

    pub fn register_active_session_with_native_locator(
        &mut self,
        registration: &SessionRegistration,
        locator: &NativeSessionLocatorRegistration,
    ) -> Result<WriteOutcome, String> {
        self.register_session_internal(registration, Some(locator), true)
    }

    fn register_session_internal(
        &mut self,
        registration: &SessionRegistration,
        locator: Option<&NativeSessionLocatorRegistration>,
        activate: bool,
    ) -> Result<WriteOutcome, String> {
        validate_session_registration(registration)?;
        let project_path = canonical_directory(&registration.project_path, "Project")?;
        let working_copy_path =
            canonical_directory(&registration.working_copy_path, "Working Copy")?;
        let locator_value = locator.map(canonical_native_locator).transpose()?;
        let project_path = project_path.to_string_lossy().into_owned();
        let working_copy_path = working_copy_path.to_string_lossy().into_owned();
        let locator_value = locator_value.map(|path| path.to_string_lossy().into_owned());

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin Session registration: {error}"))?;
        ensure_project(
            &transaction,
            registration,
            &project_path,
            &working_copy_path,
        )?;
        let session_inserted = insert_or_validate_session(&transaction, registration)?;
        let locator_inserted = locator
            .zip(locator_value.as_deref())
            .map(|(locator, value)| {
                insert_or_validate_native_locator(&transaction, registration, locator, value)
            })
            .transpose()?
            .unwrap_or(false);
        if activate {
            activate_session(&transaction, registration, now_millis())?;
        }
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Session registration: {error}"))?;
        Ok(if session_inserted || locator_inserted {
            WriteOutcome::Inserted
        } else {
            WriteOutcome::AlreadyPresent
        })
    }
}

impl super::HostStore {
    pub fn register_runtime(
        &self,
        registration: &RuntimeRegistration,
    ) -> Result<WriteOutcome, String> {
        self.with_ready_database(|database| database.register_runtime(registration))
    }

    pub fn register_session(
        &self,
        registration: &SessionRegistration,
    ) -> Result<WriteOutcome, String> {
        self.with_ready_database(|database| database.register_session(registration))
    }

    pub fn register_active_session(
        &self,
        registration: &SessionRegistration,
    ) -> Result<WriteOutcome, String> {
        self.with_ready_database(|database| database.register_active_session(registration))
    }

    pub fn register_session_with_native_locator(
        &self,
        registration: &SessionRegistration,
        locator: &NativeSessionLocatorRegistration,
    ) -> Result<WriteOutcome, String> {
        self.with_ready_database(|database| {
            database.register_session_with_native_locator(registration, locator)
        })
    }

    pub fn register_active_session_with_native_locator(
        &self,
        registration: &SessionRegistration,
        locator: &NativeSessionLocatorRegistration,
    ) -> Result<WriteOutcome, String> {
        self.with_ready_database(|database| {
            database.register_active_session_with_native_locator(registration, locator)
        })
    }
}

fn validate_runtime_registration(registration: &RuntimeRegistration) -> Result<(), String> {
    validate_text("Runtime display name", &registration.display_name, 200)?;
    validate_text("Runtime version", &registration.observed_version, 200)?;
    validate_text(
        "Runtime connection label",
        &registration.connection_label,
        200,
    )?;
    if registration.artifact_sha256.len() != 64
        || !registration
            .artifact_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(
            "Runtime artifact SHA-256 must be 64 lowercase hexadecimal characters".to_string(),
        );
    }
    validate_timestamps(registration.created_at, registration.verified_at)
}

fn validate_session_registration(registration: &SessionRegistration) -> Result<(), String> {
    validate_text("Project name", &registration.project_name, 500)?;
    validate_text("Session title", &registration.title, 500)?;
    if registration
        .branch_name
        .as_ref()
        .is_some_and(|branch| branch.len() > 500 || branch.contains('\0'))
    {
        return Err("Working Copy branch name is invalid".to_string());
    }
    validate_timestamps(registration.created_at, registration.updated_at)
}

fn validate_text(field: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} cannot be empty"));
    }
    if value.len() > max_bytes {
        return Err(format!("{field} is too long"));
    }
    if value.contains('\0') {
        return Err(format!("{field} contains a null byte"));
    }
    Ok(())
}

fn validate_timestamps(created_at: i64, updated_at: i64) -> Result<(), String> {
    if created_at < 0 || updated_at < created_at {
        return Err("Host timestamps are invalid".to_string());
    }
    Ok(())
}

fn canonical_directory(path: &Path, kind: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve {kind}: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("{kind} is not a directory"));
    }
    Ok(canonical)
}

fn canonical_native_locator(
    registration: &NativeSessionLocatorRegistration,
) -> Result<PathBuf, String> {
    let allowed_root = canonical_directory(&registration.allowed_root, "native Session root")?;
    let locator = registration
        .locator_path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve native Session locator: {error}"))?;
    if !locator.is_file() || !locator.starts_with(&allowed_root) {
        return Err("Native Session locator is outside its managed root".to_string());
    }
    match registration.kind {
        NativeSessionLocatorKind::PiSessionFile
            if locator
                .extension()
                .is_none_or(|extension| extension != "jsonl") =>
        {
            Err("Pi native Session locator is not a JSONL file".to_string())
        }
        _ => Ok(locator),
    }
}

fn register_runtime(
    transaction: &Transaction<'_>,
    registration: &RuntimeRegistration,
) -> Result<bool, String> {
    let product_inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runtime_products(
                runtime_product_id, display_name, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4)",
            params![
                registration.runtime_product_id.as_str(),
                registration.display_name,
                registration.created_at,
                registration.verified_at
            ],
        )
        .map_err(|error| format!("Cannot register Runtime product: {error}"))?
        > 0;
    require_exact_row(
        transaction,
        "SELECT display_name FROM runtime_products WHERE runtime_product_id = ?1",
        registration.runtime_product_id.as_str(),
        &registration.display_name,
        "Runtime product ID is already bound to different metadata",
    )?;

    let installation_inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runtime_installations(
                installation_id, runtime_product_id, distribution, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                registration.installation_id.as_str(),
                registration.runtime_product_id.as_str(),
                registration.distribution.as_str(),
                registration.created_at,
                registration.verified_at
            ],
        )
        .map_err(|error| format!("Cannot register Runtime installation: {error}"))?
        > 0;
    let installation = transaction
        .query_row(
            "SELECT runtime_product_id, distribution
             FROM runtime_installations WHERE installation_id = ?1",
            [registration.installation_id.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| format!("Cannot verify Runtime installation: {error}"))?;
    if installation
        != (
            registration.runtime_product_id.as_str().to_string(),
            registration.distribution.as_str().to_string(),
        )
    {
        return Err("Runtime installation ID is already bound to different metadata".to_string());
    }

    let build_inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runtime_builds(
                runtime_build_id,
                installation_id,
                runtime_product_id,
                adapter_id,
                observed_version,
                artifact_sha256,
                first_seen_at,
                verified_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                registration.runtime_build_id.as_str(),
                registration.installation_id.as_str(),
                registration.runtime_product_id.as_str(),
                registration.adapter_id.as_str(),
                registration.observed_version,
                registration.artifact_sha256,
                registration.created_at,
                registration.verified_at
            ],
        )
        .map_err(|error| format!("Cannot register Runtime build: {error}"))?
        > 0;
    let build = transaction
        .query_row(
            "SELECT installation_id, runtime_product_id, adapter_id, observed_version,
                    artifact_sha256
             FROM runtime_builds WHERE runtime_build_id = ?1",
            [registration.runtime_build_id.as_str()],
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
        .map_err(|error| format!("Cannot verify Runtime build: {error}"))?;
    if build
        != (
            registration.installation_id.as_str().to_string(),
            registration.runtime_product_id.as_str().to_string(),
            registration.adapter_id.as_str().to_string(),
            registration.observed_version.clone(),
            registration.artifact_sha256.clone(),
        )
    {
        return Err("Runtime build ID is already bound to different metadata".to_string());
    }

    let connection_inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runtime_connections(
                connection_id,
                installation_id,
                runtime_product_id,
                label,
                connection_kind,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                registration.connection_id.as_str(),
                registration.installation_id.as_str(),
                registration.runtime_product_id.as_str(),
                registration.connection_label,
                registration.connection_kind.as_str(),
                registration.created_at,
                registration.verified_at
            ],
        )
        .map_err(|error| format!("Cannot register Runtime connection: {error}"))?
        > 0;
    let connection = transaction
        .query_row(
            "SELECT installation_id, runtime_product_id, label, connection_kind
             FROM runtime_connections WHERE connection_id = ?1",
            [registration.connection_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|error| format!("Cannot verify Runtime connection: {error}"))?;
    if connection
        != (
            registration.installation_id.as_str().to_string(),
            registration.runtime_product_id.as_str().to_string(),
            registration.connection_label.clone(),
            registration.connection_kind.as_str().to_string(),
        )
    {
        return Err("Runtime connection ID is already bound to different metadata".to_string());
    }

    Ok(product_inserted || installation_inserted || build_inserted || connection_inserted)
}

fn ensure_project(
    transaction: &Transaction<'_>,
    registration: &SessionRegistration,
    project_path: &str,
    working_copy_path: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT OR IGNORE INTO projects(
                project_id, canonical_path, display_name, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                registration.project_id.as_str(),
                project_path,
                registration.project_name,
                registration.created_at,
                registration.updated_at
            ],
        )
        .map_err(|error| format!("Cannot register Project: {error}"))?;
    let project = transaction
        .query_row(
            "SELECT canonical_path FROM projects WHERE project_id = ?1",
            [registration.project_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Cannot verify Project: {error}"))?;
    if project != project_path {
        return Err("Project ID is already bound to a different path".to_string());
    }

    transaction
        .execute(
            "INSERT OR IGNORE INTO working_copies(
                working_copy_id,
                project_id,
                canonical_path,
                kind,
                branch_name,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                registration.working_copy_id.as_str(),
                registration.project_id.as_str(),
                working_copy_path,
                registration.working_copy_kind.as_str(),
                registration.branch_name,
                registration.created_at,
                registration.updated_at
            ],
        )
        .map_err(|error| format!("Cannot register Working Copy: {error}"))?;
    let working_copy = transaction
        .query_row(
            "SELECT project_id, canonical_path, kind
             FROM working_copies WHERE working_copy_id = ?1",
            [registration.working_copy_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| format!("Cannot verify Working Copy: {error}"))?;
    if working_copy
        != (
            registration.project_id.as_str().to_string(),
            working_copy_path.to_string(),
            registration.working_copy_kind.as_str().to_string(),
        )
    {
        return Err("Working Copy ID is already bound to different metadata".to_string());
    }
    Ok(())
}

fn insert_or_validate_session(
    transaction: &Transaction<'_>,
    registration: &SessionRegistration,
) -> Result<bool, String> {
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO sessions(
                farfold_session_id,
                runtime_product_id,
                installation_id,
                runtime_build_id,
                adapter_id,
                connection_id,
                project_id,
                working_copy_id,
                native_session_id,
                title,
                title_source,
                pinned,
                archived_at,
                created_at,
                updated_at,
                last_opened_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                ?9, ?10, ?11, 0, NULL, ?12, ?13, ?13
            )",
            params![
                registration.farfold_session_id.as_str(),
                registration.runtime_product_id.as_str(),
                registration.installation_id.as_str(),
                registration.runtime_build_id.as_str(),
                registration.adapter_id.as_str(),
                registration.connection_id.as_str(),
                registration.project_id.as_str(),
                registration.working_copy_id.as_str(),
                registration.native_session_id.as_str(),
                registration.title,
                registration.title_source.as_str(),
                registration.created_at,
                registration.updated_at
            ],
        )
        .map_err(|error| format!("Cannot register Session: {error}"))?
        > 0;

    let existing = transaction
        .query_row(
            "SELECT runtime_product_id, installation_id, runtime_build_id, adapter_id,
                    connection_id, project_id, working_copy_id, native_session_id
             FROM sessions WHERE farfold_session_id = ?1",
            [registration.farfold_session_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Cannot verify Session binding: {error}"))?;
    let expected = (
        registration.runtime_product_id.as_str().to_string(),
        registration.installation_id.as_str().to_string(),
        registration.runtime_build_id.as_str().to_string(),
        registration.adapter_id.as_str().to_string(),
        registration.connection_id.as_str().to_string(),
        registration.project_id.as_str().to_string(),
        registration.working_copy_id.as_str().to_string(),
        registration.native_session_id.as_str().to_string(),
    );
    match existing {
        Some(existing) if existing == expected => Ok(inserted),
        Some(_) => Err("Farfold Session ID is already bound to different metadata".to_string()),
        None => Err(
            "Native Session is already bound to another Farfold Session or metadata is invalid"
                .to_string(),
        ),
    }
}

fn activate_session(
    transaction: &Transaction<'_>,
    registration: &SessionRegistration,
    opened_at: i64,
) -> Result<(), String> {
    let opened_at = opened_at.max(registration.created_at);
    let changed = transaction
        .execute(
            "UPDATE sessions
             SET last_opened_at = MAX(last_opened_at, ?2)
             WHERE farfold_session_id = ?1",
            params![registration.farfold_session_id.as_str(), opened_at],
        )
        .map_err(|error| format!("Cannot mark Session opened: {error}"))?;
    if changed != 1 {
        return Err("Cannot activate an unknown Farfold Session".to_string());
    }
    transaction
        .execute(
            "INSERT INTO app_state(singleton, last_project_id, last_session_id, updated_at)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(singleton) DO UPDATE SET
                last_project_id = excluded.last_project_id,
                last_session_id = excluded.last_session_id,
                updated_at = excluded.updated_at
             WHERE excluded.updated_at >= app_state.updated_at",
            params![
                registration.project_id.as_str(),
                registration.farfold_session_id.as_str(),
                opened_at
            ],
        )
        .map_err(|error| format!("Cannot update active Session state: {error}"))?;
    Ok(())
}

fn insert_or_validate_native_locator(
    transaction: &Transaction<'_>,
    session: &SessionRegistration,
    locator: &NativeSessionLocatorRegistration,
    locator_value: &str,
) -> Result<bool, String> {
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO session_native_locators(
                farfold_session_id, locator_kind, locator_value, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                session.farfold_session_id.as_str(),
                locator.kind.as_str(),
                locator_value,
                session.created_at,
                session.updated_at
            ],
        )
        .map_err(|error| format!("Cannot register native Session locator: {error}"))?
        > 0;
    let existing = transaction
        .query_row(
            "SELECT locator_kind, locator_value
             FROM session_native_locators WHERE farfold_session_id = ?1",
            [session.farfold_session_id.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Cannot verify native Session locator: {error}"))?;
    match existing {
        Some(existing)
            if existing == (locator.kind.as_str().to_string(), locator_value.to_string()) =>
        {
            Ok(inserted)
        }
        Some(_) => {
            Err("Farfold Session is already bound to a different native locator".to_string())
        }
        None => {
            Err("Native Session locator is already bound to another Farfold Session".to_string())
        }
    }
}

fn require_exact_row(
    transaction: &Transaction<'_>,
    query: &str,
    id: &str,
    expected: &str,
    mismatch: &str,
) -> Result<(), String> {
    let found = transaction
        .query_row(query, [id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Cannot verify registered Host record: {error}"))?;
    if found == expected {
        Ok(())
    } else {
        Err(mismatch.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        NativeSessionLocatorKind, NativeSessionLocatorRegistration, RuntimeConnectionKind,
        RuntimeDistribution, RuntimeRegistration, SessionRegistration, SessionTitleSource,
        WorkingCopyKind, WriteOutcome,
    };
    use crate::{
        host_ids::{
            AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
            RuntimeBuildId, RuntimeProductId, WorkingCopyId,
        },
        host_store::{HostDatabase, HostDatabaseOpen},
    };
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "farfold-host-records-{name}-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn ready_database(&self) -> HostDatabase {
            match HostDatabaseOpen::open(self.0.join("host.sqlite3")) {
                HostDatabaseOpen::Ready(database) => database,
                HostDatabaseOpen::Recovery(recovery) => {
                    panic!("unexpected recovery: {}", recovery.reason())
                }
            }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn runtime_registration() -> RuntimeRegistration {
        RuntimeRegistration {
            runtime_product_id: RuntimeProductId::parse("pi").unwrap(),
            display_name: "Pi".to_string(),
            installation_id: InstallationId::parse("managed-pi").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("pi@0.84.3+sha256:e844dc14").unwrap(),
            adapter_id: AdapterId::parse("pi-rpc-jsonl").unwrap(),
            distribution: RuntimeDistribution::Managed,
            observed_version: "0.84.3".to_string(),
            artifact_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
            connection_id: ConnectionId::parse("pi-local").unwrap(),
            connection_label: "Pi native configuration".to_string(),
            connection_kind: RuntimeConnectionKind::ManagedLocal,
            created_at: 1,
            verified_at: 2,
        }
    }

    fn session_registration(root: &TestDirectory) -> SessionRegistration {
        let project = root.0.join("project");
        fs::create_dir_all(&project).unwrap();
        SessionRegistration {
            farfold_session_id: FarfoldSessionId::parse("farfold-session-1").unwrap(),
            runtime_product_id: RuntimeProductId::parse("pi").unwrap(),
            installation_id: InstallationId::parse("managed-pi").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("pi@0.84.3+sha256:e844dc14").unwrap(),
            adapter_id: AdapterId::parse("pi-rpc-jsonl").unwrap(),
            connection_id: ConnectionId::parse("pi-local").unwrap(),
            project_id: ProjectId::parse("project-1").unwrap(),
            project_path: project.clone(),
            project_name: "Project".to_string(),
            working_copy_id: WorkingCopyId::parse("working-copy-1").unwrap(),
            working_copy_path: project,
            working_copy_kind: WorkingCopyKind::Root,
            branch_name: Some("main".to_string()),
            native_session_id: NativeSessionId::parse("native-session-1").unwrap(),
            title: "First Session".to_string(),
            title_source: SessionTitleSource::FirstUser,
            created_at: 3,
            updated_at: 4,
        }
    }

    fn pi_locator(root: &TestDirectory, name: &str) -> NativeSessionLocatorRegistration {
        let session_root = root.0.join("sessions");
        fs::create_dir_all(&session_root).unwrap();
        let locator_path = session_root.join(name);
        fs::write(&locator_path, "{}\n").unwrap();
        NativeSessionLocatorRegistration {
            kind: NativeSessionLocatorKind::PiSessionFile,
            locator_path,
            allowed_root: session_root,
        }
    }

    #[test]
    fn runtime_and_session_registration_are_transactional_and_idempotent() {
        let root = TestDirectory::new("idempotent");
        let mut database = root.ready_database();
        let runtime = runtime_registration();
        let session = session_registration(&root);

        assert_eq!(
            database.register_runtime(&runtime).unwrap(),
            WriteOutcome::Inserted
        );
        assert_eq!(
            database.register_runtime(&runtime).unwrap(),
            WriteOutcome::AlreadyPresent
        );
        assert_eq!(
            database.register_session(&session).unwrap(),
            WriteOutcome::Inserted
        );
        assert_eq!(
            database.register_session(&session).unwrap(),
            WriteOutcome::AlreadyPresent
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT count(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn failed_session_registration_rolls_back_project_and_working_copy() {
        let root = TestDirectory::new("rollback");
        let mut database = root.ready_database();
        let session = session_registration(&root);

        assert!(database.register_session(&session).is_err());
        assert_eq!(
            database
                .connection
                .query_row("SELECT count(*) FROM projects", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT count(*) FROM working_copies", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn immutable_session_binding_rejects_rebinding() {
        let root = TestDirectory::new("immutable");
        let mut database = root.ready_database();
        database.register_runtime(&runtime_registration()).unwrap();
        let original = session_registration(&root);
        database.register_session(&original).unwrap();

        let mut rebound = original;
        rebound.native_session_id = NativeSessionId::parse("native-session-2").unwrap();
        assert!(database.register_session(&rebound).is_err());
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT native_session_id FROM sessions
                     WHERE farfold_session_id = 'farfold-session-1'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "native-session-1"
        );
    }

    #[test]
    fn native_locator_commits_atomically_and_is_idempotent() {
        let root = TestDirectory::new("native-locator-idempotent");
        let mut database = root.ready_database();
        database.register_runtime(&runtime_registration()).unwrap();
        let session = session_registration(&root);
        let locator = pi_locator(&root, "native-session-1.jsonl");

        assert_eq!(
            database
                .register_session_with_native_locator(&session, &locator)
                .unwrap(),
            WriteOutcome::Inserted
        );
        assert_eq!(
            database
                .register_session_with_native_locator(&session, &locator)
                .unwrap(),
            WriteOutcome::AlreadyPresent
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT count(*) FROM session_native_locators", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }

    #[test]
    fn native_locator_conflict_rolls_back_the_new_session() {
        let root = TestDirectory::new("native-locator-rollback");
        let mut database = root.ready_database();
        database.register_runtime(&runtime_registration()).unwrap();
        let first = session_registration(&root);
        let locator = pi_locator(&root, "native-session-1.jsonl");
        database
            .register_active_session_with_native_locator(&first, &locator)
            .unwrap();
        let mut conflicting = first;
        conflicting.farfold_session_id = FarfoldSessionId::parse("farfold-session-2").unwrap();
        conflicting.native_session_id = NativeSessionId::parse("native-session-2").unwrap();

        assert!(
            database
                .register_active_session_with_native_locator(&conflicting, &locator)
                .unwrap_err()
                .contains("another Farfold Session")
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT count(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM sessions WHERE farfold_session_id = 'farfold-session-2'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT last_session_id FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "farfold-session-1"
        );
    }

    #[test]
    fn native_locator_rejects_rebinding_without_changing_the_original() {
        let root = TestDirectory::new("native-locator-immutable");
        let mut database = root.ready_database();
        database.register_runtime(&runtime_registration()).unwrap();
        let session = session_registration(&root);
        let original = pi_locator(&root, "native-session-1.jsonl");
        database
            .register_session_with_native_locator(&session, &original)
            .unwrap();
        let rebound = pi_locator(&root, "native-session-2.jsonl");

        assert!(
            database
                .register_session_with_native_locator(&session, &rebound)
                .unwrap_err()
                .contains("different native locator")
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT locator_value FROM session_native_locators",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            original
                .locator_path
                .canonicalize()
                .unwrap()
                .to_string_lossy()
        );
    }
}
