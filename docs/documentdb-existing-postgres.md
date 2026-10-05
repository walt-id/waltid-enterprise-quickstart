# DocumentDB on an existing PostgreSQL

The Enterprise API has no native PostgreSQL driver. It speaks the MongoDB wire protocol, which
[DocumentDB](https://documentdb.io) provides on top of PostgreSQL (extensions plus a gateway). To use a
PostgreSQL server you already run, add DocumentDB to it and point the API at the gateway:

```
Enterprise API --- TLS, :10260 ---> documentdb-gateway --- local socket ---> your PostgreSQL + DocumentDB
```

In `database.conf` that is `databaseType = mongodb` with `profile = DOCUMENTDB_POSTGRES`. See
[Database configuration](https://docs.walt.id/enterprise-stack/setup/configurations/config-files/database)
for the fields and [`config/database-documentdb.conf`](../config/database-documentdb.conf) for a working
example.

## 1. Add DocumentDB to your PostgreSQL

Follow DocumentDB's
[Adopt an existing PostgreSQL instance](https://github.com/documentdb/documentdb.github.io/blob/main/PACKAGE-INSTALL.md#adopt-an-existing-postgresql-instance)
and take supported distributions and PostgreSQL versions from its
[package guide](https://github.com/documentdb/documentdb.github.io/blob/main/PACKAGE-INSTALL.md#supported-postgresql-versions).
This was verified with DocumentDB 0.117 on Ubuntu 24.04 and PostgreSQL 17. What matters for the
Enterprise stack:

- **Same host, pre-GA.** The gateway must run on the PostgreSQL host; adopting a remote PostgreSQL is
  [not supported](https://documentdb.io/docs/linux-packages/). The packages are pre-GA and have no in-place
  upgrade path yet: [pin the version](https://github.com/documentdb/documentdb.github.io/blob/main/PACKAGE-INSTALL.md#version-pinning)
  and read [Upgrading](https://github.com/documentdb/documentdb.github.io/blob/main/PACKAGE-INSTALL.md#upgrading-an-existing-install)
  before you deploy. Back up first; one PostgreSQL restart is required.
- **TLS with a matching name.** The gateway always enforces TLS. Give it a certificate whose SAN is the
  hostname the API dials, and pass it to the wizard (the first run stops and asks for a PostgreSQL
  restart; run the same command again afterwards):

  ```bash
  printf '%s' "$ADMIN_PASSWORD" | sudo documentdb-setup --target-postgres-instance <major>/<name> \
    --admin-user waltid --admin-password-stdin --yes \
    --tls-cert /etc/documentdb/tls/server.crt --tls-key /etc/documentdb/tls/server.key
  ```
- **Firewall port 10260.** The gateway listens on all interfaces; allow only the API hosts
  ([details](https://github.com/documentdb/documentdb.github.io/blob/main/PACKAGE-INSTALL.md#before-you-expose-this-to-a-network)).
- **Instance-wide settings.** The wizard can set `default_toast_compression` for every database on the
  instance; prefix both runs with `DOCUMENTDB_TOAST_COMPRESSION=default` to keep yours. Review the drop-in
  it writes before restarting PostgreSQL.

## 2. Trust store

The Java driver ignores `tlsInsecure`, so the gateway certificate must be in a JKS trust store:

```bash
mkdir -p certs
echo | openssl s_client -connect db.example.com:10260 -servername db.example.com 2>/dev/null | openssl x509 > certs/gateway.crt
keytool -importcert -noprompt -alias documentdb-gateway -file certs/gateway.crt \
  -keystore certs/documentdb-truststore.jks -storetype JKS -storepass "$TRUSTSTORE_PASSWORD"
```

## 3. Start the stack

Put the gateway settings in their own env file, not in `.env`: `.env` is also read by the bundled
DocumentDB stack, which would then connect to your real database (and a `walt.ts --recreate` against it
would wipe it).

```bash
cp documentdb-external.env.example documentdb-external.env   # gitignored
```

```bash
DOCUMENTDB_CONNECTION_STRING='mongodb://waltid:<url-encoded password>@db.example.com:10260/?directConnection=true&retryWrites=false&tls=true'
DOCUMENTDB_TRUSTSTORE_PASSWORD=<trust store password>
```

Start with both env files and the override, which switches off the bundled `documentdb` container and
mounts `certs/documentdb-truststore.jks` (Docker Compose v2.24.4 or newer):

```bash
docker compose --env-file .env --env-file documentdb-external.env \
  -f docker-compose-documentdb.yml -f docker-compose-documentdb-external.yml up
```

- `DOCUMENTDB_INVALID_HOSTNAME_ALLOWED=true` skips the hostname check if the certificate cannot match.
- Outside this quickstart, set the same values in the `mongodb` block of `database.conf`, or as JVM
  overrides ([Docker deployment](https://docs.walt.id/enterprise-stack/setup/deployment/docker-deployment)).
  Keep exactly one `ssl` block.
- The override uses its own project, network and volume names, so `down -v` cannot touch the bundled
  stack's data. Both publish the API on port 7500; to run them at the same time, set
  `ENTERPRISE_API_PORT=7600` in `documentdb-external.env` and use `PORT=7600` for the CLI.
- There is no Caddy: the API is reached on `enterprise.localhost:7500` (or your `ENTERPRISE_API_PORT`),
  which is also the port in the URLs it generates
  ([Enterprise configuration](https://docs.walt.id/enterprise-stack/setup/configurations/config-files/enterprise)).

## 4. License and first run

A new database has no license state; activate as in [Licensing](../README.md#licensing)
([License configuration](https://docs.walt.id/enterprise-stack/setup/configurations/config-files/license)).
Then run the CLI:

```bash
cd cli && PORT=7500 npx tsx walt.ts --recreate
```

The first `--recreate` on an empty database can collide with the API's startup migrations and fail with
`Migration aborted` or `Lost lock for Migration`; run it again. Some `ERROR` log lines are expected, see
[Harmless `ERROR` log lines](../README.md#harmless-error-log-lines).

## Rolling back

Use the detach steps in the same
[upstream section](https://github.com/documentdb/documentdb.github.io/blob/main/PACKAGE-INSTALL.md#adopt-an-existing-postgresql-instance)
(`documentdb-setup --restore`, then restart PostgreSQL). It leaves your data and settings as they were, but
keeps the `*.documentdb-backup.*` config copies, the gateway and admin roles, and the DocumentDB
extensions with their data; remove those deliberately. Never run `documentdb-local-reset` on an adopted
instance.
