CREATE TABLE life_model_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    document_version INTEGER NOT NULL CHECK (document_version = 1),
    snapshot_json TEXT NOT NULL CHECK (
        length(CAST(snapshot_json AS BLOB)) BETWEEN 1 AND 8388608
    ),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

INSERT INTO life_model_state(
    singleton,
    document_version,
    snapshot_json,
    revision,
    updated_at
) VALUES (
    1,
    1,
    '{"version":1,"enabled":false,"proposals":[],"items":[],"sourceWithdrawals":[],"injectionManifests":[]}',
    0,
    0
);

CREATE TABLE life_model_legacy_migrations (
    source_name TEXT PRIMARY KEY CHECK (length(source_name) BETWEEN 1 AND 200),
    source_sha256 TEXT NOT NULL CHECK (
        length(source_sha256) = 64
        AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    source_byte_count INTEGER NOT NULL CHECK (
        source_byte_count BETWEEN 1 AND 8388608
    ),
    retired_path TEXT NOT NULL CHECK (length(retired_path) BETWEEN 1 AND 4096),
    imported_at INTEGER NOT NULL CHECK (imported_at >= 0),
    retired_at INTEGER CHECK (retired_at IS NULL OR retired_at >= imported_at)
) STRICT;
