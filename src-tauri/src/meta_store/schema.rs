//! Current metadata schema; recovery validates a candidate against this exact structure.
pub(crate) const SCHEMA: &str = "PRAGMA journal_mode = WAL;
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
                 );";
