CREATE TABLE session_native_locators (
    farfold_session_id TEXT PRIMARY KEY,
    locator_kind TEXT NOT NULL CHECK (
        locator_kind IN ('pi_session_file')
    ),
    locator_value TEXT NOT NULL CHECK (length(locator_value) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    FOREIGN KEY (farfold_session_id)
        REFERENCES sessions(farfold_session_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    UNIQUE (locator_kind, locator_value)
) STRICT;
