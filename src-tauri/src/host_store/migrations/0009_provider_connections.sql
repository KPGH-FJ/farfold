CREATE TABLE provider_connections (
    provider_connection_id TEXT PRIMARY KEY CHECK (
        length(provider_connection_id) BETWEEN 1 AND 200
    ),
    provider_key TEXT NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 200),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
    source TEXT NOT NULL CHECK (
        source IN ('farfold_managed', 'native_unmanaged')
    ),
    current_config_version_id TEXT NOT NULL CHECK (
        length(current_config_version_id) BETWEEN 1 AND 200
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE provider_connection_versions (
    provider_connection_id TEXT NOT NULL,
    config_version_id TEXT NOT NULL CHECK (
        length(config_version_id) BETWEEN 1 AND 200
    ),
    endpoint_fingerprint TEXT NOT NULL CHECK (
        length(endpoint_fingerprint) BETWEEN 1 AND 200
    ),
    model_mapping_fingerprint TEXT NOT NULL CHECK (
        length(model_mapping_fingerprint) BETWEEN 1 AND 200
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (provider_connection_id, config_version_id),
    FOREIGN KEY (provider_connection_id)
        REFERENCES provider_connections(provider_connection_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE
) STRICT;

CREATE TABLE provider_target_projections (
    provider_connection_id TEXT NOT NULL,
    runtime_product_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    runtime_connection_id TEXT NOT NULL,
    config_version_id TEXT NOT NULL,
    runtime_provider_id TEXT NOT NULL CHECK (
        length(runtime_provider_id) BETWEEN 1 AND 200
    ),
    runtime_model_id TEXT NOT NULL CHECK (
        length(runtime_model_id) BETWEEN 1 AND 512
    ),
    save_state TEXT NOT NULL CHECK (
        save_state IN ('not_saved', 'saved', 'failed')
    ),
    apply_state TEXT NOT NULL CHECK (
        apply_state IN ('not_applicable', 'pending', 'applied', 'needs_restart', 'failed')
    ),
    request_state TEXT NOT NULL CHECK (
        request_state IN ('not_requested', 'verified_success', 'verified_failure')
    ),
    request_verified_version_id TEXT CHECK (
        request_verified_version_id IS NULL
        OR length(request_verified_version_id) BETWEEN 1 AND 200
    ),
    active_task_policy TEXT NOT NULL CHECK (
        active_task_policy IN ('current_task_keeps_bound_config', 'applies_immediately')
    ),
    detail TEXT CHECK (detail IS NULL OR length(detail) <= 1000),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (
        provider_connection_id,
        runtime_product_id,
        installation_id,
        runtime_connection_id
    ),
    FOREIGN KEY (provider_connection_id, config_version_id)
        REFERENCES provider_connection_versions(provider_connection_id, config_version_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE,
    FOREIGN KEY (runtime_connection_id, installation_id, runtime_product_id)
        REFERENCES runtime_connections(connection_id, installation_id, runtime_product_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
) STRICT;

CREATE TABLE turn_provider_bindings (
    host_turn_id TEXT PRIMARY KEY CHECK (length(host_turn_id) BETWEEN 1 AND 200),
    provider_connection_id TEXT NOT NULL,
    provider_config_version_id TEXT NOT NULL,
    runtime_product_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    runtime_connection_id TEXT NOT NULL,
    runtime_provider_id TEXT NOT NULL CHECK (
        length(runtime_provider_id) BETWEEN 1 AND 200
    ),
    runtime_model_id TEXT NOT NULL CHECK (
        length(runtime_model_id) BETWEEN 1 AND 512
    ),
    bound_at INTEGER NOT NULL CHECK (bound_at >= 0),
    FOREIGN KEY (provider_connection_id, provider_config_version_id)
        REFERENCES provider_connection_versions(provider_connection_id, config_version_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    FOREIGN KEY (
        provider_connection_id,
        runtime_product_id,
        installation_id,
        runtime_connection_id
    )
        REFERENCES provider_target_projections(
            provider_connection_id,
            runtime_product_id,
            installation_id,
            runtime_connection_id
        )
        ON UPDATE RESTRICT
        ON DELETE RESTRICT
) STRICT;

CREATE INDEX provider_target_projections_by_runtime
    ON provider_target_projections(runtime_product_id, installation_id, runtime_connection_id);
