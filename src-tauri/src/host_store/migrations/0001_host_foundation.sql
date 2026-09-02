CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
) STRICT;

CREATE TABLE runtime_products (
    runtime_product_id TEXT PRIMARY KEY CHECK (
        length(runtime_product_id) BETWEEN 1 AND 200
    ),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE runtime_installations (
    installation_id TEXT PRIMARY KEY CHECK (
        length(installation_id) BETWEEN 1 AND 200
    ),
    runtime_product_id TEXT NOT NULL,
    distribution TEXT NOT NULL CHECK (
        distribution IN ('managed', 'system', 'remote')
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    FOREIGN KEY (runtime_product_id)
        REFERENCES runtime_products(runtime_product_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    UNIQUE (installation_id, runtime_product_id)
) STRICT;

CREATE TABLE runtime_builds (
    runtime_build_id TEXT PRIMARY KEY CHECK (
        length(runtime_build_id) BETWEEN 1 AND 200
    ),
    installation_id TEXT NOT NULL,
    runtime_product_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 1 AND 200),
    observed_version TEXT NOT NULL CHECK (
        length(observed_version) BETWEEN 1 AND 200
    ),
    artifact_sha256 TEXT NOT NULL CHECK (
        length(artifact_sha256) = 64
        AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
    verified_at INTEGER NOT NULL CHECK (verified_at >= first_seen_at),
    FOREIGN KEY (installation_id, runtime_product_id)
        REFERENCES runtime_installations(installation_id, runtime_product_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    UNIQUE (
        runtime_build_id,
        installation_id,
        runtime_product_id,
        adapter_id
    )
) STRICT;

CREATE TABLE runtime_connections (
    connection_id TEXT PRIMARY KEY CHECK (
        length(connection_id) BETWEEN 1 AND 200
    ),
    installation_id TEXT NOT NULL,
    runtime_product_id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
    connection_kind TEXT NOT NULL CHECK (
        connection_kind IN ('managed_local', 'system_local', 'remote')
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    FOREIGN KEY (installation_id, runtime_product_id)
        REFERENCES runtime_installations(installation_id, runtime_product_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    UNIQUE (connection_id, installation_id, runtime_product_id)
) STRICT;

CREATE TABLE projects (
    project_id TEXT PRIMARY KEY CHECK (length(project_id) BETWEEN 1 AND 200),
    canonical_path TEXT NOT NULL UNIQUE CHECK (length(canonical_path) > 0),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 500),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE working_copies (
    working_copy_id TEXT PRIMARY KEY CHECK (
        length(working_copy_id) BETWEEN 1 AND 200
    ),
    project_id TEXT NOT NULL,
    canonical_path TEXT NOT NULL UNIQUE CHECK (length(canonical_path) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('root', 'worktree')),
    branch_name TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    FOREIGN KEY (project_id)
        REFERENCES projects(project_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    UNIQUE (working_copy_id, project_id)
) STRICT;

CREATE TABLE sessions (
    farfold_session_id TEXT PRIMARY KEY CHECK (
        length(farfold_session_id) BETWEEN 1 AND 200
    ),
    runtime_product_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    runtime_build_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    working_copy_id TEXT NOT NULL,
    native_session_id TEXT NOT NULL CHECK (
        length(native_session_id) BETWEEN 1 AND 200
    ),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
    title_source TEXT NOT NULL CHECK (
        title_source IN ('native', 'first_user', 'manual')
    ),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    last_opened_at INTEGER NOT NULL CHECK (last_opened_at >= created_at),
    FOREIGN KEY (
        runtime_build_id,
        installation_id,
        runtime_product_id,
        adapter_id
    ) REFERENCES runtime_builds(
        runtime_build_id,
        installation_id,
        runtime_product_id,
        adapter_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (connection_id, installation_id, runtime_product_id)
        REFERENCES runtime_connections(
            connection_id,
            installation_id,
            runtime_product_id
        )
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    FOREIGN KEY (working_copy_id, project_id)
        REFERENCES working_copies(working_copy_id, project_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    UNIQUE (
        runtime_product_id,
        installation_id,
        connection_id,
        native_session_id
    )
) STRICT;

CREATE TABLE session_drafts (
    farfold_session_id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    FOREIGN KEY (farfold_session_id)
        REFERENCES sessions(farfold_session_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE
) STRICT;

CREATE TABLE session_attention (
    attention_id TEXT PRIMARY KEY CHECK (length(attention_id) BETWEEN 1 AND 200),
    farfold_session_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 200),
    runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 0),
    native_interaction_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'stale')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    FOREIGN KEY (farfold_session_id)
        REFERENCES sessions(farfold_session_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE
) STRICT;

CREATE TABLE app_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    last_project_id TEXT,
    last_session_id TEXT,
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    FOREIGN KEY (last_project_id)
        REFERENCES projects(project_id)
        ON UPDATE RESTRICT
        ON DELETE SET NULL,
    FOREIGN KEY (last_session_id)
        REFERENCES sessions(farfold_session_id)
        ON UPDATE RESTRICT
        ON DELETE SET NULL
) STRICT;

CREATE INDEX sessions_by_project_updated
    ON sessions(project_id, archived_at, updated_at DESC);

CREATE INDEX sessions_by_runtime_updated
    ON sessions(runtime_product_id, archived_at, updated_at DESC);

CREATE INDEX attention_by_session_status
    ON session_attention(farfold_session_id, status, updated_at DESC);
