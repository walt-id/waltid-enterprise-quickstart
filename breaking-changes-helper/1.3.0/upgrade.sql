-- PostgreSQL bridge for the PR 795 October snapshot and November test snapshot.
-- Run with psql -X -v target_schema=... -f upgrade.sql. Default is a rollback rehearsal.
\set ON_ERROR_STOP on
\set VERBOSITY terse
\if :{?target_schema}
\else
  \echo 'Specify the Enterprise database schema with -v target_schema=...'
  SELECT 1/0 AS target_schema_required;
\endif
\if :{?apply}
\else
  \set apply false
\endif
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL client_min_messages = warning;
SELECT set_config('search_path',format('%I, pg_temp', :'target_schema'),true);
SELECT set_config('walt_upgrade.schema', :'target_schema',true);
DO $guard$
DECLARE
    source_remark text;
    n integer;
BEGIN
    IF current_schema IS DISTINCT FROM current_setting('walt_upgrade.schema')
       OR current_schema IN ('pg_catalog','information_schema') OR current_schema LIKE 'pg\_%' THEN
        RAISE EXCEPTION 'Target schema does not exist, is reserved, or is inaccessible';
    END IF;
    IF to_regclass('enterprise_schema_migrations') IS NULL OR to_regclass('enterprise_documents') IS NOT NULL THEN
        RAISE EXCEPTION 'Missing legacy history or unsupported single-table preview';
    END IF;
    SELECT count(*), max(remark) FILTER (WHERE version=1) INTO n,source_remark FROM enterprise_schema_migrations;
    IF n <> 1 OR source_remark IS NULL OR source_remark NOT IN (
        'Baseline per-collection tables, trust tables, and C-collated paths',
        'Baseline document, wallet credential status, issuer metadata, trust, verifier session, status-list, usage, webhook, and license tables'
    ) THEN
        RAISE EXCEPTION 'Unrecognized PostgreSQL preview history';
    END IF;
    IF to_regclass('migrations') IS NOT NULL THEN
        IF EXISTS (SELECT FROM migrations WHERE success IS TRUE OR version <> 0 OR completed_at IS NULL) THEN
            RAISE EXCEPTION 'Release migrations have succeeded, are active, or have an unexpected version. Inspect history before running the bridge';
        END IF;
    END IF;
    LOCK TABLE enterprise_license_documents IN SHARE MODE;
    IF NOT EXISTS (SELECT FROM enterprise_license_documents WHERE collection='license_state' AND id='license'
                   AND length(data->>'rawVc')>0 AND length(data->>'installationKeyJwk')>0) THEN
        RAISE EXCEPTION 'Saved license credential or installation key missing. Check the database and schema before upgrading';
    END IF;
END
$guard$;

-- Assert equality of all existing license documents before commit. Temporary and session-local.
CREATE TEMP TABLE bridge_license_before ON COMMIT DROP AS
    SELECT collection,id,data FROM enterprise_license_documents;

-- Mirrors PostgresText.escapeElement for trust payloads written before that codec.
CREATE FUNCTION pg_temp.escape_preview_json(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT AS $fn$
BEGIN
    CASE jsonb_typeof(j)
        WHEN 'object' THEN RETURN coalesce((SELECT jsonb_object_agg(replace(key,chr(1),chr(1)||chr(2)),pg_temp.escape_preview_json(value)) FROM jsonb_each(j)), '{}'::jsonb);
        WHEN 'array' THEN RETURN coalesce((SELECT jsonb_agg(pg_temp.escape_preview_json(value) ORDER BY ord) FROM jsonb_array_elements(j) WITH ORDINALITY a(value,ord)), '[]'::jsonb);
        WHEN 'string' THEN RETURN to_jsonb(replace(j #>> '{}',chr(1),chr(1)||chr(2)));
        ELSE RETURN j;
    END CASE;
END
$fn$;

DO $bridge$
DECLARE
    tbl text;
    expr text;
    conflicting boolean;
    raw_registry boolean;
    setters text;
    predicates text;
    rel regclass;
    att smallint;
    old_expr constant text := 'COALESCE((data ->> ''_t''::text), (data ->> ''type''::text))';
    new_expr constant text := '(data ->> ''_t''::text)';
    original_october boolean;
    legacy_types text[] := ARRAY['organizations','auth_account_identifiers','auth_data','host_aliases','events','organization_trees'];
BEGIN
    -- This expression also makes the one-time trust encoding conversion safe on retries.
    SELECT pg_get_expr(d.adbin,d.adrelid) INTO expr FROM pg_attrdef d JOIN pg_attribute a
      ON (a.attrelid,a.attnum)=(d.adrelid,d.adnum) WHERE a.attrelid='organization_trees'::regclass AND a.attname='doc_type';
    IF expr IS NULL OR expr NOT IN (old_expr,new_expr) THEN RAISE EXCEPTION 'Unrecognized organization_trees discriminator'; END IF;
    original_october := expr = old_expr;
    IF original_october AND (SELECT remark FROM enterprise_schema_migrations WHERE version=1) <>
        'Baseline per-collection tables, trust tables, and C-collated paths' THEN RAISE EXCEPTION 'Preview history and table shape disagree'; END IF;

    FOREACH tbl IN ARRAY legacy_types || ARRAY['accounts','authorization_codes','pre_authorized_codes','par_entries','wallet_issuance_sessions','refresh_tokens'] LOOP
        rel := tbl::regclass;
        SELECT pg_get_expr(d.adbin,d.adrelid),a.attnum INTO expr,att FROM pg_attribute a JOIN pg_attrdef d
          ON (a.attrelid,a.attnum)=(d.adrelid,d.adnum) WHERE a.attrelid=rel AND a.attname='doc_type' AND a.attgenerated='s';
        IF expr IS NULL OR expr <> (CASE WHEN original_october THEN old_expr ELSE new_expr END) THEN
            RAISE EXCEPTION 'Unexpected generated discriminator on %',tbl;
        END IF;
        IF original_october THEN
            IF tbl=ANY(legacy_types) THEN
                EXECUTE format('SELECT EXISTS (SELECT FROM %I WHERE data ? ''type'' AND data ? ''_t'' AND data->''type'' IS DISTINCT FROM data->''_t'')',tbl) INTO conflicting;
                IF conflicting THEN RAISE EXCEPTION 'Conflicting top-level type and _t in %. Resolve before upgrading',tbl; END IF;
                EXECUTE format('UPDATE %I SET data=(data-''type'') || jsonb_build_object(''_t'',data->''type'') WHERE data ? ''type''',tbl);
            END IF;
            IF current_setting('server_version_num')::integer >= 170000 THEN
                EXECUTE format('ALTER TABLE %I ALTER COLUMN doc_type SET EXPRESSION AS (data->>''_t'')',tbl);
            ELSE
                -- Older servers cannot replace a generated expression in place. Preserve custom dependencies.
                IF pg_get_indexdef(to_regclass(tbl||'_parent_type')) IS DISTINCT FROM
                    format('CREATE INDEX %I ON %I.%I USING btree (parent, doc_type)',tbl||'_parent_type',current_schema,tbl) THEN
                    RAISE EXCEPTION 'Unexpected parent/type index on %',tbl;
                END IF;
                EXECUTE format('DROP INDEX %I',tbl||'_parent_type');
                IF EXISTS (SELECT FROM pg_depend WHERE refclassid='pg_class'::regclass AND refobjid=rel AND refobjsubid=att
                           AND NOT (classid='pg_attrdef'::regclass AND objid IN (SELECT oid FROM pg_attrdef WHERE adrelid=rel AND adnum=att))) THEN
                    RAISE EXCEPTION 'Additional dependencies on %.doc_type require review',tbl;
                END IF;
                EXECUTE format('ALTER TABLE %I DROP COLUMN doc_type',tbl);
                EXECUTE format('ALTER TABLE %I ADD COLUMN doc_type text GENERATED ALWAYS AS (data->>''_t'') STORED',tbl);
            END IF;
        END IF;
    END LOOP;

    IF original_october THEN
        FOREACH tbl IN ARRAY ARRAY['trust_registry_versions','trust_sources','trust_entities','trust_services','trust_identities'] LOOP
            -- The registry path already references the escaped document ID. Ambiguous control characters in a
            -- legacy foreign key cannot safely be inferred from its printable representation.
            EXECUTE format('SELECT EXISTS (SELECT FROM %I WHERE strpos(registry_id,chr(1))>0)',tbl) INTO raw_registry;
            IF raw_registry THEN RAISE EXCEPTION 'Ambiguous control character in a legacy trust registry path on %',tbl; END IF;
            IF tbl='trust_registry_versions' THEN CONTINUE; END IF;
            SELECT string_agg(format('%1$I=replace(%1$I,chr(1),chr(1)||chr(2))',attname),', '),
                   string_agg(format('strpos(%I,chr(1))>0',attname),' OR ')
              INTO setters,predicates FROM pg_attribute
              WHERE attrelid=tbl::regclass AND attnum>0 AND NOT attisdropped AND atttypid='text'::regtype
                AND attname IN ('source_id','entity_id','service_id','identity_id','country','certificate_sha256','subject_dn','issuer_dn','serial_number','subject_key_identifier','jwk_thumbprint');
            EXECUTE format('UPDATE %I SET %s, payload=pg_temp.escape_preview_json(payload) WHERE %s OR strpos(payload::text,$1)>0',tbl,setters,predicates)
              USING chr(92)||'u0001';
        END LOOP;
    END IF;

    IF (SELECT atttypid FROM pg_attribute WHERE attrelid='enterprise_cluster_nodes'::regclass AND attname='heartbeat')='text'::regtype THEN
        ALTER TABLE enterprise_cluster_nodes ALTER COLUMN heartbeat TYPE timestamptz USING heartbeat::timestamptz;
        ALTER TABLE enterprise_cluster_nodes ALTER COLUMN heartbeat SET DEFAULT now();
    END IF;
    IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid='events'::regclass AND attname='stored_at' AND NOT attisdropped) THEN
        ALTER TABLE events ADD COLUMN stored_at timestamptz;
        UPDATE events SET stored_at=CASE WHEN jsonb_typeof(data->'timestamp')='number'
            THEN to_timestamp((data->>'timestamp')::numeric / 1000) ELSE transaction_timestamp() END;
        ALTER TABLE events ALTER COLUMN stored_at SET DEFAULT clock_timestamp(), ALTER COLUMN stored_at SET NOT NULL;
    END IF;
    ALTER TABLE trust_identities ADD COLUMN IF NOT EXISTS canonical_subject_sha256 text;
END
$bridge$;

-- Identical signature and definition to the 1.3.0 baseline, needed by the existing table.
CREATE OR REPLACE FUNCTION enterprise_iso_instant(value text) RETURNS timestamptz
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT value::timestamptz $$;
ALTER TABLE organization_trees ADD COLUMN IF NOT EXISTS created_at timestamptz
    GENERATED ALWAYS AS (enterprise_iso_instant(data->>'createdAt')) STORED;

-- Apply both release scripts in this transaction. The API records its own migration history on startup.
\ir V0000postgresBaseline.sql
\ir V0001createEidasAuditPending.sql

DO $verify$
BEGIN
    IF EXISTS ((TABLE bridge_license_before EXCEPT TABLE enterprise_license_documents)
               UNION ALL (TABLE enterprise_license_documents EXCEPT TABLE bridge_license_before)) THEN
        RAISE EXCEPTION 'License documents changed. Rolling back';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid='enterprise_cluster_nodes'::regclass AND attname='heartbeat' AND atttypid='timestamptz'::regtype)
       OR NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid='organization_trees'::regclass AND attname='created_at' AND attgenerated='s')
       OR to_regclass('organization_trees_parent_created_at') IS NULL OR to_regclass('enterprise_eidas_audit_pending') IS NULL THEN
       RAISE EXCEPTION 'Post-upgrade schema verification failed';
    END IF;
END
$verify$;
\if :apply
    COMMIT;
    \echo 'Bridge committed. Start one Enterprise 1.3.0 replica and verify migrations and license status.'
\else
    ROLLBACK;
    \echo 'Rehearsal passed. All database changes rolled back.'
\endif
