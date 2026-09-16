CREATE TABLE runtime_owned_profiles (
    profile_id TEXT PRIMARY KEY CHECK (length(profile_id) BETWEEN 1 AND 200),
    layout TEXT NOT NULL CHECK (layout IN ('legacy_provider_bound_v1', 'stable_v1')),
    connection_id TEXT NOT NULL UNIQUE,
    installation_id TEXT NOT NULL,
    runtime_product_id TEXT NOT NULL,
    runtime_build_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    bootstrap_provider_connection_id TEXT NOT NULL,
    bootstrap_provider_config_version_id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
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
