CREATE TABLE runtime_owned_profiles_next (
    profile_id TEXT PRIMARY KEY CHECK (length(profile_id) BETWEEN 1 AND 200),
    layout TEXT NOT NULL CHECK (layout IN ('legacy_provider_bound_v1', 'stable_v1')),
    connection_id TEXT NOT NULL UNIQUE,
    installation_id TEXT NOT NULL,
    runtime_product_id TEXT NOT NULL,
    runtime_build_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    bootstrap_provider_connection_id TEXT,
    bootstrap_provider_config_version_id TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    CHECK ((bootstrap_provider_connection_id IS NOT NULL AND bootstrap_provider_config_version_id IS NOT NULL)
        OR (bootstrap_provider_connection_id IS NULL AND bootstrap_provider_config_version_id IS NULL
            AND layout = 'stable_v1' AND ((runtime_product_id = 'pi' AND adapter_id = 'pi-acp-stdio-v1')
                OR (runtime_product_id = 'codex' AND adapter_id = 'codex-acp-stdio-v1')))),
    FOREIGN KEY (connection_id, installation_id, runtime_product_id)
        REFERENCES runtime_connections(connection_id, installation_id, runtime_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (runtime_build_id, installation_id, runtime_product_id, adapter_id)
        REFERENCES runtime_builds(runtime_build_id, installation_id, runtime_product_id, adapter_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (bootstrap_provider_connection_id, bootstrap_provider_config_version_id)
        REFERENCES provider_connection_versions(provider_connection_id, config_version_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
INSERT INTO runtime_owned_profiles_next SELECT * FROM runtime_owned_profiles;
CREATE TEMP TABLE profile_versions_migration AS SELECT * FROM runtime_profile_provider_versions;
DROP TABLE runtime_profile_provider_versions;
DROP TABLE runtime_owned_profiles;
ALTER TABLE runtime_owned_profiles_next RENAME TO runtime_owned_profiles;
CREATE TABLE runtime_profile_provider_versions (
    profile_id TEXT NOT NULL,
    provider_connection_id TEXT NOT NULL,
    provider_config_version_id TEXT NOT NULL,
    authorized_at INTEGER NOT NULL CHECK (authorized_at >= 0),
    PRIMARY KEY (profile_id, provider_connection_id, provider_config_version_id),
    FOREIGN KEY (profile_id) REFERENCES runtime_owned_profiles(profile_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    FOREIGN KEY (provider_connection_id, provider_config_version_id)
        REFERENCES provider_connection_versions(provider_connection_id, config_version_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
INSERT INTO runtime_profile_provider_versions SELECT * FROM profile_versions_migration;
DROP TABLE profile_versions_migration;

-- Dependent launch metadata, not a second profile authority. Never credentials/history.
CREATE TABLE runtime_owned_profile_launches (
    profile_id TEXT PRIMARY KEY REFERENCES runtime_owned_profiles(profile_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    launch_json TEXT NOT NULL CHECK (length(launch_json) BETWEEN 1 AND 65536),
    last_generation INTEGER NOT NULL CHECK (last_generation BETWEEN 1 AND 9007199254740991)
) STRICT;

CREATE TABLE session_native_locators_next (
    farfold_session_id TEXT PRIMARY KEY REFERENCES sessions(farfold_session_id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    locator_kind TEXT NOT NULL CHECK (locator_kind IN ('pi_session_file', 'codex_tree_session_id')),
    locator_value TEXT NOT NULL CHECK (length(locator_value) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;
INSERT INTO session_native_locators_next SELECT * FROM session_native_locators;
DROP TABLE session_native_locators;
ALTER TABLE session_native_locators_next RENAME TO session_native_locators;
-- Multiple native threads can belong to the same Codex tree. Pi file ownership
-- remains unique exactly as before; a tree ID is not a file locator.
CREATE UNIQUE INDEX unique_pi_session_locator ON session_native_locators(locator_kind, locator_value)
    WHERE locator_kind = 'pi_session_file';

-- Immutable selection/actual-confirmation evidence attached to the shared Session.
-- No directory snapshot, account, credential, or native history is persisted here.
ALTER TABLE sessions ADD COLUMN native_model_selection_json TEXT
    CHECK (native_model_selection_json IS NULL OR
        (json_valid(native_model_selection_json) AND length(native_model_selection_json) <= 8192));
CREATE TRIGGER immutable_session_native_model_selection
BEFORE UPDATE OF native_model_selection_json ON sessions
WHEN OLD.native_model_selection_json IS NOT NULL
    AND NEW.native_model_selection_json IS NOT OLD.native_model_selection_json
BEGIN SELECT RAISE(ABORT, 'original native model selection is immutable'); END;
