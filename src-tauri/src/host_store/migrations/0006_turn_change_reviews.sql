CREATE TABLE turn_change_reviews (
    host_turn_id TEXT PRIMARY KEY CHECK (length(host_turn_id) BETWEEN 1 AND 200),
    farfold_session_id TEXT NOT NULL,
    working_copy_id TEXT NOT NULL,
    runtime_product_id TEXT NOT NULL,
    provenance_state TEXT NOT NULL CHECK (
        provenance_state IN (
            'capturing',
            'available',
            'project_level_only',
            'failed',
            'interrupted'
        )
    ),
    baseline_head_oid TEXT CHECK (
        baseline_head_oid IS NULL OR (
            length(baseline_head_oid) BETWEEN 40 AND 64
            AND baseline_head_oid NOT GLOB '*[^0-9a-f]*'
        )
    ),
    terminal_head_oid TEXT CHECK (
        terminal_head_oid IS NULL OR (
            length(terminal_head_oid) BETWEEN 40 AND 64
            AND terminal_head_oid NOT GLOB '*[^0-9a-f]*'
        )
    ),
    baseline_clean INTEGER NOT NULL CHECK (baseline_clean IN (0, 1)),
    managed_worktree INTEGER NOT NULL CHECK (managed_worktree IN (0, 1)),
    change_path_count INTEGER NOT NULL DEFAULT 0 CHECK (change_path_count >= 0),
    terminal_reason TEXT CHECK (terminal_reason IS NULL OR length(terminal_reason) BETWEEN 1 AND 200),
    started_at INTEGER NOT NULL CHECK (started_at >= 0),
    completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= started_at),
    reviewed_at INTEGER CHECK (reviewed_at IS NULL OR reviewed_at >= started_at),
    updated_at INTEGER NOT NULL CHECK (updated_at >= started_at),
    FOREIGN KEY (farfold_session_id)
        REFERENCES sessions(farfold_session_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    FOREIGN KEY (working_copy_id)
        REFERENCES working_copies(working_copy_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    FOREIGN KEY (runtime_product_id)
        REFERENCES runtime_products(runtime_product_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
) STRICT;

CREATE TABLE turn_change_paths (
    host_turn_id TEXT NOT NULL,
    relative_path TEXT NOT NULL CHECK (
        length(relative_path) BETWEEN 1 AND 4096
        AND substr(relative_path, 1, 1) != '/'
    ),
    previous_path TEXT CHECK (
        previous_path IS NULL OR (
            length(previous_path) BETWEEN 1 AND 4096
            AND substr(previous_path, 1, 1) != '/'
        )
    ),
    change_kind TEXT NOT NULL CHECK (
        change_kind IN ('added', 'modified', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted')
    ),
    PRIMARY KEY (host_turn_id, relative_path),
    FOREIGN KEY (host_turn_id)
        REFERENCES turn_change_reviews(host_turn_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE
) STRICT;

CREATE INDEX turn_change_reviews_by_session
    ON turn_change_reviews(farfold_session_id, started_at DESC);

CREATE INDEX turn_change_reviews_unreviewed
    ON turn_change_reviews(farfold_session_id)
    WHERE completed_at IS NOT NULL AND reviewed_at IS NULL;
