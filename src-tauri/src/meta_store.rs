//! Farfold-owned metadata store (SQLite).
//!
//! Holds only Farfold-owned data: the agent roster (`agents`), a session index
//! (`sessions` — agent_id, cwd, native session id, title, pin/archive), and
//! `settings`. Session content lives with the agent; Farfold never rebuilds a
//! turn/event ledger here.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

mod archive;
mod custom_agent;
mod fork;
pub(crate) mod prompt_templates;
pub(crate) mod remembered_pages;
pub(crate) mod schema;
mod startup_restore;
mod storage_recovery;
#[cfg(test)]
#[path = "meta_store/test_support.rs"]
mod test_support;
mod worktree_impact;
pub(crate) mod worktree_maintenance;
mod worktrees;
use crate::storage_recovery::{io_receipt, sqlite_receipt};

#[cfg(test)]
mod recovery_tests;
#[cfg(test)]
mod startup_restore_tests;

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRow {
    pub id: String,
    pub name: String,
    /// `discovered` | `registry` | `custom`
    pub source: String,
    pub command: String,
    /// JSON array of strings.
    pub args: Vec<String>,
    /// JSON object of env overrides applied on top of the login-shell env.
    pub env: Vec<(String, String)>,
    pub version: Option<String>,
    /// Raw `initialize` response JSON from the last successful handshake.
    pub handshake: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub agent_id: String,
    pub cwd: String,
    pub native_session_id: Option<String>,
    pub title: Option<String>,
    pub config_options: Option<serde_json::Value>,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LocalSessionDeleteError {
    NotRemoved,
    Unknown,
}

/// SQLite-backed metadata store. All access is serialized through a mutex so
/// the store can be shared as Tauri state from sync command handlers.
#[derive(Clone)]
pub struct MetaStore {
    connection: Arc<Mutex<Connection>>,
    maintenance: Arc<std::sync::atomic::AtomicU64>,
}

impl MetaStore {
    /// Execute short SQLite work away from async transport workers.
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&Self) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let store = self.clone();
        tauri::async_runtime::spawn_blocking(move || operation(&store))
            .await
            .map_err(|_| "无法读取或保存设置".to_string())?
    }
    /// Open (or create) the store at `path`. Schema is created if missing;
    /// no migrations — this is a fresh store, not a successor of the old DB.
    pub fn open(path: &Path) -> Result<Self, String> {
        // Check an existing file before any schema or journal-mode mutation.
        // Zero-length/truncated databases are not treated as a fresh install.
        let existing = storage_recovery::check_existing(path)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io_receipt)?;
        }
        let connection = storage_recovery::open_connection(path, existing)?;
        if connection
            .is_readonly(rusqlite::MAIN_DB)
            .map_err(sqlite_receipt)?
        {
            return Err("FARFOLD_STORAGE:readOnly:资料位置处于只读状态".into());
        }
        connection
            .execute_batch(schema::SCHEMA)
            .map_err(sqlite_receipt)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            maintenance: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        })
    }

    /// Default store location inside the app data directory.
    pub fn default_path(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join("farfold.sqlite3")
    }

    /// Remove every Farfold-owned record in one transaction. The database file
    /// and schema stay readable, but this process can no longer write old
    /// in-memory snapshots. Reopening the app creates a fresh writable connection.
    /// Callers must delete secure-storage secrets and
    /// managed roots before this reset so an interrupted clear never orphans
    /// keychain entries or loses the receipts needed to delete owned paths.
    pub fn clear_all(&self) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|_| "无法清除数据".to_string())?;
        transaction
            .execute_batch(
                "DELETE FROM dismissed_sessions; \
                 DELETE FROM sessions; \
                 DELETE FROM agents; \
                 DELETE FROM settings;",
            )
            .and_then(|_| transaction.commit())
            .map_err(|_| "无法清除数据".to_string())?;
        // Keep the same mutex through sealing: writers already queued on this
        // connection must not restore pre-clear settings or registration data.
        connection
            .pragma_update(None, "query_only", true)
            .map_err(|_| "数据已清除，请退出并重新打开应用".to_string())
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "meta store lock poisoned".to_string())?;
        if self.maintenance.load(std::sync::atomic::Ordering::SeqCst) == u64::MAX {
            return Err(worktree_maintenance::BUSY.into());
        }
        Ok(connection)
    }

    // ------------------------------------------------------------------
    // agents
    // ------------------------------------------------------------------

    /// Create a roster entry. Existing identities are never replaced by adding.
    pub fn insert_agent(&self, agent: &AgentRow) -> Result<(), String> {
        let connection = self.lock()?;
        insert_agent_row(&connection, agent)
    }

    /// Custom identities are unrelated to display names, commands, or arguments.
    pub fn insert_custom_agent(&self, mut agent: AgentRow) -> Result<AgentRow, String> {
        let connection = self.lock()?;
        agent.id = connection
            .query_row(
                "SELECT 'custom-' || lower(hex(randomblob(16)))",
                [],
                |row| row.get(0),
            )
            .map_err(|_| "无法添加 Agent，请重试".to_string())?;
        insert_agent_row(&connection, &agent)?;
        Ok(agent)
    }

    /// Replace a disconnected Agent's launch configuration and invalidate its declarations.
    /// Session IDs and credential grants keep referring to the same roster identity.
    pub fn replace_agent_launch(&self, agent: &AgentRow) -> Result<(), String> {
        let connection = self.lock()?;
        replace_agent_launch_row(&connection, agent)
    }

    /// Publish an unselected program in the existing inventory. Launch settings
    /// must still match, but normal handshake updates while work runs are allowed.
    pub(crate) fn save_program_inventory(
        &self,
        expected: &AgentRow,
        installations: &serde_json::Value,
    ) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法保存程序清单，原选择保持不变")?;
        let current = transaction
            .query_row(
                "SELECT id, name, source, command, args, env, version, handshake,
             created_at, updated_at FROM agents WHERE id = ?1",
                params![expected.id],
                row_to_agent,
            )
            .optional()
            .map_err(|_| "无法读取原程序设置")?
            .ok_or("接入已移除，未发布所需程序")?;
        if current.source != expected.source
            || current.command != expected.command
            || current.args != expected.args
            || current.env != expected.env
            || current.version != expected.version
        {
            return Err("程序设置已变化，请重新检查；原选择保持不变".into());
        }
        transaction
            .execute(
                "INSERT INTO settings (key, value) VALUES ('installations.v1', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![installations.to_string()],
            )
            .map_err(|_| "无法保存程序清单，原选择保持不变")?;
        transaction
            .commit()
            .map_err(|_| "无法完成程序清单保存，原选择保持不变".to_string())
    }

    /// Select a checked candidate together with its installation receipt and
    /// previous target. No partial selection survives a storage failure.
    pub(crate) fn commit_agent_candidate(
        &self,
        candidate: &AgentRow,
        expected: Option<&AgentRow>,
        previous_launch: &serde_json::Value,
        installations: &serde_json::Value,
    ) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法保存程序选择，原设置保持不变")?;
        let current = transaction
            .query_row(
                "SELECT id, name, source, command, args, env, version, handshake,
                 created_at, updated_at FROM agents WHERE id = ?1",
                params![candidate.id],
                row_to_agent,
            )
            .optional()
            .map_err(|_| "无法读取原程序设置")?;
        if current.as_ref() != expected {
            return Err("程序设置已变化，请重新检查后选择".into());
        }
        if current.is_some() {
            replace_agent_launch_row(&transaction, candidate)?;
        } else {
            let mut candidate = candidate.clone();
            candidate.handshake = None;
            insert_agent_row(&transaction, &candidate)?;
        }
        for (key, value) in [
            (format!("installPrevious.{}", candidate.id), previous_launch),
            ("installations.v1".into(), installations),
        ] {
            transaction
                .execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value.to_string()],
                )
                .map_err(|_| "无法保存程序选择，原设置保持不变")?;
        }
        transaction
            .commit()
            .map_err(|_| "无法保存程序选择，原设置保持不变".into())
    }

    /// Credential changes must not overwrite launch configuration or cached declarations.
    pub fn set_agent_env(&self, agent_id: &str, env: &[(String, String)]) -> Result<(), String> {
        let changed = self
            .lock()?
            .execute(
                "UPDATE agents SET env = ?2, updated_at = ?3 WHERE id = ?1",
                params![agent_id, encoded_agent_env(env), now_millis()],
            )
            .map_err(|_| "无法保存 Agent 密钥设置")?;
        if changed == 0 {
            return Err("请先重新添加此 Agent".into());
        }
        Ok(())
    }

    /// Publish declarations only for the launch configuration that was initialized.
    /// A cancelled caller's queued database job cannot repopulate a newer launch.
    pub fn set_agent_handshake(
        &self,
        expected: &AgentRow,
        handshake: &serde_json::Value,
    ) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "无法保存 Agent 连接信息")?;
        let current: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT command, args, env FROM agents WHERE id = ?1",
                params![expected.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|_| "无法读取 Agent 程序设置")?;
        let Some((command, args, env)) = current else {
            return Err("Agent 程序设置已变化，请重新连接".into());
        };
        let args: Vec<String> =
            serde_json::from_str(&args).map_err(|_| "无法读取 Agent 程序设置")?;
        let env: std::collections::BTreeMap<String, String> =
            serde_json::from_str(&env).map_err(|_| "无法读取 Agent 程序设置")?;
        let expected_env: std::collections::BTreeMap<String, String> =
            expected.env.iter().cloned().collect();
        if command != expected.command || args != expected.args || env != expected_env {
            return Err("Agent 程序设置已变化，请重新连接".into());
        }
        transaction
            .execute(
                "UPDATE agents SET handshake = ?2, updated_at = ?3 WHERE id = ?1",
                params![expected.id, handshake.to_string(), now_millis()],
            )
            .map_err(|_| "无法保存 Agent 连接信息")?;
        transaction
            .commit()
            .map_err(|_| "无法保存 Agent 连接信息".into())
    }

    pub fn get_agent(&self, agent_id: &str) -> Result<Option<AgentRow>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, name, source, command, args, env, version, handshake,
                        created_at, updated_at FROM agents WHERE id = ?1",
            )
            .map_err(|error| format!("cannot read agents: {error}"))?;
        let mut rows = statement
            .query_map(params![agent_id], row_to_agent)
            .map_err(|error| format!("cannot read agent {agent_id}: {error}"))?;
        match rows.next() {
            None => Ok(None),
            Some(row) => row
                .map(Some)
                .map_err(|error| format!("cannot decode agent row for {agent_id}: {error}")),
        }
    }

    pub fn list_agents(&self) -> Result<Vec<AgentRow>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, name, source, command, args, env, version, handshake,
                        created_at, updated_at FROM agents ORDER BY name, id",
            )
            .map_err(|error| format!("cannot list agents: {error}"))?;
        let rows = statement
            .query_map([], row_to_agent)
            .map_err(|error| format!("cannot list agents: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("cannot decode agent rows: {error}"))
    }

    pub fn remove_agent(&self, agent_id: &str) -> Result<bool, String> {
        let connection = self.lock()?;
        let deleted = connection
            .execute("DELETE FROM agents WHERE id = ?1", params![agent_id])
            .map_err(|error| format!("cannot remove agent {agent_id}: {error}"))?;
        Ok(deleted > 0)
    }

    // ------------------------------------------------------------------
    // sessions
    // ------------------------------------------------------------------

    /// Explicitly admit successfully loaded Agent history. The Agent's native
    /// id is deduplicated atomically, even when later listings change its cwd.
    /// A restored model report is deliberately not saved as an original choice.
    pub(crate) fn import_session(
        &self,
        agent_id: &str,
        cwd: &str,
        native_session_id: &str,
        title: Option<&str>,
    ) -> Result<SessionRow, String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "未能加入对话，请重试")?;
        let existing = transaction.query_row(
            "SELECT id, agent_id, cwd, native_session_id, title, config_options, pinned, archived, created_at, updated_at
             FROM sessions WHERE agent_id = ?1 AND native_session_id = ?2 ORDER BY created_at LIMIT 1",
            params![agent_id, native_session_id], row_to_session,
        ).optional().map_err(|_| "无法核对已有对话，请重试")?;
        let row = match existing {
            Some(existing) => existing,
            None => {
                let now = now_millis();
                let row = SessionRow {
                    id: Self::dismissed_id(agent_id, cwd, native_session_id),
                    agent_id: agent_id.into(),
                    cwd: cwd.into(),
                    native_session_id: Some(native_session_id.into()),
                    title: title
                        .filter(|title| !title.trim().is_empty())
                        .map(str::to_string),
                    config_options: None,
                    pinned: false,
                    archived: false,
                    created_at: now,
                    updated_at: now,
                };
                transaction.execute(
                    "INSERT INTO sessions (id, agent_id, cwd, native_session_id, title, config_options, pinned, archived, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, 0, ?6, ?6)",
                    params![row.id, row.agent_id, row.cwd, row.native_session_id, row.title, now],
                ).map_err(|_| "未能加入对话，请重试")?;
                row
            }
        };
        transaction
            .execute(
                "DELETE FROM dismissed_sessions WHERE id = ?1",
                params![row.id],
            )
            .map_err(|_| "未能恢复对话，请重试")?;
        transaction.commit().map_err(|_| "未能保存对话，请重试")?;
        Ok(row)
    }

    /// Automatic index updates may fill an empty title, never rename an
    /// existing one, reapply stale pin/archive metadata, or restore a removed row.
    pub(crate) fn touch_session(&self, session: &SessionRow) -> Result<SessionRow, String> {
        let connection = self.lock()?;
        let title = session
            .title
            .as_deref()
            .filter(|title| !title.trim().is_empty());
        let config = session
            .config_options
            .as_ref()
            .map(serde_json::Value::to_string);
        connection
            .query_row(
                "INSERT INTO sessions (id, agent_id, cwd, native_session_id, title,
                                   config_options, pinned, archived, created_at, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, ?8
             WHERE NOT EXISTS (SELECT 1 FROM dismissed_sessions WHERE id = ?1)
             ON CONFLICT(id) DO UPDATE SET
                 title = CASE WHEN sessions.title IS NULL OR trim(sessions.title) = ''
                         THEN coalesce(excluded.title, sessions.title) ELSE sessions.title END,
                 config_options = coalesce(excluded.config_options, sessions.config_options),
                 updated_at = max(sessions.updated_at, excluded.updated_at)
             RETURNING id, agent_id, cwd, native_session_id, title, config_options,
                       pinned, archived, created_at, updated_at",
                params![
                    session.id,
                    session.agent_id,
                    session.cwd,
                    session.native_session_id,
                    title,
                    config,
                    session.created_at,
                    session.updated_at
                ],
                row_to_session,
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => "这段对话已从列表移除，请先明确加入".into(),
                _ => "未能更新对话，请重试".into(),
            })
    }

    /// Fill a missing baseline on the original index row without reviving a
    /// removed conversation or overwriting a concurrent configuration save.
    pub(crate) fn compare_session_config(
        &self,
        id: &str,
        owner: (String, String, String),
        previous: &serde_json::Value,
        next: &serde_json::Value,
    ) -> Result<(), String> {
        let changed = "对话的已保存设置已变化，请重新检查";
        let failed = "未能保存确认值，请重试";
        let (agent, cwd, native) = owner;
        let mut db = self.lock()?;
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| failed.to_string())?;
        let stored: String = transaction
            .query_row(
                "SELECT config_options FROM sessions WHERE id=?1 AND agent_id=?2 AND cwd=?3
             AND native_session_id=?4 AND config_options IS NOT NULL",
                params![id, agent, cwd, native],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| failed.to_string())?
            .ok_or(changed)?;
        if serde_json::from_str::<serde_json::Value>(&stored)
            .as_ref()
            .ok()
            != Some(previous)
        {
            return Err(changed.into());
        }
        let rows = transaction
            .execute(
                "UPDATE sessions SET config_options=?1 WHERE id=?2 AND agent_id=?3 AND cwd=?4
             AND native_session_id=?5 AND config_options=?6",
                params![next.to_string(), id, agent, cwd, native, stored],
            )
            .map_err(|_| failed.to_string())?;
        if rows != 1 {
            return Err(changed.into());
        }
        transaction.commit().map_err(|_| failed.to_string())
    }

    pub fn upsert_session(&self, session: &SessionRow) -> Result<(), String> {
        let connection = self.lock()?;
        let config_options = session
            .config_options
            .as_ref()
            .map(serde_json::Value::to_string);
        connection
            .execute(
                "INSERT INTO sessions (id, agent_id, cwd, native_session_id, title,
                                       config_options, pinned, archived,
                                       created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                     agent_id          = excluded.agent_id,
                     cwd               = excluded.cwd,
                     native_session_id = excluded.native_session_id,
                     title             = excluded.title,
                     config_options    = excluded.config_options,
                     pinned            = excluded.pinned,
                     archived          = excluded.archived,
                     updated_at        = excluded.updated_at",
                params![
                    session.id,
                    session.agent_id,
                    session.cwd,
                    session.native_session_id,
                    session.title,
                    config_options,
                    session.pinned as i64,
                    session.archived as i64,
                    session.created_at,
                    session.updated_at,
                ],
            )
            .map_err(|error| format!("cannot upsert session {}: {error}", session.id))?;
        Ok(())
    }

    pub fn get_session(&self, session_id: &str) -> Result<Option<SessionRow>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, agent_id, cwd, native_session_id, title, config_options,
                        pinned, archived, created_at, updated_at
                 FROM sessions WHERE id = ?1",
            )
            .map_err(|error| format!("cannot read sessions: {error}"))?;
        let mut rows = statement
            .query_map(params![session_id], row_to_session)
            .map_err(|error| format!("cannot read session {session_id}: {error}"))?;
        match rows.next() {
            None => Ok(None),
            Some(row) => row
                .map(Some)
                .map_err(|error| format!("cannot decode session row for {session_id}: {error}")),
        }
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionRow>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, agent_id, cwd, native_session_id, title, config_options,
                        pinned, archived, created_at, updated_at
                 FROM sessions ORDER BY updated_at DESC",
            )
            .map_err(|error| format!("cannot list sessions: {error}"))?;
        let rows = statement
            .query_map([], row_to_session)
            .map_err(|error| format!("cannot list sessions: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("cannot decode session rows: {error}"))
    }

    /// Session rows for one `(agent_id, cwd)` pair, newest first.
    pub fn list_sessions_for(&self, agent_id: &str, cwd: &str) -> Result<Vec<SessionRow>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, agent_id, cwd, native_session_id, title, config_options,
                        pinned, archived, created_at, updated_at
                 FROM sessions WHERE agent_id = ?1 AND cwd = ?2
                 ORDER BY updated_at DESC",
            )
            .map_err(|error| format!("cannot list sessions for scope: {error}"))?;
        let rows = statement
            .query_map(params![agent_id, cwd], row_to_session)
            .map_err(|error| format!("cannot list sessions for scope: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("cannot decode session rows: {error}"))
    }

    pub fn remove_session(&self, session_id: &str) -> Result<bool, String> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(sqlite_receipt)?;
        let deleted =
            Self::remove_session_metadata(&transaction, session_id).map_err(sqlite_receipt)?;
        transaction.commit().map_err(sqlite_receipt)?;
        Ok(deleted)
    }

    fn remove_session_metadata(
        connection: &Connection,
        session_id: &str,
    ) -> rusqlite::Result<bool> {
        let deleted = connection.execute("DELETE FROM sessions WHERE id = ?1", [session_id])?;
        connection.execute(
            "DELETE FROM settings WHERE key=?1",
            [remembered_pages::key(session_id)],
        )?;
        Ok(deleted > 0)
    }

    /// Commit the local removal and its history filter together, including when
    /// the selected item only exists in the Agent's history.
    pub(crate) fn remove_and_dismiss_session(
        &self,
        session_id: &str,
    ) -> Result<(), LocalSessionDeleteError> {
        use LocalSessionDeleteError::{NotRemoved, Unknown};

        let mut connection = self.lock().map_err(|_| NotRemoved)?;
        let tx = connection.transaction().map_err(|_| NotRemoved)?;
        if Self::remove_session_metadata(&tx, session_id)
            .and_then(|_| Self::insert_dismissal(&tx, session_id))
            .is_err()
        {
            // SQLite can already have rolled back on a statement failure. If
            // it has not, only a successful rollback proves nothing changed.
            return Err(if tx.is_autocommit() || tx.rollback().is_ok() {
                NotRemoved
            } else {
                Unknown
            });
        }
        tx.commit().map_err(|_| Unknown)
    }

    // ------------------------------------------------------------------
    // dismissed sessions (tombstones)
    // ------------------------------------------------------------------
    //
    // Tombstones hide agent-side sessions from the `session/list` merge:
    // discarded unprompted drafts and deleted sessions must not reappear as
    // `source: "agent"` rows. Id = `agent_id:cwd:native_session_id`.

    /// Compose the tombstone key for an agent-side session.
    pub fn dismissed_id(agent_id: &str, cwd: &str, native_session_id: &str) -> String {
        format!("{agent_id}:{cwd}:{native_session_id}")
    }

    /// Record a tombstone; idempotent.
    pub fn dismiss_session(&self, id: &str) -> Result<(), String> {
        let connection = self.lock()?;
        Self::insert_dismissal(&connection, id)
            .map_err(|error| format!("cannot dismiss session {id}: {error}"))
    }

    fn insert_dismissal(connection: &Connection, id: &str) -> rusqlite::Result<()> {
        connection.execute(
            "INSERT INTO dismissed_sessions (id, created_at) VALUES (?1, ?2)
             ON CONFLICT(id) DO NOTHING",
            params![id, now_millis()],
        )?;
        Ok(())
    }

    /// Every tombstoned session id (used to filter `session/list` merges).
    pub fn list_dismissed(&self) -> Result<std::collections::HashSet<String>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT id FROM dismissed_sessions")
            .map_err(|error| format!("cannot list dismissed sessions: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("cannot read dismissed sessions: {error}"))?;
        rows.collect::<Result<std::collections::HashSet<_>, _>>()
            .map_err(|error| format!("cannot decode dismissed sessions: {error}"))
    }

    /// Lift a tombstone (e.g. the user re-imports an agent-side session).
    pub fn undismiss_session(&self, id: &str) -> Result<bool, String> {
        let connection = self.lock()?;
        let removed = connection
            .execute("DELETE FROM dismissed_sessions WHERE id = ?1", params![id])
            .map_err(|error| format!("cannot undismiss session {id}: {error}"))?;
        Ok(removed > 0)
    }

    // ------------------------------------------------------------------
    // settings
    // ------------------------------------------------------------------

    pub fn get_setting(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT value FROM settings WHERE key = ?1")
            .map_err(sqlite_receipt)?;
        let mut rows = statement
            .query_map(params![key], |row| row.get::<_, String>(0))
            .map_err(sqlite_receipt)?;
        match rows.next() {
            None => Ok(None),
            Some(Err(error)) => Err(sqlite_receipt(error)),
            Some(Ok(raw)) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|error| format!("setting {key} is not JSON: {error}")),
        }
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<(), String> {
        let connection = self.lock()?;
        self.ensure_worktree_write_available()?;
        connection
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value.to_string()],
            )
            .map_err(sqlite_receipt)?;
        Ok(())
    }

    pub fn list_settings(&self) -> Result<Vec<(String, serde_json::Value)>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT key, value FROM settings ORDER BY key")
            .map_err(|error| format!("cannot list settings: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("cannot list settings: {error}"))?;
        let mut settings = Vec::new();
        for row in rows {
            let (key, raw) = row.map_err(|error| format!("cannot list settings: {error}"))?;
            let value = serde_json::from_str(&raw)
                .map_err(|error| format!("setting {key} is not JSON: {error}"))?;
            settings.push((key, value));
        }
        Ok(settings)
    }
}

fn encoded_agent_env(env: &[(String, String)]) -> String {
    let env: serde_json::Map<String, serde_json::Value> = env
        .iter()
        .map(|(key, value)| (key.clone(), serde_json::Value::String(value.clone())))
        .collect();
    serde_json::Value::Object(env).to_string()
}

fn insert_agent_row(connection: &Connection, agent: &AgentRow) -> Result<(), String> {
    let args = serde_json::to_string(&agent.args).map_err(|_| "无法保存 Agent 参数")?;
    connection.execute(
        "INSERT INTO agents (id, name, source, command, args, env, version, handshake, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![agent.id, agent.name, agent.source, agent.command, args,
            encoded_agent_env(&agent.env), agent.version,
            agent.handshake.as_ref().map(serde_json::Value::to_string), agent.created_at, agent.updated_at],
    ).map_err(|_| "无法添加 Agent：此接入已存在或设置未能保存".to_string())?;
    Ok(())
}

fn replace_agent_launch_row(connection: &Connection, agent: &AgentRow) -> Result<(), String> {
    let args = serde_json::to_string(&agent.args).map_err(|_| "无法保存 Agent 参数")?;
    let changed = connection
        .execute(
            "UPDATE agents SET name = ?2, source = ?3, command = ?4, args = ?5,
             env = ?6, version = ?7, handshake = NULL, updated_at = ?8 WHERE id = ?1",
            params![
                agent.id,
                agent.name,
                agent.source,
                agent.command,
                args,
                encoded_agent_env(&agent.env),
                agent.version,
                now_millis()
            ],
        )
        .map_err(|_| "无法保存 Agent 程序设置")?;
    if changed == 0 {
        return Err("请先重新添加此 Agent".into());
    }
    Ok(())
}

/// Invalid saved choices must remain unreadable, never become empty launch
/// arguments, a different inherited environment, or an absent model baseline.
fn decode_saved_json<T: DeserializeOwned>(raw: &str, column: usize) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|_| invalid_saved_json(column))
}

fn invalid_saved_json(column: usize) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "保存的设置无法读取，请检查后重试",
        )),
    )
}

fn row_to_agent(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRow> {
    let args_raw: String = row.get(4)?;
    let env_raw: String = row.get(5)?;
    let handshake_raw: Option<String> = row.get(7)?;
    Ok(AgentRow {
        id: row.get(0)?,
        name: row.get(1)?,
        source: row.get(2)?,
        command: row.get(3)?,
        args: decode_saved_json(&args_raw, 4)?,
        env: decode_saved_json::<serde_json::Map<String, serde_json::Value>>(&env_raw, 5)?
            .into_iter()
            .map(|(key, value)| match value {
                serde_json::Value::String(value) => Ok((key, value)),
                _ => Err(invalid_saved_json(5)),
            })
            .collect::<rusqlite::Result<_>>()?,
        version: row.get(6)?,
        handshake: handshake_raw
            .map(|raw| decode_saved_json(&raw, 7))
            .transpose()?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
    let config_options_raw: Option<String> = row.get(5)?;
    Ok(SessionRow {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        cwd: row.get(2)?,
        native_session_id: row.get(3)?,
        title: row.get(4)?,
        config_options: config_options_raw
            .map(|raw| decode_saved_json(&raw, 5))
            .transpose()?,
        pinned: row.get::<_, i64>(6)? != 0,
        archived: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_selection_rolls_back_launch_and_previous_when_receipt_write_fails() {
        let directory = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&directory.path().join("meta.db")).unwrap();
        let old = agent("opencode");
        store.insert_agent(&old).unwrap();
        store
            .set_setting(
                "installPrevious.opencode",
                &serde_json::json!({"command":"kept"}),
            )
            .unwrap();
        store
            .set_setting("installations.v1", &serde_json::json!([]))
            .unwrap();
        store
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER refuse_installation_receipt BEFORE UPDATE ON settings
             WHEN NEW.key = 'installations.v1' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
            )
            .unwrap();
        let mut candidate = old.clone();
        candidate.command = "/fixture/new-agent".into();
        assert!(
            store
                .commit_agent_candidate(
                    &candidate,
                    Some(&old),
                    &serde_json::json!({"command":old.command}),
                    &serde_json::json!([{"path":"/fixture/new-install"}]),
                )
                .is_err()
        );
        assert_eq!(store.get_agent("opencode").unwrap(), Some(old));
        assert_eq!(
            store.get_setting("installPrevious.opencode").unwrap(),
            Some(serde_json::json!({"command":"kept"}))
        );
        assert_eq!(
            store.get_setting("installations.v1").unwrap(),
            Some(serde_json::json!([]))
        );
    }

    #[test]
    fn candidate_selection_rejects_changed_target_and_preserves_newer_settings() {
        let directory = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&directory.path().join("meta.db")).unwrap();
        let old = agent("opencode");
        store.insert_agent(&old).unwrap();
        let mut newer = old.clone();
        newer.command = "/fixture/user-selection".into();
        store.replace_agent_launch(&newer).unwrap();
        let mut candidate = old.clone();
        candidate.command = "/fixture/checked-candidate".into();
        assert!(
            store
                .commit_agent_candidate(
                    &candidate,
                    Some(&old),
                    &serde_json::Value::Null,
                    &serde_json::json!([])
                )
                .is_err()
        );
        assert_eq!(
            store.get_agent("opencode").unwrap().unwrap().command,
            newer.command
        );
        assert!(store.get_setting("installations.v1").unwrap().is_none());
    }

    fn store() -> MetaStore {
        let directory = tempfile::tempdir().expect("tempdir");
        MetaStore::open(&directory.path().join("farfold.sqlite3")).expect("open store")
    }

    fn agent(id: &str) -> AgentRow {
        AgentRow {
            id: id.to_string(),
            name: format!("Agent {id}"),
            source: "discovered".to_string(),
            command: format!("/usr/local/bin/{id}"),
            args: vec!["acp".to_string()],
            env: vec![("EXTRA".to_string(), "1".to_string())],
            version: Some("1.0.0".to_string()),
            handshake: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn agent_round_trip_and_handshake_update() {
        let store = store();
        store.insert_agent(&agent("opencode")).unwrap();
        let row = store.get_agent("opencode").unwrap().expect("agent row");
        assert_eq!(row.command, "/usr/local/bin/opencode");
        assert_eq!(row.args, vec!["acp".to_string()]);
        assert_eq!(row.env, vec![("EXTRA".to_string(), "1".to_string())]);

        let handshake =
            serde_json::json!({"protocolVersion": 1, "agentInfo": {"name": "OpenCode"}});
        store.set_agent_handshake(&row, &handshake).unwrap();
        let row = store.get_agent("opencode").unwrap().expect("agent row");
        assert_eq!(row.handshake, Some(handshake));
        assert!(row.updated_at > 1);
    }

    #[test]
    fn access_regression_replacing_program_invalidates_handshake() {
        let store = store();
        let mut first = agent("codex");
        first.handshake = Some(serde_json::json!({"authMethods": [{"id": "old-login"}]}));
        store.insert_agent(&first).unwrap();
        let mut replacement = first.clone();
        replacement.command = "/another/program".into();
        replacement.handshake = None;
        store.replace_agent_launch(&replacement).unwrap();
        assert!(
            store
                .get_agent("codex")
                .unwrap()
                .unwrap()
                .handshake
                .is_none()
        );
    }

    #[test]
    fn access_regression_late_handshake_cannot_overwrite_changed_launch() {
        for field in ["command", "args", "env"] {
            let store = store();
            let first = agent("existing-agent-id");
            store.insert_agent(&first).unwrap();
            let mut replacement = first.clone();
            match field {
                "command" => replacement.command = "/another/program".into(),
                "args" => replacement.args.push("--new-launch".into()),
                "env" => replacement
                    .env
                    .push(("TOKEN".into(), "__keychain__".into())),
                _ => unreachable!(),
            }
            store.replace_agent_launch(&replacement).unwrap();
            let stale = serde_json::json!({"agentInfo": {"name": "old program"}});
            assert!(
                store.set_agent_handshake(&first, &stale).is_err(),
                "{field}"
            );
            assert!(
                store
                    .get_agent(&first.id)
                    .unwrap()
                    .unwrap()
                    .handshake
                    .is_none(),
                "{field}"
            );
            let current = serde_json::json!({"agentInfo": {"name": "current program"}});
            store.set_agent_handshake(&replacement, &current).unwrap();
            assert_eq!(
                store.get_agent(&first.id).unwrap().unwrap().handshake,
                Some(current)
            );
        }
    }

    #[test]
    fn access_regression_handshake_requires_an_existing_agent() {
        let store = store();
        assert!(
            store
                .set_agent_handshake(&agent("removed"), &serde_json::json!({}))
                .is_err()
        );
    }

    #[test]
    fn access_regression_handshake_accepts_legacy_json_formatting_without_rewriting_it() {
        let store = store();
        let mut expected = agent("legacy-formatted-agent");
        expected.args = vec!["acp".into(), "--stdio".into()];
        expected.env = vec![
            ("Z_TOKEN".into(), "__keychain__".into()),
            ("A_ENDPOINT".into(), "fixture".into()),
        ];
        store.insert_agent(&expected).unwrap();
        let args = "[\n  \"acp\",  \"--stdio\"\n]";
        let env = "{ \"Z_TOKEN\" : \"__keychain__\", \"A_ENDPOINT\": \"fixture\" }\n";
        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE agents SET args = ?2, env = ?3 WHERE id = ?1",
                params![expected.id, args, env],
            )
            .unwrap();
        let loaded = store.get_agent(&expected.id).unwrap().unwrap();
        assert_eq!(loaded.args, expected.args);
        let handshake = serde_json::json!({"protocolVersion": 1});
        // The actual connect path passes the decoded snapshot; unsorted input
        // environments must have the same meaning as the stored object too.
        store.set_agent_handshake(&loaded, &handshake).unwrap();
        store.set_agent_handshake(&expected, &handshake).unwrap();
        let actual: (String, String) = store
            .lock()
            .unwrap()
            .query_row(
                "SELECT args, env FROM agents WHERE id = ?1",
                params![expected.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(actual, (args.into(), env.into()));
        assert_eq!(
            store.get_agent(&expected.id).unwrap().unwrap().handshake,
            Some(handshake)
        );
    }

    #[test]
    fn handshake_rejects_invalid_stored_shapes_instead_of_treating_them_as_empty() {
        let invalid = [
            ("null", "{}"),
            ("{}", "{}"),
            ("[1]", "{}"),
            ("[]", "[]"),
            ("[]", "null"),
            ("[]", "{\"TOKEN\": 42}"),
            ("[]", "not-json"),
        ];
        for (args, env) in invalid {
            let store = store();
            let mut expected = agent("invalid-shape");
            expected.args.clear();
            expected.env.clear();
            store.insert_agent(&expected).unwrap();
            store
                .lock()
                .unwrap()
                .execute(
                    "UPDATE agents SET args = ?2, env = ?3 WHERE id = ?1",
                    params![expected.id, args, env],
                )
                .unwrap();
            assert!(
                store
                    .set_agent_handshake(&expected, &serde_json::json!({}))
                    .is_err()
            );
            let saved: Option<String> = store
                .lock()
                .unwrap()
                .query_row(
                    "SELECT handshake FROM agents WHERE id = ?1",
                    params![expected.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(saved.is_none());
        }
    }

    #[test]
    fn agent_insert_preserves_existing_identity_and_env_update_is_narrow() {
        let store = store();
        let mut first = agent("custom-legacy-name");
        first.handshake = Some(serde_json::json!({"authMethods": []}));
        store.insert_agent(&first).unwrap();
        let mut duplicate = first.clone();
        duplicate.args = vec!["replacement".into()];
        assert!(store.insert_agent(&duplicate).is_err());
        assert_eq!(store.get_agent(&first.id).unwrap().unwrap(), first);
        let env = vec![("TOKEN".into(), "__keychain__".into())];
        store.set_agent_env(&first.id, &env).unwrap();
        let after = store.get_agent(&first.id).unwrap().unwrap();
        assert_eq!(after.command, first.command);
        assert_eq!(after.args, first.args);
        assert_eq!(after.handshake, first.handshake);
        assert_eq!(after.env, env);
        assert!(store.remove_agent(&first.id).unwrap());
        assert!(store.get_agent(&first.id).unwrap().is_none());
    }

    #[test]
    fn session_round_trip() {
        let store = store();
        let session = SessionRow {
            id: "s1".to_string(),
            agent_id: "opencode".to_string(),
            cwd: "/tmp/project".to_string(),
            native_session_id: Some("ses_123".to_string()),
            title: Some("first task".to_string()),
            config_options: Some(serde_json::json!([{"id": "model"}])),
            pinned: true,
            archived: false,
            created_at: 1,
            updated_at: 1,
        };
        store.upsert_session(&session).unwrap();
        let row = store.get_session("s1").unwrap().expect("session row");
        assert!(row.pinned);
        assert!(!row.archived);
        assert_eq!(row.native_session_id.as_deref(), Some("ses_123"));
        assert_eq!(store.list_sessions().unwrap().len(), 1);
        assert!(store.remove_session("s1").unwrap());
    }

    #[test]
    fn session_crud_and_scoped_listing() {
        let store = store();
        let session = |id: &str, agent: &str, cwd: &str, updated: i64| SessionRow {
            id: id.to_string(),
            agent_id: agent.to_string(),
            cwd: cwd.to_string(),
            native_session_id: Some(format!("native-{id}")),
            title: None,
            config_options: None,
            pinned: false,
            archived: false,
            created_at: updated,
            updated_at: updated,
        };
        store
            .upsert_session(&session("a1", "opencode", "/tmp/p", 2))
            .unwrap();
        store
            .upsert_session(&session("a2", "opencode", "/tmp/p", 1))
            .unwrap();
        store
            .upsert_session(&session("b1", "codex", "/tmp/p", 3))
            .unwrap();
        store
            .upsert_session(&session("c1", "opencode", "/tmp/q", 4))
            .unwrap();

        // Scoped listing filters by (agent_id, cwd) and orders newest first.
        let scoped = store.list_sessions_for("opencode", "/tmp/p").unwrap();
        assert_eq!(
            scoped.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["a1", "a2"]
        );

        // Update: upsert over the same id mutates, not duplicates.
        let mut renamed = store.get_session("a1").unwrap().expect("row a1");
        renamed.title = Some("renamed".to_string());
        renamed.updated_at = 9;
        store.upsert_session(&renamed).unwrap();
        let scoped = store.list_sessions_for("opencode", "/tmp/p").unwrap();
        assert_eq!(scoped[0].id, "a1");
        assert_eq!(scoped[0].title.as_deref(), Some("renamed"));

        // Delete.
        assert!(store.remove_session("a1").unwrap());
        assert!(store.get_session("a1").unwrap().is_none());
        assert_eq!(
            store.list_sessions_for("opencode", "/tmp/p").unwrap().len(),
            1
        );
    }

    #[test]
    fn delayed_automatic_touch_preserves_explicit_title_and_metadata() {
        let store = store();
        let stale = SessionRow {
            id: "agent:/p:conversation".into(),
            agent_id: "agent".into(),
            cwd: "/p".into(),
            native_session_id: Some("conversation".into()),
            title: Some("Automatic title".into()),
            config_options: None,
            pinned: false,
            archived: false,
            created_at: 10,
            updated_at: 10,
        };
        store.touch_session(&stale).unwrap();

        // A user edits the stored row after the automatic update was prepared.
        let mut explicit = stale.clone();
        explicit.title = Some("My project name".into());
        explicit.pinned = true;
        explicit.archived = true;
        explicit.config_options = Some(serde_json::json!({"model": "original"}));
        explicit.updated_at = 20;
        store.upsert_session(&explicit).unwrap();

        let threads: Vec<_> = (0..8)
            .map(|_| {
                let store = store.clone();
                let stale = stale.clone();
                std::thread::spawn(move || store.touch_session(&stale))
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap().unwrap(), explicit);
        }
        assert_eq!(
            store.get_session(&explicit.id).unwrap(),
            Some(explicit.clone())
        );

        // An actual new config report is still stored without renaming or
        // restoring stale flags, and the original creation time is retained.
        let mut configured = stale;
        configured.config_options =
            Some(serde_json::json!({"model": "original", "effort": "high"}));
        configured.created_at = 30;
        configured.updated_at = 30;
        explicit.config_options = configured.config_options.clone();
        explicit.updated_at = 30;
        assert_eq!(store.touch_session(&configured).unwrap(), explicit);
    }

    #[test]
    fn settings_round_trip() {
        let store = store();
        store
            .set_setting("theme", &serde_json::json!("paper"))
            .unwrap();
        assert_eq!(
            store.get_setting("theme").unwrap(),
            Some(serde_json::json!("paper"))
        );
        store
            .set_setting("theme", &serde_json::json!("system"))
            .unwrap();
        assert_eq!(
            store.get_setting("theme").unwrap(),
            Some(serde_json::json!("system"))
        );
        assert_eq!(store.list_settings().unwrap().len(), 1);
    }

    #[test]
    fn read_only_database_preserves_settings_launch_and_handshake_on_write_failure() {
        let store = store();
        let mut saved = agent("read-only-fixture");
        saved.handshake = Some(serde_json::json!({"authMethods": [{"id": "existing"}]}));
        store.insert_agent(&saved).unwrap();
        store
            .set_setting("themeMode", &serde_json::json!("dark"))
            .unwrap();
        store
            .lock()
            .unwrap()
            .execute_batch("PRAGMA query_only = ON;")
            .unwrap();

        assert!(
            store
                .set_setting("themeMode", &serde_json::json!("light"))
                .is_err()
        );
        let mut replacement = saved.clone();
        replacement.command = "/another/program".into();
        assert!(store.replace_agent_launch(&replacement).is_err());
        assert!(
            store
                .set_agent_handshake(&saved, &serde_json::json!({"authMethods": []}))
                .is_err()
        );

        assert_eq!(
            store.get_setting("themeMode").unwrap(),
            Some(serde_json::json!("dark"))
        );
        assert_eq!(store.get_agent(&saved.id).unwrap(), Some(saved));
    }

    #[test]
    fn concurrent_history_imports_keep_one_native_identity_and_unknown_original_model() {
        let store = store();
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store.import_session(
                        "agent",
                        &format!("/location/{index}"),
                        "external-history",
                        Some("Original"),
                    )
                })
            })
            .collect();
        let rows: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap().unwrap())
            .collect();
        assert!(rows.iter().all(|row| row.id == rows[0].id));
        assert_eq!(store.list_sessions().unwrap().len(), 1);
        assert!(rows[0].config_options.is_none());
        let mut existing = rows[0].clone();
        existing.pinned = true;
        existing.title = Some("User title".into());
        store.upsert_session(&existing).unwrap();
        assert_eq!(
            store
                .import_session(
                    "agent",
                    "/new/location",
                    "external-history",
                    Some("Later title")
                )
                .unwrap(),
            existing
        );
    }

    #[test]
    fn failed_history_import_never_leaves_a_success_index() {
        let store = store();
        let id = MetaStore::dismissed_id("agent", "/location", "external-history");
        store.dismiss_session(&id).unwrap();
        store.lock().unwrap().execute_batch("CREATE TRIGGER fail_history BEFORE DELETE ON dismissed_sessions BEGIN SELECT RAISE(FAIL, 'fixture'); END;").unwrap();
        assert!(
            store
                .import_session("agent", "/location", "external-history", None)
                .is_err()
        );
        assert!(store.list_sessions().unwrap().is_empty());
        assert!(store.list_dismissed().unwrap().contains(&id));
    }
}
