CREATE UNIQUE INDEX runtime_build_installation_identity
    ON runtime_builds(runtime_build_id, installation_id);

-- Only accepted program locators belong here. Authentication and native history
-- remain in the Runtime's own private environment.
CREATE TABLE system_installation_launches (
    installation_id TEXT PRIMARY KEY,
    runtime_build_id TEXT NOT NULL,
    selected_path TEXT NOT NULL UNIQUE CHECK (length(selected_path) BETWEEN 1 AND 4096),
    launch_json TEXT NOT NULL CHECK (json_valid(launch_json) AND length(launch_json) <= 65536),
    verified_at INTEGER NOT NULL CHECK (verified_at >= 0),
    FOREIGN KEY (runtime_build_id, installation_id)
        REFERENCES runtime_builds(runtime_build_id, installation_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
