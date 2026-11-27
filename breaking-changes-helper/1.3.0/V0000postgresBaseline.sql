/*
 * Baseline PostgreSQL schema (migration version 0, V0000migrationPostgresBaseline): document, wallet credential status, issuer metadata, trust,
 * verifier session, status-list, usage, and license tables.
 *
 * Requires PostgreSQL 13 or later (gen_random_uuid() is built in from 13).
 * Released migrations are never edited; later changes go into a new versioned script.
 */

-- =====================================================================================================================
-- License
-- =====================================================================================================================

/*
 * Licence documents (checkpoints and other licence state). A recreate and drop() keep them.
 */
CREATE TABLE IF NOT EXISTS enterprise_license_documents
(
    collection TEXT  NOT NULL,
    id         TEXT  NOT NULL,
    data       JSONB NOT NULL,
    PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS enterprise_license_documents_data_gin
    ON enterprise_license_documents USING GIN (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS enterprise_license_checkpoints
    ON enterprise_license_documents (
                                     (data ->> 'licenseId'),
                                     (data ->> 'period'),
                                     (data ->> 'podId'),
                                     ((data ->> 'sequence')::bigint)
        )
    WHERE collection = 'license_usage_checkpoints';

/*
 * Mirrors the MongoDB `license_usage_operations` and `license_usage_periods` collections (indexes as in V0016):
 * one row per durable usage operation and one per licence and period, each sealed with UsageStateIntegrity's
 * MACs. `license_usage_rate` holds the rolling-hour buckets that MongoDB keeps in its `<licence>:rolling-hour`
 * period document.
 *
 * The rows are licence data: a recreate and drop() keep them, as they keep enterprise_license_documents.
 * A recreate also keeps ledger documents that an earlier build wrote to enterprise_license_documents.
 * They are not moved here, because sealing needs the licence state secret, which is configured only after the
 * schema is migrated. PostgresUsageAccounting moves them when usage accounting starts.
 *
 * Committed operations are kept, as on MongoDB: the period's integrity root is checked against them. The
 * partial index covers the operations that reconciliation sweeps, which are few.
 */
CREATE TABLE IF NOT EXISTS license_usage_operations
(
    license_id        TEXT COLLATE "C" NOT NULL,
    operation_id      TEXT COLLATE "C" NOT NULL,
    period            TEXT             NOT NULL,
    type              TEXT             NOT NULL,
    hour              TEXT             NOT NULL,
    minute            BIGINT           NOT NULL,
    rate_accounted    BOOLEAN          NOT NULL,
    amount            BIGINT           NOT NULL,
    reserved_amount   BIGINT           NOT NULL,
    state             TEXT             NOT NULL,
    successful_amount BIGINT,
    owner_id          TEXT,
    created_at        TIMESTAMPTZ      NOT NULL,
    updated_at        TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    integrity_version INT              NOT NULL,
    integrity_mac     TEXT             NOT NULL,
    PRIMARY KEY (license_id, operation_id)
);
CREATE INDEX IF NOT EXISTS license_usage_operations_period ON license_usage_operations (license_id, period);
CREATE INDEX IF NOT EXISTS license_usage_operations_minute ON license_usage_operations (license_id, minute);
CREATE INDEX IF NOT EXISTS license_usage_operations_open
    ON license_usage_operations (state, created_at) WHERE state <> 'COMMITTED';

CREATE TABLE IF NOT EXISTS license_usage_periods
(
    license_id      TEXT COLLATE "C" NOT NULL,
    period          TEXT             NOT NULL,
    counts          JSONB            NOT NULL,
    reserved        JSONB            NOT NULL,
    active_count    BIGINT           NOT NULL,
    report_version  BIGINT           NOT NULL,
    report_sequence BIGINT           NOT NULL,
    report_dirty    BOOLEAN          NOT NULL,
    root_version    BIGINT           NOT NULL,
    committed_count BIGINT           NOT NULL,
    committed_xor   TEXT             NOT NULL,
    root_mac        TEXT             NOT NULL,
    report_mac      TEXT             NOT NULL,
    PRIMARY KEY (license_id, period)
);

CREATE TABLE IF NOT EXISTS license_usage_rate
(
    license_id TEXT COLLATE "C" PRIMARY KEY,
    buckets    JSONB NOT NULL
);

-- =====================================================================================================================
-- Helper functions
-- =====================================================================================================================

/*
 * Parses an ISO-8601 instant with an explicit offset, as kotlinx Instant serializes it (e.g. 2026-11-23T10:15:30.123Z).
 * The text-to-timestamptz cast is only STABLE because it can depend on TimeZone and DateStyle. With an explicit
 * offset in the input it does not, so declaring it IMMUTABLE is safe and lets generated columns and indexes use it.
 */
CREATE OR REPLACE FUNCTION enterprise_iso_instant(value TEXT) RETURNS TIMESTAMPTZ
    LANGUAGE sql
    IMMUTABLE
    STRICT
    PARALLEL SAFE
AS
$$
SELECT value::timestamptz
$$;

CREATE TABLE IF NOT EXISTS enterprise_eidas_audit
(
    organization_id TEXT        NOT NULL,
    sequence_number BIGINT      NOT NULL,
    entry_hash      TEXT        NOT NULL,
    data            JSONB       NOT NULL,
    PRIMARY KEY (organization_id, sequence_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_eidas_entry_id
    ON enterprise_eidas_audit ((data ->> 'id'));
CREATE INDEX IF NOT EXISTS enterprise_eidas_target
    ON enterprise_eidas_audit (organization_id, (data ->> 'target'), sequence_number);
CREATE INDEX IF NOT EXISTS enterprise_eidas_session
    ON enterprise_eidas_audit (organization_id, (data ->> 'sessionId'), sequence_number);
CREATE INDEX IF NOT EXISTS enterprise_eidas_nonce
    ON enterprise_eidas_audit (organization_id, (data ->> 'nonceHash'));
CREATE INDEX IF NOT EXISTS enterprise_eidas_time
    ON enterprise_eidas_audit (organization_id, ((data ->> 'timestamp')::bigint));

CREATE TABLE IF NOT EXISTS verifier2_processing_claims
(
    id         TEXT PRIMARY KEY,
    owner      TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

-- =====================================================================================================================
-- Document collections: one table per collection; the expiring ones get a tighter autovacuum
-- =====================================================================================================================

CREATE TABLE IF NOT EXISTS organizations
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS organizations_parent_type ON organizations (parent, doc_type);
CREATE INDEX IF NOT EXISTS organizations_expire ON organizations (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS organizations_data_gin ON organizations USING GIN (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS accounts
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS accounts_parent_type ON accounts (parent, doc_type);
CREATE INDEX IF NOT EXISTS accounts_expire ON accounts (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS accounts_data_gin ON accounts USING GIN (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS auth_account_identifiers
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS auth_account_identifiers_parent_type ON auth_account_identifiers (parent, doc_type);
CREATE INDEX IF NOT EXISTS auth_account_identifiers_expire ON auth_account_identifiers (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_account_identifiers_data_gin ON auth_account_identifiers USING GIN (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS auth_data
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS auth_data_parent_type ON auth_data (parent, doc_type);
CREATE INDEX IF NOT EXISTS auth_data_expire ON auth_data (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_data_data_gin ON auth_data USING GIN (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS host_aliases
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS host_aliases_parent_type ON host_aliases (parent, doc_type);
CREATE INDEX IF NOT EXISTS host_aliases_expire ON host_aliases (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS host_aliases_data_gin ON host_aliases USING GIN (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS events
(
    id                 TEXT COLLATE "C" NOT NULL,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED,
    stored_at          TIMESTAMPTZ      NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS events_parent_type ON events (parent, doc_type);
CREATE INDEX IF NOT EXISTS events_expire ON events (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_data_gin ON events USING GIN (data jsonb_path_ops);
-- The events' write time, which MongoDB stamps as `storedAt` for its retention TTL index.
CREATE INDEX IF NOT EXISTS events_stored_at ON events (stored_at);

/*
 * created_at mirrors the tree entry's `createdAt` and serves sorting: the (parent, created_at, id) index returns
 * an entry's children in creation order, with id as the tie-breaker of a total order.
 */
CREATE TABLE IF NOT EXISTS organization_trees
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED,
    created_at         TIMESTAMPTZ GENERATED ALWAYS AS (enterprise_iso_instant(data ->> 'createdAt')) STORED
);
CREATE INDEX IF NOT EXISTS organization_trees_parent_type ON organization_trees (parent, doc_type);
CREATE INDEX IF NOT EXISTS organization_trees_parent_created_at ON organization_trees (parent, created_at, id);
CREATE INDEX IF NOT EXISTS organization_trees_created_at ON organization_trees (created_at, id);
CREATE INDEX IF NOT EXISTS organization_trees_expire ON organization_trees (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS organization_trees_data_gin ON organization_trees USING GIN (data jsonb_path_ops);
ALTER TABLE organization_trees SET (autovacuum_vacuum_scale_factor = 0.02);

CREATE TABLE IF NOT EXISTS authorization_codes
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS authorization_codes_parent_type ON authorization_codes (parent, doc_type);
CREATE INDEX IF NOT EXISTS authorization_codes_expire ON authorization_codes (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS authorization_codes_data_gin ON authorization_codes USING GIN (data jsonb_path_ops);
ALTER TABLE authorization_codes SET (autovacuum_vacuum_scale_factor = 0.02);

CREATE TABLE IF NOT EXISTS pre_authorized_codes
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS pre_authorized_codes_parent_type ON pre_authorized_codes (parent, doc_type);
CREATE INDEX IF NOT EXISTS pre_authorized_codes_expire ON pre_authorized_codes (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS pre_authorized_codes_data_gin ON pre_authorized_codes USING GIN (data jsonb_path_ops);
ALTER TABLE pre_authorized_codes SET (autovacuum_vacuum_scale_factor = 0.02);

CREATE TABLE IF NOT EXISTS par_entries
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS par_entries_parent_type ON par_entries (parent, doc_type);
CREATE INDEX IF NOT EXISTS par_entries_expire ON par_entries (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS par_entries_data_gin ON par_entries USING GIN (data jsonb_path_ops);
ALTER TABLE par_entries SET (autovacuum_vacuum_scale_factor = 0.02);

CREATE TABLE IF NOT EXISTS wallet_issuance_sessions
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS wallet_issuance_sessions_parent_type ON wallet_issuance_sessions (parent, doc_type);
CREATE INDEX IF NOT EXISTS wallet_issuance_sessions_expire ON wallet_issuance_sessions (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_issuance_sessions_data_gin ON wallet_issuance_sessions USING GIN (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS wallet_credential_status
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS wallet_credential_status_parent_type ON wallet_credential_status (parent, doc_type);
CREATE INDEX IF NOT EXISTS wallet_credential_status_expire ON wallet_credential_status (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_credential_status_data_gin ON wallet_credential_status USING GIN (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS issuer_type_metadata
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS issuer_type_metadata_parent_type ON issuer_type_metadata (parent, doc_type);
CREATE INDEX IF NOT EXISTS issuer_type_metadata_expire ON issuer_type_metadata (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS issuer_type_metadata_data_gin ON issuer_type_metadata USING GIN (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS refresh_tokens
(
    id                 TEXT COLLATE "C" PRIMARY KEY,
    data               JSONB            NOT NULL,
    parent             TEXT COLLATE "C" GENERATED ALWAYS AS (data ->> 'parent') STORED,
    doc_type           TEXT GENERATED ALWAYS AS (data ->> '_t') STORED,
    expire_at_epoch_ms BIGINT GENERATED ALWAYS AS (
        CASE WHEN jsonb_exists(data, 'expireAtEpochMs') THEN (data ->> 'expireAtEpochMs')::bigint END
        ) STORED
);
CREATE INDEX IF NOT EXISTS refresh_tokens_parent_type ON refresh_tokens (parent, doc_type);
CREATE INDEX IF NOT EXISTS refresh_tokens_expire ON refresh_tokens (expire_at_epoch_ms) WHERE expire_at_epoch_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_data_gin ON refresh_tokens USING GIN (data jsonb_path_ops);
ALTER TABLE refresh_tokens SET (autovacuum_vacuum_scale_factor = 0.02);

-- =====================================================================================================================
-- Trust registry (references organization_trees, so it follows the document tables)
-- =====================================================================================================================

CREATE TABLE IF NOT EXISTS trust_registry_versions
(
    registry_id TEXT COLLATE "C" PRIMARY KEY REFERENCES organization_trees (id) ON DELETE CASCADE,
    version     BIGINT NOT NULL,
    generation  UUID   NOT NULL DEFAULT gen_random_uuid()
);

CREATE TABLE IF NOT EXISTS trust_sources
(
    registry_id TEXT COLLATE "C" NOT NULL REFERENCES organization_trees (id) ON DELETE CASCADE,
    source_id   TEXT             NOT NULL,
    payload     JSONB            NOT NULL,
    PRIMARY KEY (registry_id, source_id)
);

CREATE TABLE IF NOT EXISTS trust_entities
(
    registry_id TEXT COLLATE "C" NOT NULL REFERENCES organization_trees (id) ON DELETE CASCADE,
    entity_id   TEXT             NOT NULL,
    source_id   TEXT             NOT NULL,
    entity_type TEXT             NOT NULL,
    country     TEXT,
    payload     JSONB            NOT NULL,
    PRIMARY KEY (registry_id, entity_id)
);
CREATE INDEX IF NOT EXISTS trust_entities_type ON trust_entities (registry_id, entity_type);
CREATE INDEX IF NOT EXISTS trust_entities_source ON trust_entities (registry_id, source_id);

CREATE TABLE IF NOT EXISTS trust_services
(
    registry_id TEXT COLLATE "C" NOT NULL REFERENCES organization_trees (id) ON DELETE CASCADE,
    service_id  TEXT             NOT NULL,
    source_id   TEXT             NOT NULL,
    entity_id   TEXT             NOT NULL,
    status      TEXT             NOT NULL,
    payload     JSONB            NOT NULL,
    PRIMARY KEY (registry_id, service_id)
);
CREATE INDEX IF NOT EXISTS trust_services_entity ON trust_services (registry_id, entity_id);
CREATE INDEX IF NOT EXISTS trust_services_source ON trust_services (registry_id, source_id);

/*
 * canonical_subject_sha256 and its index mirror MongoDB migrations V0033 and V0034: chain resolution reads its
 * candidate anchors by the canonical subject key of their certificate, plus the certificate identities without one.
 * The index expression must match PostgresTrustRegistry.CANONICAL_SUBJECT_LOOKUP.
 */
CREATE TABLE IF NOT EXISTS trust_identities
(
    registry_id              TEXT COLLATE "C" NOT NULL REFERENCES organization_trees (id) ON DELETE CASCADE,
    identity_id              TEXT             NOT NULL,
    source_id                TEXT             NOT NULL,
    entity_id                TEXT             NOT NULL,
    service_id               TEXT,
    certificate_sha256       TEXT,
    subject_dn               TEXT,
    issuer_dn                TEXT,
    serial_number            TEXT,
    subject_key_identifier   TEXT,
    jwk_thumbprint           TEXT,
    certificate_der          BYTEA,
    canonical_subject_sha256 TEXT,
    payload                  JSONB            NOT NULL,
    PRIMARY KEY (registry_id, identity_id)
);
CREATE INDEX IF NOT EXISTS trust_identities_sha ON trust_identities (registry_id, certificate_sha256);
CREATE INDEX IF NOT EXISTS trust_identities_subject ON trust_identities (registry_id, subject_dn);
CREATE INDEX IF NOT EXISTS trust_identities_ski ON trust_identities (registry_id, subject_key_identifier);
CREATE INDEX IF NOT EXISTS trust_identities_issuer_serial ON trust_identities (registry_id, issuer_dn, serial_number);
CREATE INDEX IF NOT EXISTS trust_identities_thumbprint ON trust_identities (registry_id, jwk_thumbprint);
CREATE INDEX IF NOT EXISTS trust_identities_entity ON trust_identities (registry_id, entity_id);
CREATE INDEX IF NOT EXISTS trust_identities_source ON trust_identities (registry_id, source_id);
CREATE INDEX IF NOT EXISTS trust_identities_canonical_subject
    ON trust_identities (registry_id, (CASE WHEN certificate_der IS NOT NULL THEN coalesce(canonical_subject_sha256, '') END));

-- =====================================================================================================================
-- Verifier session state: the expiry sweep deletes by the index every minute; MongoDB has the same index (V0031)
-- =====================================================================================================================

CREATE TABLE IF NOT EXISTS verifier_session_state
(
    id          TEXT PRIMARY KEY,
    private_key TEXT,
    outcome     TEXT,
    owner       TEXT,
    claim_until TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS verifier_session_state_expires_at ON verifier_session_state (expires_at);

-- =====================================================================================================================
-- Status lists
-- =====================================================================================================================

CREATE TABLE IF NOT EXISTS status_list_state
(
    list_id           TEXT COLLATE "C" PRIMARY KEY,
    used              BIGINT  NOT NULL,
    version           BIGINT  NOT NULL,
    published_version BIGINT  NOT NULL,
    ready             BOOLEAN NOT NULL,
    lease_owner       TEXT,
    lease_until       BIGINT
);

CREATE TABLE IF NOT EXISTS status_list_entries
(
    list_id          TEXT COLLATE "C" NOT NULL,
    idx              INT              NOT NULL,
    status           TEXT             NOT NULL,
    message          TEXT             NOT NULL,
    token            TEXT             NOT NULL DEFAULT '',
    reserved_until   BIGINT,
    pending_revision TEXT,
    PRIMARY KEY (list_id, idx)
);

CREATE TABLE IF NOT EXISTS status_list_objects
(
    id            TEXT COLLATE "C" PRIMARY KEY,
    content       BYTEA   NOT NULL,
    content_type  TEXT    NOT NULL,
    cache_control TEXT,
    generation    TEXT    NOT NULL,
    is_text       BOOLEAN NOT NULL
);

-- =====================================================================================================================
-- Usage aggregates: mirrors the MongoDB `usage_aggregates` collection; one row per pod's running total
-- =====================================================================================================================

CREATE TABLE IF NOT EXISTS usage_aggregates
(
    id           TEXT PRIMARY KEY,
    pod          TEXT        NOT NULL,
    organization TEXT,
    tenant       TEXT,
    service      TEXT,
    type         TEXT        NOT NULL,
    hour         TIMESTAMPTZ NOT NULL,
    count        BIGINT      NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_aggregates_organization_hour ON usage_aggregates (organization, hour);
CREATE INDEX IF NOT EXISTS usage_aggregates_retention ON usage_aggregates (hour);

-- =====================================================================================================================
-- Webhook delivery outbox: mirrors the MongoDB `webhook_deliveries` and `webhook_session_erasure` collections.
-- webhook_session_erasure holds each session owner's erasure generation; webhook_dispatches records the deliveries
-- a worker has been admitted to send, so an erasure can wait for them across replicas.
-- =====================================================================================================================

CREATE TABLE IF NOT EXISTS webhook_deliveries
(
    id          TEXT PRIMARY KEY,
    owner       TEXT,
    generation  BIGINT NOT NULL,
    payload     TEXT   NOT NULL,
    due_at      BIGINT NOT NULL,
    lease       TEXT,
    lease_until BIGINT,
    failed_at   BIGINT
);
CREATE INDEX IF NOT EXISTS webhook_due ON webhook_deliveries (due_at, id) WHERE failed_at IS NULL;
CREATE INDEX IF NOT EXISTS webhook_failed ON webhook_deliveries (failed_at) WHERE failed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_owner ON webhook_deliveries (owner, generation);

CREATE TABLE IF NOT EXISTS webhook_session_erasure
(
    owner      TEXT PRIMARY KEY,
    generation BIGINT  NOT NULL,
    deleted    BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_dispatches
(
    id         UUID PRIMARY KEY,
    owner      TEXT        NOT NULL,
    generation BIGINT      NOT NULL,
    worker     TEXT        NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX IF NOT EXISTS webhook_sending ON webhook_dispatches (owner, generation);
