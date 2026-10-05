# Docker compose variants with the CLI

Run everything from the repository root. Validated in this order, all four variants passed, each on the
first CLI attempt. Internal notes, not customer documentation.

Prerequisites: `.env` exists, `cli/` has its dependencies (`cd cli && npm install`), and
`config/dev-mode-access.conf` has a non-placeholder `accessToken` (the API refuses the shipped one).
If the first CLI run on an empty database fails with `Migration aborted` or `Lost lock for Migration`,
run it again.

`up -d` returns before the API has finished starting (a few seconds more for the JVM), so each test command
first polls `/livez` until it answers; without that you can see `502` from Caddy right after start.

The `down` commands keep the volumes (`mongo-data`, `documentdb-data`); do not add `-v` unless you want
to wipe the data and license state.

## 1. MongoDB (Caddy on :80, API on :7500)

```bash
docker compose up -d --wait
curl -s -o /dev/null -w 'livez: %{http_code}\n' -f --retry 60 --retry-delay 2 --retry-connrefused --retry-all-errors http://enterprise.localhost/livez && (cd cli && npx tsx walt.ts --recreate)
docker compose down
```

## 2. DocumentDB (bundled, API on :7500)

```bash
docker compose -f docker-compose-documentdb.yml up -d
curl -s -o /dev/null -w 'livez: %{http_code}\n' -f --retry 60 --retry-delay 2 --retry-connrefused --retry-all-errors http://localhost:7500/livez && (cd cli && PORT=7500 npx tsx walt.ts --recreate)
docker compose -f docker-compose-documentdb.yml down
```

## 4. External PostgreSQL with TLS

Uses the adopted test host container `documentdb-existing-pg` and two gitignored files in the repo
root: `certs/documentdb-truststore.jks` and `documentdb-external.env` (connection string and trust store
password, see `documentdb-external.env.example` and docs/documentdb-existing-postgres.md for how to create
them for a host).

Start the host:

```bash
docker start documentdb-existing-pg
```

The host is a container here, so the API also joins its network through a test-only override file. For a
real PostgreSQL host point the connection string at its hostname and leave this file out (and the third
`-f` below).

```bash
printf 'services:\n  waltid-enterprise:\n    networks:\n      existing_pg_net: {}\nnetworks:\n  existing_pg_net:\n    external: true\n    name: documentdb-existing-test\n' > /tmp/qs-test-net.yml
```

Start, test:

```bash
docker compose --env-file .env --env-file documentdb-external.env -f docker-compose-documentdb.yml -f docker-compose-documentdb-external.yml -f /tmp/qs-test-net.yml up -d
```

```bash
curl -s -o /dev/null -w 'livez: %{http_code}\n' -f --retry 60 --retry-delay 2 --retry-connrefused --retry-all-errors http://localhost:7500/livez && (cd cli && PORT=7500 npx tsx walt.ts --recreate)
```

Stop and clean up:

```bash
docker compose --env-file .env --env-file documentdb-external.env -f docker-compose-documentdb.yml -f docker-compose-documentdb-external.yml -f /tmp/qs-test-net.yml down && rm -f /tmp/qs-test-net.yml && docker stop documentdb-existing-pg
```
