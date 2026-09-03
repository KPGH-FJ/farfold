CREATE TABLE managed_worktrees (
    working_copy_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_working_copy_id TEXT NOT NULL,
    source_head_oid TEXT NOT NULL CHECK (
        length(source_head_oid) BETWEEN 40 AND 64
        AND source_head_oid NOT GLOB '*[^0-9a-f]*'
    ),
    branch_name TEXT NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 500),
    local_changes_choice TEXT NOT NULL CHECK (
        local_changes_choice IN ('clean', 'use_head_only')
    ),
    lifecycle_state TEXT NOT NULL CHECK (
        lifecycle_state IN ('creating', 'ready', 'orphaned')
    ),
    error_code TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    FOREIGN KEY (working_copy_id, project_id)
        REFERENCES working_copies(working_copy_id, project_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    FOREIGN KEY (source_working_copy_id, project_id)
        REFERENCES working_copies(working_copy_id, project_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    UNIQUE (project_id, branch_name)
) STRICT;

CREATE INDEX managed_worktrees_by_state
    ON managed_worktrees(lifecycle_state, updated_at DESC);
