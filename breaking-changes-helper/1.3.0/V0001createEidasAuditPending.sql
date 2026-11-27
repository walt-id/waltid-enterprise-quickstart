CREATE TABLE IF NOT EXISTS enterprise_eidas_audit_pending (
    id TEXT PRIMARY KEY,
    partition INT NOT NULL,
    owner TEXT NOT NULL,
    evidence_timestamp BIGINT NOT NULL,
    data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS enterprise_eidas_audit_pending_partition
    ON enterprise_eidas_audit_pending (partition, evidence_timestamp, id);
CREATE INDEX IF NOT EXISTS enterprise_eidas_audit_pending_owner
    ON enterprise_eidas_audit_pending (owner);

-- Match the JSONB predicate used by the issuance receipt recovery query.
CREATE INDEX IF NOT EXISTS issuance_pending_audit ON organization_trees (id)
    WHERE (CASE jsonb_typeof(data #> '{pendingIssuanceAudit}')
        WHEN 'string' THEN length(data #>> '{pendingIssuanceAudit}') > 0
        WHEN 'array' THEN jsonb_array_length(data #> '{pendingIssuanceAudit}') > 0
        WHEN 'object' THEN (data #> '{pendingIssuanceAudit}') <> '{}'::jsonb
        WHEN 'number' THEN TRUE
        WHEN 'boolean' THEN TRUE
        ELSE FALSE
    END);
