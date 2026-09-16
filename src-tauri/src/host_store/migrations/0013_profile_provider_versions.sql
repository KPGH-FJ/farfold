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

INSERT INTO runtime_profile_provider_versions (
    profile_id, provider_connection_id, provider_config_version_id, authorized_at
)
SELECT profile_id, bootstrap_provider_connection_id, bootstrap_provider_config_version_id, created_at
FROM runtime_owned_profiles WHERE layout = 'stable_v1';
