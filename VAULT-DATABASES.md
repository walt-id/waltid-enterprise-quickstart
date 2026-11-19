# Vault database credentials

This opt-in Quickstart starts the Enterprise API against an external PostgreSQL or native MongoDB
database and an external Vault database secrets engine. It uses the native credential provider for
both the server and the image's `license` commands. Work is tracked under WAL-1809.

An Enterprise API image containing PR 908 is required. Set its full image reference in
`VAULT_ENTERPRISE_IMAGE`, including the registry, repository and tag or digest. The current stable
image tag does not establish feature availability. This Quickstart is based on the PostgreSQL
Quickstart foundation in PR 67. [Enterprise implementation](https://github.com/walt-id/waltid-identity-enterprise/pull/908),
[Quickstart foundation](https://github.com/walt-id/waltid-enterprise-quickstart/pull/67)

## Prepare the external services

The operator supplies a reachable database, a Vault database connection and role, and a Vault token
sink maintained by Vault Agent or an equivalent process. All Vault and database DNS names must
resolve inside the API container. Use an HTTPS Vault base URL with a trusted certificate and a
database connection string with the TLS settings your deployment requires.

Choose the role mode in `vault.env`.

| Mode | Vault credential endpoint | Refresh behavior |
| --- | --- | --- |
| `STATIC` | `database/static-creds/enterprise-api` | Poll the current password, validate changes and replace the pool credentials |
| `DYNAMIC` | `database/creds/enterprise-api` | Obtain a fresh login before lease expiry, validate it and drain the retired connections |

The mount and role names in the table are examples. The Vault token needs read access to the chosen
credential endpoint. For the dynamic example, an operator-managed policy contains the following.

```hcl
path "database/creds/enterprise-api" {
  capabilities = ["read"]
}
```

For a static role, use `database/static-creds/enterprise-api`. Set `VAULT_NAMESPACE` when the role
belongs to a Vault namespace. Token authentication, renewal and replacement belong to the external
token issuer. Keep tokens valid long enough for database lease overlap and connection drain.
[Vault database API](https://developer.hashicorp.com/vault/api-docs/secret/databases),
[Vault namespaces](https://developer.hashicorp.com/vault/api-docs#namespaces)

PostgreSQL roles need the schema, table, sequence and migration permissions used by the selected
Enterprise build. Dynamic users should share a stable application owner or equivalent grants, so
objects created by one login remain available to subsequent logins. Point every replica at the
primary. The licensing checkpoint engine is enabled in `config/license.conf`.
Set `VAULT_POSTGRESQL_SCHEMA` for a preprovisioned schema. Its default `public` preserves a
`currentSchema` parameter on the JDBC URL. Startup runs migrations, so the login requires the
corresponding DDL permissions.

MongoDB users need the application's read/write, transaction and startup migration permissions in
the selected database. Configure Vault's MongoDB plugin and set `VAULT_MONGODB_AUTH_SOURCE` to the
database where it creates the users, usually `admin`. Replica sets support the Enterprise
transaction paths. The template selects the native `MONGODB_8` profile.
[Vault MongoDB plugin](https://developer.hashicorp.com/vault/docs/secrets/databases/mongodb)

## Configure the Quickstart

1. Complete the Quickstart's dev-mode token setup and select a valid DEV license. The API uses
   `config/dev-mode-access.conf`, `config/license.conf` and the mounted `license/` directory.
   [Dev-mode setup](README.md#use-docker-compose), [licensing](LICENSING.md)

2. Copy the environment example and edit it with your image and service settings.

   ```bash
   test -f .env || cp .env.example .env
   cp vault.env.example vault.env
   mkdir -p secrets/vault-token certs/vault
   ```

   Select `config/database-vault-postgresql.conf` or `config/database-vault-mongodb.conf` in
   `VAULT_DATABASE_CONFIG`, then set the matching connection string and database name.
   Set `VAULT_DATABASE_ROLE_TYPE=STATIC` or `DYNAMIC`. Supply a credential-free database URL.
   The native provider obtains the username/password pair from Vault.

3. Configure the external token issuer to maintain `token` inside `VAULT_TOKEN_DIRECTORY`.
   The API mounts the whole directory read-only at `/run/vault-token` and rereads the token on every
   credential request. Atomic replacement of a file within that directory is visible to the running
   API. Give the API container's runtime UID read access to the file and traversal access to the
   directory. Keep the sink private to the deployment.

4. Put any TLS material in `VAULT_TLS_DIRECTORY`, mounted read-only at `/run/vault-tls`.
   With a publicly trusted Vault certificate, leave the template's `tls` block commented out.
   For a private Vault CA or mutual TLS, copy the selected template to the ignored
   `config/database-vault.local.conf`, select that copy in `VAULT_DATABASE_CONFIG`, and enable its
   `tls` block. It accepts JKS and PKCS12 stores, with passwords read from separate mounted files.
   The database uses its own TLS configuration. The PostgreSQL example uses `sslmode=verify-full`
   and a PEM CA file. MongoDB's `tls=true` uses the JVM's trusted CAs.

5. Render the service configuration, then start the API with the same environment files.

   ```bash
   docker compose --env-file .env --env-file vault.env -f docker-compose-vault.yml config --quiet
   docker compose --env-file .env --env-file vault.env -f docker-compose-vault.yml up -d
   ```

   Pass an online `LICENSE_SEED_CREDENTIAL` or configure the offline bundle through the license
   variables described in `LICENSING.md`. The API is available directly at
   `http://enterprise.localhost:7500` by default. Use `PORT=7500` for the TypeScript CLI, or the
   value selected in `ENTERPRISE_API_PORT`. The API's public URLs use that same port.

## Verify startup and rotation

Use the same Compose options for operator commands, so they receive the same database configuration,
token directory, TLS files, license settings and installation key.

```bash
docker compose --env-file .env --env-file vault.env -f docker-compose-vault.yml \
  run --rm waltid-enterprise license request <licenseId> <organizationId> \
  -o /license/installation-request.json
docker compose --env-file .env --env-file vault.env -f docker-compose-vault.yml \
  logs --tail=100 waltid-enterprise
curl --fail --noproxy '*' http://enterprise.localhost:7500/readyz
```

Use the selected `ENTERPRISE_API_PORT` in the curl URL when it differs from 7500.

Authenticate through the normal API and create/read an application record. Trigger a static-role
rotation through your Vault operator workflow, or allow a dynamic replacement to occur. Check for
`Rotated PostgreSQL credentials from Vault (STATIC)` or the matching backend/mode message, then
read the earlier record and create/read another. Verify that the API container remains running
with the same process identity. The old credential should fail a fresh direct database login after
Vault rotates or revokes it.

The provider validates each candidate before activation, preserves valid credentials during a
temporary refresh failure, and makes `/readyz` return 503 after the dynamic lease expires. The
drain deadline can end a long-running transaction or cursor. An external token revocation can also
invalidate its child leases before their recorded expiry. Health and rotation evidence should
include application reads/writes and the database's authentication outcome.

The standalone authenticated examples exercise both backends and modes, token-file replacement,
two replicas, outage recovery and early token revocation.
[Vault database credential examples](https://github.com/walt-id/waltid-enterprise-examples/tree/codex/vault-database-credentials/vault-database-credentials)

The deployment runbook documents the configuration and operational contract.
[Vault deployment runbook](https://github.com/walt-id/waltid-docs/blob/codex/vault-database-credentials/src/content/3.enterprise-stack/3.setup/2.deployment/7.vault-database-credentials.md)

For this Quickstart, the minimum runtime check is startup with the selected external backend,
`license request` key reuse with the same installation, and a successful authenticated application
write/read before and after rotation with the same API process.

## Lifecycle and troubleshooting

Run `docker compose --env-file .env --env-file vault.env -f docker-compose-vault.yml down` to stop
this API project. Its database and Vault lifecycle are managed externally.

Startup retries and validation deadlines are configured in the selected database template.
Failures use categories such as `VAULT_AUTHORIZATION`, `VAULT_REQUEST_TIMEOUT`,
`VALIDATION_FAILED` and `STARTUP_TIMEOUT`. Check namespace, token policy and file permissions for
authorization failures, and container DNS, service reachability and trust material for connection
failures. After the external issue is repaired, an already running provider recovers through its
refresh loop.

When the `prometheus` feature is enabled, the API exposes `database_vault_ready`,
`database_vault_lease_remaining_seconds`, `database_vault_resources` and refresh, rotation and
failure counters. Metric labels use backend names and fixed failure categories. Keep raw token,
database credential and license material out of logs and shared reports.
