# Upgrade Enterprise PostgreSQL from PR 795 to 1.3.0

Use this package for the vanilla PostgreSQL backend of Enterprise API `1.0.pr795-f68e836-SNAPSHOT`. It also recognizes the November preview `1.0.2611250437-SNAPSHOT`. The bridge upgrades the existing application schema in place. Allow downtime for table rewrites and index creation. Measure the duration and disk requirements on a restored copy of your database.

## Before the upgrade

1. Using a superadmin session, record the result of `GET /license/status` privately. Check the license ID, offline flag, restriction and expiry. Keep the existing image tag, application configuration and secret versions for rollback.
2. Retain the **exact** `LICENSE_STATE_ENCRYPTION_KEY` if one is configured. If the deployment uses a database-managed state key, leave that setting unset and keep the entire database. Retain the original offline bundle, any configured installation-key file, and the same secret mounts and file permissions. Keep these in your existing secret storage.
3. Identify the database and schema from the Enterprise write connection, including any JDBC `currentSchema`. Connect directly to the writable primary as the application schema owner. Set `postgresql.recreateOnStart = false`. Stop all Enterprise replicas, workers and other writers using this database. Allow in-flight issuance and verification to finish before shutdown.
4. Back up the **entire** database and verify a restore to a separate database with the required roles and grants. Keep the backup private. For example, with a PostgreSQL service entry named `enterprise` and a new, access-controlled backup directory:

   ```sh
   umask 077
   pg_dump --dbname='service=enterprise' --format=custom --file=before-1.3.0.dump
   pg_restore --exit-on-error --dbname='service=enterprise_restore_test' before-1.3.0.dump
   ```

   The restore service must point to an empty, isolated database. During rehearsal, point the API only at the restored database. Keep the clone isolated from production traffic, license renewals and delivery services.

## Run the bridge

Run the commands from `breaking-changes-helper/1.3.0` so psql can open `upgrade.sql`. Use a PostgreSQL client compatible with your server. Replace `enterprise` and `public` with the write connection and schema you identified. Each command opens its own session.

```sh
# Execute the complete bridge and roll back.
psql 'service=enterprise' -X -q -v target_schema=public -f upgrade.sql

# After a passing rehearsal, commit the same changes.
psql 'service=enterprise' -X -q -v target_schema=public -v apply=true -f upgrade.sql
```

The script checks the preview ledger, requires a persisted credential and installation key, then runs both 1.3.0 SQL migrations. It checks every row in `enterprise_license_documents` against a transaction-local copy before committing. Existing license usage tables and the old migration ledger are retained. On startup, 1.3.0 records versions 0 and 1 in its own migration history and handles legacy usage-ledger adoption with the configured license state secret.

On the October layout the bridge translates top-level document discriminators only for the adapters that use them, preserves nested JSON, backfills event storage times from numeric epoch-millisecond timestamps, and converts cluster heartbeats to timestamps. Events lacking a numeric timestamp use the migration time. Existing certificate identities without a canonical subject hash remain available through the 1.3.0 trust registry’s unkeyed-certificate lookup. If you use a trust registry, verify lookup with an existing certificate after the upgrade.

An error aborts the transaction. Keep the database backup and resolve the reported condition before retrying. The bridge refuses unknown migration histories, conflicting document discriminators and ambiguous control characters in registry paths. On PostgreSQL 13–16 it also refuses custom dependencies on a generated discriminator that it has to replace. A successful bridge can be rerun before the application starts. Once 1.3.0 records successful migrations, use its history to verify completion.

## Start and verify

1. Start **one** Enterprise API replica on `1.3.0`, using the original database, schema and license configuration. Check startup logs for `Database migrations completed` and `Found persisted license VC in store`. Confirm that the API serves requests.
2. In the application schema, confirm both versions have a successful run. Earlier failed attempts can remain in the history.

   ```sql
   SELECT version, success, completed_at
   FROM migrations
   WHERE version IN (0, 1) AND success IS TRUE
   ORDER BY version;
   ```

3. Check `GET /license/status` again using a superadmin session. Verify the same license ID, `offline: true` for an offline installation, the expected expiry and restriction, and that licensed operations work. Verify representative existing tenants, resources and any retained audit or trust records. Restore the remaining replicas after these checks pass.

If startup or these checks fail, stop the new replicas. Restore the pre-upgrade dump into a separate empty database, verify it, and point the previous image and original secrets at that restored database. Keep the upgraded database available for diagnosis. Writes accepted by 1.3.0 after cutover need separate reconciliation before rolling back.

## Verification

The October release image initialized the test databases used to verify this bridge on PostgreSQL 16 and 18. On PostgreSQL 18 the October image activated a signed offline development license. After upgrading, the production 1.3.0 image loaded the persisted credential and installation key with no seed bundle or installation-key file mounted, reported `ACTIVE`, and began serving with the database and API isolated from external networks. Rehearse with your own backup, configuration and data volumes before upgrading.

The two numbered SQL files are the original Enterprise v1.3.0 release resources from commit `dcbcbbe98795fa94591982bed9a84f1fc2738f91`. The October preview was built from Enterprise PR merge commit `f68e83666fdb99450294e0398f62c0e7abf91e43`.
