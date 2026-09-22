//! Farfold-owned metadata store (SQLite).
//!
//! Holds only Farfold-owned data: the agent roster (`agents`), a session index
//! (`sessions` — agent_id, cwd, native session id, title, pin/archive), and
//! `settings`. Session content lives with the agent; Farfold never rebuilds a
//! turn/event ledger here.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

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

/// SQLite-backed metadata store. All access is serialized through a mutex so
/// the store can be shared as Tauri state from sync command handlers.
#[derive(Clone)]
pub struct MetaStore {
    connection: Arc<Mutex<Connection>>,
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
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create meta store directory: {error}"))?;
        }
        let connection = Connection::open(path)
            .map_err(|error| format!("cannot open meta store {}: {error}", path.display()))?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS agents (
                     id          TEXT PRIMARY KEY,
                     name        TEXT NOT NULL,
                     source      TEXT NOT NULL,
                     command     TEXT NOT NULL,
                     args        TEXT NOT NULL DEFAULT '[]',
                     env         TEXT NOT NULL DEFAULT '{}',
                     version     TEXT,
                     handshake   TEXT,
                     created_at  INTEGER NOT NULL,
                     updated_at  INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS sessions (
                     id                TEXT PRIMARY KEY,
                     agent_id          TEXT NOT NULL,
                     cwd               TEXT NOT NULL,
                     native_session_id TEXT,
                     title             TEXT,
                     config_options    TEXT,
                     pinned            INTEGER NOT NULL DEFAULT 0,
                     archived          INTEGER NOT NULL DEFAULT 0,
                     created_at        INTEGER NOT NULL,
                     updated_at        INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS settings (
                     key   TEXT PRIMARY KEY,
                     value TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS dismissed_sessions (
                     id          TEXT PRIMARY KEY,
                     created_at  INTEGER NOT NULL
                 );",
            )
            .map_err(|error| format!("cannot initialize meta store schema: {error}"))?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    /// Default store location inside the app data directory.
    pub fn default_path(app_data_dir: &Path) -> PathBuf {
        app_data_dir.join("farfold.sqlite3")
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "meta store lock poisoned".to_string())
    }

    // ------------------------------------------------------------------
    // agents
    // ------------------------------------------------------------------

    pub fn upsert_agent(&self, agent: &AgentRow) -> Result<(), String> {
        let connection = self.lock()?;
        let args = serde_json::to_string(&agent.args)
            .map_err(|error| format!("agent args not serializable: {error}"))?;
        let env: serde_json::Map<String, serde_json::Value> = agent
            .env
            .iter()
            .map(|(key, value)| (key.clone(), serde_json::Value::String(value.clone())))
            .collect();
        let env = serde_json::Value::Object(env).to_string();
        let handshake = agent.handshake.as_ref().map(serde_json::Value::to_string);
        connection
            .execute(
                "INSERT INTO agents (id, name, source, command, args, env, version,
                                     handshake, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                     name       = excluded.name,
                     source     = excluded.source,
                     command    = excluded.command,
                     args       = excluded.args,
                     env        = excluded.env,
                     version    = excluded.version,
                     handshake  = COALESCE(excluded.handshake, agents.handshake),
                     updated_at = excluded.updated_at",
                params![
                    agent.id,
                    agent.name,
                    agent.source,
                    agent.command,
                    args,
                    env,
                    agent.version,
                    handshake,
                    agent.created_at,
                    agent.updated_at,
                ],
            )
            .map_err(|error| format!("cannot upsert agent {}: {error}", agent.id))?;
        Ok(())
    }

    /// Update only the stored handshake JSON (post-`initialize`).
    pub fn set_agent_handshake(
        &self,
        agent_id: &str,
        handshake: &serde_json::Value,
    ) -> Result<(), String> {
        let connection = self.lock()?;
        connection
            .execute(
                "UPDATE agents SET handshake = ?2, updated_at = ?3 WHERE id = ?1",
                params![agent_id, handshake.to_string(), now_millis()],
            )
            .map_err(|error| format!("cannot store handshake for {agent_id}: {error}"))?;
        Ok(())
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
        let connection = self.lock()?;
        let deleted = connection
            .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(|error| format!("cannot remove session {session_id}: {error}"))?;
        Ok(deleted > 0)
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
        connection
            .execute(
                "INSERT INTO dismissed_sessions (id, created_at) VALUES (?1, ?2)
                 ON CONFLICT(id) DO NOTHING",
                params![id, now_millis()],
            )
            .map_err(|error| format!("cannot dismiss session {id}: {error}"))?;
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
            .map_err(|error| format!("cannot read settings: {error}"))?;
        let mut rows = statement
            .query_map(params![key], |row| row.get::<_, String>(0))
            .map_err(|error| format!("cannot read setting {key}: {error}"))?;
        match rows.next() {
            None => Ok(None),
            Some(Err(error)) => Err(format!("cannot read setting {key}: {error}")),
            Some(Ok(raw)) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|error| format!("setting {key} is not JSON: {error}")),
        }
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<(), String> {
        let connection = self.lock()?;
        connection
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value.to_string()],
            )
            .map_err(|error| format!("cannot write setting {key}: {error}"))?;
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

fn row_to_agent(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRow> {
    let args_raw: String = row.get(4)?;
    let env_raw: String = row.get(5)?;
    let handshake_raw: Option<String> = row.get(7)?;
    Ok(AgentRow {
        id: row.get(0)?,
        name: row.get(1)?,
        source: row.get(2)?,
        command: row.get(3)?,
        args: serde_json::from_str(&args_raw).unwrap_or_default(),
        env: serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&env_raw)
            .map(|map| {
                map.into_iter()
                    .filter_map(|(key, value)| value.as_str().map(|v| (key, v.to_string())))
                    .collect()
            })
            .unwrap_or_default(),
        version: row.get(6)?,
        handshake: handshake_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
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
        config_options: config_options_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
        pinned: row.get::<_, i64>(6)? != 0,
        archived: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        store.upsert_agent(&agent("opencode")).unwrap();
        let row = store.get_agent("opencode").unwrap().expect("agent row");
        assert_eq!(row.command, "/usr/local/bin/opencode");
        assert_eq!(row.args, vec!["acp".to_string()]);
        assert_eq!(row.env, vec![("EXTRA".to_string(), "1".to_string())]);

        let handshake =
            serde_json::json!({"protocolVersion": 1, "agentInfo": {"name": "OpenCode"}});
        store.set_agent_handshake("opencode", &handshake).unwrap();
        let row = store.get_agent("opencode").unwrap().expect("agent row");
        assert_eq!(row.handshake, Some(handshake));
        assert!(row.updated_at > 1);
    }

    #[test]
    fn agent_upsert_preserves_handshake_when_new_row_lacks_it() {
        let store = store();
        let mut first = agent("codex");
        first.handshake = Some(serde_json::json!({"authMethods": []}));
        store.upsert_agent(&first).unwrap();

        let mut second = agent("codex");
        second.source = "registry".to_string();
        second.handshake = None;
        store.upsert_agent(&second).unwrap();

        let row = store.get_agent("codex").unwrap().expect("agent row");
        assert_eq!(row.source, "registry");
        assert_eq!(row.handshake, Some(serde_json::json!({"authMethods": []})));
        assert_eq!(store.list_agents().unwrap().len(), 1);
        assert!(store.remove_agent("codex").unwrap());
        assert!(store.get_agent("codex").unwrap().is_none());
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
}
