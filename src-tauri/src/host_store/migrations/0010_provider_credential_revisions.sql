ALTER TABLE provider_connection_versions
ADD COLUMN credential_revision_fingerprint TEXT NOT NULL DEFAULT 'credential:unknown'
CHECK (length(credential_revision_fingerprint) BETWEEN 1 AND 200);
