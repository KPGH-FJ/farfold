CREATE TABLE managed_worktree_removals (
    working_copy_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    expected_path TEXT NOT NULL CHECK (length(expected_path) BETWEEN 1 AND 4096),
    expected_branch_name TEXT NOT NULL CHECK (
        length(expected_branch_name) BETWEEN 1 AND 500
    ),
    expected_head_oid TEXT NOT NULL CHECK (
        length(expected_head_oid) BETWEEN 40 AND 64
        AND expected_head_oid NOT GLOB '*[^0-9a-f]*'
    ),
    retains_branch INTEGER NOT NULL CHECK (retains_branch = 1),
    lifecycle_state TEXT NOT NULL CHECK (
        lifecycle_state IN ('removing', 'removed', 'failed')
    ),
    error_code TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= created_at),
    FOREIGN KEY (working_copy_id, project_id)
        REFERENCES working_copies(working_copy_id, project_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
) STRICT;

CREATE INDEX managed_worktree_removals_by_state
    ON managed_worktree_removals(lifecycle_state, updated_at DESC);
