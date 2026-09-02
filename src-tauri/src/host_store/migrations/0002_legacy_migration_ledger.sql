CREATE TABLE legacy_migration_sources (
    source_kind TEXT NOT NULL CHECK (
        source_kind IN (
            'pi_session_pointer',
            'opencode_bindings',
            'lifemodel'
        )
    ),
    source_path TEXT NOT NULL CHECK (length(source_path) > 0),
    source_sha256 TEXT NOT NULL CHECK (
        length(source_sha256) = 64
        AND source_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    status TEXT NOT NULL CHECK (
        status IN ('previewed', 'accepted', 'imported', 'skipped', 'failed')
    ),
    record_count INTEGER NOT NULL CHECK (record_count >= 0),
    issue_code TEXT,
    previewed_at INTEGER NOT NULL CHECK (previewed_at >= 0),
    imported_at INTEGER CHECK (imported_at IS NULL OR imported_at >= previewed_at),
    PRIMARY KEY (source_kind, source_path, source_sha256)
) STRICT;

CREATE INDEX legacy_migration_sources_by_status
    ON legacy_migration_sources(status, previewed_at DESC);
