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
            AND layout = 'stable_v1' AND runtime_product_id = 'pi' AND adapter_id = 'pi-acp-stdio-v1')),
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
