<div align="center">
<h1>walt.id Enterprise Stack Quickstart</h1>
 <span>by </span><a href="https://walt.id">walt.id</a>
 <p>Quickstart to get you up and running with the walt.id Enterprise Stack</p>

  <a href="https://walt.id/community">
  <img src="https://img.shields.io/badge/Join-The Community-blue.svg?style=flat" alt="Join community!" />
  </a>
  <a href="https://www.linkedin.com/company/walt-id/">
  <img src="https://img.shields.io/badge/-LinkedIn-0072b1?style=flat&logo=linkedin" alt="Follow walt_id" />
  </a>
</div>

This repository contains the quickstart CLI and docker-compose files to get you up and running with
the walt.id Enterprise Stack for local development. It also contains useful resources to help you
with the Enterprise Stack such as configuration files, migration scripts, deployment files and more.

# Get Started

Bring up the whole stack using docker-compose and explore the enterprise features via our CLI tool.

⚠️ Please note: You need to be an Enterprise Stack customer, have access to the private enterprise
stack images & a valid license to use this quickstart.

## Licensing

The Enterprise API refuses to start without a valid license. `config/_features.conf` enables
`dev-mode`, so the quickstart needs a **DEV** license. With an online license from walt.id, start
the stack like this:

```bash
LICENSE_SEED_CREDENTIAL="openid-credential-offer://..." docker compose up
```

Offline and air-gapped activation, credential lifetime and renewal, disaster recovery, resetting
license state, Kubernetes, monitoring and license troubleshooting are in
[LICENSING.md](LICENSING.md).

## 1. Docker-Compose: Run The Enterprise Stack

Use docker-compose to bring up the Enterprise Stack API and a MongoDB database (storage of the
Enterprise Stack).

You can update the version of the enterprise stack via the `.env` file.

### Use docker-compose

**Clone the repo**

```bash
git clone https://github.com/walt-id/waltid-enterprise-quickstart.git
```

**Change Working Directory**

```bash
cd waltid-enterprise-quickstart
```

**Set a dev-mode access token**

`config/_features.conf` enables `dev-mode`, which requires `config/dev-mode-access.conf` to hold a real,
secret `accessToken` before the Enterprise API will start at all. Since this repo is public, no value
committed here could ever be a real secret - `config/dev-mode-access.conf` ships with the same literal
placeholder walt.id's own documentation uses as an example, `"replace-with-a-per-deployment-secret"`,
which the server explicitly refuses to boot with. Edit that file and set your own value before continuing:

```hocon[config/dev-mode-access.conf]
accessToken = "<a value only you know>"
```

If you skip this, `docker compose up` will bring up every other container, but the Enterprise API
container will exit with an error - check `docker compose ps -a` and `docker compose logs waltid-enterprise`
if that happens. Caddy still answers on port 80 in that state, so requests fail with `502 Bad Gateway`.
After fixing the file, `docker compose up -d` restarts the exited container.

The `/v1/dev/*` endpoints that `dev-mode` adds (used by the CLI's `--recreate`/`--init-system`)
require a matching `X-Dev-Mode-Token` header. The CLI reads `accessToken` from the same file; override
it with the `DEV_MODE_TOKEN` environment variable if you point the CLI at a different server.

**Run The Stack**

```bash
docker compose pull
docker compose up
```

Once the docker-compose is running, you can
visit [enterprise.localhost/swagger](http://enterprise.localhost/swagger) to access the Enterprise
Stack APIs.

### Using custom organisation names

Every organisation gets its own hostname, `{organizationId}.enterprise.localhost`. The API uses the
hostname of a request to decide which organisation it belongs to, and it also calls its own public
URLs (for example to fetch a credential offer).

On your machine, `*.localhost` resolves to loopback and the Caddyfile already proxies
`*.enterprise.localhost` to the API. Inside the Docker network there is no wildcard DNS, so each
organisation hostname needs a network alias on the `caddy` service. The stack ships with one for
`waltid`. Add one for every other organisation, e.g. `your-org`, and recreate the container with
`docker compose up -d`:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
    networks:
      mongodb_network:
        aliases:
          - enterprise.localhost
          - waltid.enterprise.localhost
          - your-org.enterprise.localhost
          # add your own organisation domains here
    depends_on:
      - waltid-enterprise
```

Then run the CLI for that organisation:

```bash
cd cli && ORGANIZATION=your-org npx tsx walt.ts --recreate
```

Without the alias, creating the organisation and logging in still work, but issuing a credential
fails with `HTTP 500 ... Failed to fetch credential offer from URI`, and the API log shows
`Network error while fetching credential offer ... java.net.ConnectException: Connection refused`.
The hostname then resolves to the container's own loopback, where nothing listens on port 80.

### DocumentDB instead of MongoDB

`docker-compose-documentdb.yml` runs the same stack against [DocumentDB](https://documentdb.io), the
open-source PostgreSQL engine - not AWS's proprietary service of the same name. It speaks the MongoDB
wire protocol, so the only difference is `config/database-documentdb.conf` (the `DOCUMENTDB_POSTGRES`
profile and what this engine needs), which the compose file mounts over `config/database.conf`:

```bash
docker compose -f docker-compose-documentdb.yml up
```

There is no Caddy: the API is reached directly on `enterprise.localhost:7500`. It calls its own public
URLs (for example to fetch a credential offer), so the compose file sets the port the API listens on,
the port in its public URLs and the host port all from `ENTERPRISE_API_PORT` (default 7500). Run the
CLI against it with the same `PORT`:

```bash
cd cli && PORT=7500 npx tsx walt.ts --recreate
```

On a fresh database the first run can fail with `Migration aborted` or `Lost lock for Migration` while
the API finishes its startup migrations; run it again.

The stack has its own docker project, network and volume (`waltid-enterprise-documentdb`,
`documentdb-network`, `documentdb-data`), so a MongoDB stack on the same host is left alone. Both
publish the API on 7500 by default (the MongoDB stack's port is fixed), so to run both at once start
this one with another port, e.g. `ENTERPRISE_API_PORT=7600`, and use `PORT=7600` for the CLI.
DocumentDB itself listens on 10260, published on loopback only; its login is `DOCUMENTDB_USERNAME` /
`DOCUMENTDB_PASSWORD` (see `.env.example`).

#### On your own PostgreSQL

To use a PostgreSQL server you already run instead of the bundled `documentdb` container, add
DocumentDB to it and start this stack with `docker-compose-documentdb-external.yml` on top; see
[PostgreSQL deployment](https://docs.walt.id/enterprise-stack/setup/deployment/postgresql-deployment).

#### Licensing a DocumentDB stack

A fresh DocumentDB has no license state, and the API refuses to start without it - exactly as on a
fresh MongoDB. Activate with an online offer as usual:

```bash
LICENSE_SEED_CREDENTIAL="openid-credential-offer://..." docker compose -f docker-compose-documentdb.yml up
```

To move an existing installation from MongoDB to DocumentDB, see
[Moving to another database](LICENSING.md#moving-to-another-database).

### PostgreSQL instead of MongoDB

`docker-compose-postgresql.yml` runs the same stack against a plain PostgreSQL 18 container. This is
the vanilla PostgreSQL backend (`databaseType = postgresql`), not DocumentDB: the API connects over
JDBC and stores documents as JSONB. `config/database-postgresql.conf` is mounted over
`config/database.conf`; its settings are described in
[Database configuration](https://docs.walt.id/enterprise-stack/setup/configurations/config-files/database).
It needs an Enterprise API image with PostgreSQL support:

```bash
ENTERPRISE_API_DOCKER_IMAGE_TAG=<tag> docker compose -f docker-compose-postgresql.yml up
```

As with DocumentDB there is no Caddy: the API is on `enterprise.localhost:7500`, so run the CLI with
`PORT=7500`, and use `ENTERPRISE_API_PORT=7600` (and `PORT=7600`) to run it next to the MongoDB stack.
The stack has its own docker project, network and volume (`waltid-enterprise-postgresql`,
`postgresql-network`, `postgresql18-data`). PostgreSQL listens on 5432, published on loopback only; the
login is `POSTGRES_USERNAME` / `POSTGRES_PASSWORD` (see `.env.example`). The earlier PostgreSQL 16
version of this stack used the volume `postgresql-data`, which PostgreSQL 18 cannot start on; it is
left alone, and `docker volume rm postgresql-data` removes it once you no longer need it.

A fresh database has no license state, so activate it as described for DocumentDB above. There is no
migration from an existing MongoDB database.

## 2. Enterprise CLI

A TypeScript CLI tool for setting up and testing the walt.id Enterprise Stack.

```bash
# Clone the repo
git clone https://github.com/walt-id/waltid-enterprise-quickstart.git
cd waltid-enterprise-quickstart

# Install dependencies
cd cli
npm install

# Run full setup + primary use case (PID issuance & verification, by default)
npx tsx walt.ts --recreate

# Subsequence calls don't need to recreate the DB:
npx tsx walt.ts
```

The primary use case issues and verifies a **PID** (mdoc, `eu.europa.ec.eudi.pid.1`) credential by
default. Set `CREDENTIAL_TYPE=mdl` to run the **mDL** (`org.iso.18013.5.1.mDL`) flow instead:

```bash
CREDENTIAL_TYPE=mdl npx tsx walt.ts --recreate
```

The issuer is only configured for one credential type at a time, so pair `CREDENTIAL_TYPE` with
`--recreate` when switching — see [cli/README.md](cli/README.md) for details.

### Common Commands

| Command                                   | Description                                      |
|--------------------------------------------|--------------------------------------------------|
| `npx tsx walt.ts`                         | Full setup + primary use case (default)          |
| `npx tsx walt.ts --recreate`              | Recreate database and run full setup             |
| `npx tsx walt.ts --setup-all`             | Run all setup commands                           |
| `npx tsx walt.ts --run-all`               | Run primary use case only                        |
| `npx tsx walt.ts --help`                  | Show all available commands                      |
| `CREDENTIAL_TYPE=mdl npx tsx walt.ts ...` | Run the mDL flow instead of the default PID flow |

### Configuration

Superadmin credentials are read from `config/superadmin-registration.conf`.

For detailed documentation, see **[cli/README.md](cli/README.md)**.


### Troubleshooting

- License problems (container exits during startup, every endpoint returns `503 ... the license is
  not active`, heartbeat `403 ... has no installation binding`): see
  [LICENSING.md#troubleshooting](LICENSING.md#troubleshooting).
- Enterprise API container exits at startup (all requests fail with `502 Bad Gateway` from Caddy), or `/v1/dev/*`
  returns `503` / `401` - `config/dev-mode-access.conf`
  still has the shipped placeholder `accessToken`, is unset, or doesn't match what the CLI sends. See
  [Set a dev-mode access token](#use-docker-compose) above.

#### Harmless `ERROR` log lines

- `documentdb`: `Command 'atlasVersion' not found`, once per start (the health check's `mongosh` probes
  for MongoDB Atlas), and `IndexNotFound` / `NamespaceNotFound` on the first start (migrations probing
  for indexes that do not exist yet).
- `waltid-enterprise`: `Migration version 13 ... failed with error: 'Check failed.'` after restarting
  an interrupted start. Migration 13 is manual-only; the others complete and no data changes.

## Next Steps

Visit [our docs](https://docs.walt.id/enterprise-stack/home) to learn more about features and
configurations of the enterprise stack.

Interested to see what releases are available? Checkout
our [changelogs](https://docs.walt.id/enterprise-stack/release-notes/overview) to see the latest
releases and pre-releases of the Enterprise Stack.

Need Support? As an Enterprise customer you should also have a support contract with us. Please
raise any issues via the [Support Portal](https://support.walt.id), or reach out to the team over
email if you need to be given access.

## Join the community

* Connect and get the latest
  updates: [Discord](https://discord.gg/AW8AgqJthZ) | [Newsletter](https://walt.id/newsletter) | [YouTube](https://www.youtube.com/channel/UCXfOzrv3PIvmur_CmwwmdLA) | [LinkedIn](https://www.linkedin.com/company/walt-id/)
* Get help, request features and report bugs: [Support Portal](https://support.walt.id)
* Find more indepth documentation on our [docs site](https://docs.walt.id/enterprise-stack/home)

## License

Licensed under our Enterprise License.

<div align="center">
<img src="./assets/walt-banner.png" alt="walt.id banner" />
</div>
