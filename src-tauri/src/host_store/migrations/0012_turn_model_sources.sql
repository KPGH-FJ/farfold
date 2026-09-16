CREATE UNIQUE INDEX session_native_turn_binding_identity ON sessions (
    farfold_session_id, native_session_id, connection_id,
    installation_id, runtime_product_id, runtime_build_id, adapter_id
);

CREATE TABLE turn_provider_bindings_v12 (
    host_turn_id TEXT PRIMARY KEY CHECK (length(host_turn_id) BETWEEN 1 AND 200),
    source_kind TEXT NOT NULL DEFAULT 'managed_version' CHECK (
        source_kind IN ('managed_version', 'native_observation')
    ),
    provider_connection_id TEXT,
    provider_config_version_id TEXT,
    runtime_product_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    runtime_connection_id TEXT NOT NULL,
    runtime_provider_id TEXT NOT NULL CHECK (length(runtime_provider_id) BETWEEN 1 AND 200),
    runtime_model_id TEXT NOT NULL CHECK (length(runtime_model_id) BETWEEN 1 AND 512),
    bound_at INTEGER NOT NULL CHECK (bound_at >= 0),
    farfold_session_id TEXT,
    native_session_id TEXT,
    runtime_build_id TEXT,
    adapter_id TEXT,
    runtime_generation INTEGER,
    native_model_id TEXT,
    observed_at INTEGER,
    CHECK (
        (source_kind = 'managed_version'
            AND provider_connection_id IS NOT NULL
            AND provider_config_version_id IS NOT NULL
            AND farfold_session_id IS NULL AND native_session_id IS NULL
            AND runtime_build_id IS NULL AND adapter_id IS NULL
            AND runtime_generation IS NULL AND native_model_id IS NULL AND observed_at IS NULL)
        OR
        (source_kind = 'native_observation'
            AND provider_connection_id IS NULL AND provider_config_version_id IS NULL
            AND farfold_session_id IS NOT NULL AND native_session_id IS NOT NULL
            AND runtime_build_id IS NOT NULL AND adapter_id IS NOT NULL
            AND runtime_generation IS NOT NULL AND runtime_generation > 0
            AND native_model_id IS NOT NULL AND length(native_model_id) BETWEEN 1 AND 512
            AND observed_at IS NOT NULL AND observed_at >= 0 AND observed_at <= bound_at)
    ),
    FOREIGN KEY (provider_connection_id, provider_config_version_id)
        REFERENCES provider_connection_versions(provider_connection_id, config_version_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (
        provider_connection_id, runtime_product_id, installation_id, runtime_connection_id
    ) REFERENCES provider_target_projections (
        provider_connection_id, runtime_product_id, installation_id, runtime_connection_id
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (runtime_connection_id, installation_id, runtime_product_id)
        REFERENCES runtime_connections(connection_id, installation_id, runtime_product_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    FOREIGN KEY (
        farfold_session_id, native_session_id, runtime_connection_id,
        installation_id, runtime_product_id, runtime_build_id, adapter_id
    ) REFERENCES sessions (
        farfold_session_id, native_session_id, connection_id,
        installation_id, runtime_product_id, runtime_build_id, adapter_id
    ) ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT;

INSERT INTO turn_provider_bindings_v12 (
    host_turn_id, provider_connection_id, provider_config_version_id,
    runtime_product_id, installation_id, runtime_connection_id,
    runtime_provider_id, runtime_model_id, bound_at
) SELECT host_turn_id, provider_connection_id, provider_config_version_id,
    runtime_product_id, installation_id, runtime_connection_id,
    runtime_provider_id, runtime_model_id, bound_at
FROM turn_provider_bindings;

DROP TABLE turn_provider_bindings;
ALTER TABLE turn_provider_bindings_v12 RENAME TO turn_provider_bindings;
