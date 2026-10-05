#!/usr/bin/env bash
#
# Copy the persisted license state from the MongoDB quickstart to the DocumentDB quickstart.
#
# The Enterprise API stores the bound license credential and the installation private key in the
# database and refuses to start without them. Switching databases therefore means moving
# `license_state` and `license_state_key` across. It has to be done with a BSON-preserving tool:
# the state carries a MAC over its numeric fields, and a JSON round trip (for example mongosh
# handing back objects) turns int64s into doubles and fails the integrity check. mongodump and
# mongorestore preserve the types, and DocumentDB accepts both.
#
# Run this while the MongoDB stack is up (it is the source) and the DocumentDB service is up (the
# target). The API does not need to be running for either.
#
#   docker compose up -d mongodb
#   docker compose -f docker-compose-documentdb.yml up -d documentdb
#   ./migrate-license-state-to-documentdb.sh
#   docker compose -f docker-compose-documentdb.yml up -d
#
# Everything below can be overridden with an environment variable, e.g.:
#   SOURCE_DB=waltid-local-dev TARGET_DB=waltid-local-dev ./migrate-license-state-to-documentdb.sh

set -euo pipefail

cd "$(dirname "$0")"

# Load the MongoDB credentials and network name from the quickstart .env when present.
if [[ -f .env ]]; then
    # shellcheck disable=SC1091
    set -a && source .env && set +a
fi

MONGO_NETWORK="${MONGO_NETWORK:-mongo-network}"
MONGO_HOST="${MONGO_HOST:-mongodb}"
MONGO_PORT="${MONGO_PORT:-27017}"
MONGO_USERNAME="${MONGO_USERNAME:-${MONGO_INITDB_ROOT_USERNAME:-root}}"
MONGO_PASSWORD="${MONGO_PASSWORD:-${MONGO_INITDB_ROOT_PASSWORD:-password}}"
SOURCE_DB="${SOURCE_DB:-waltid-enterprise}"

DOCUMENTDB_NETWORK="${DOCUMENTDB_NETWORK:-documentdb-network}"
DOCUMENTDB_HOST="${DOCUMENTDB_HOST:-documentdb}"
DOCUMENTDB_PORT="${DOCUMENTDB_PORT:-10260}"
DOCUMENTDB_USERNAME="${DOCUMENTDB_USERNAME:-docdbuser}"
DOCUMENTDB_PASSWORD="${DOCUMENTDB_PASSWORD:-docdbpass123}"
TARGET_DB="${TARGET_DB:-waltid-enterprise}"

MONGO_URI="mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@${MONGO_HOST}:${MONGO_PORT}/${SOURCE_DB}?authSource=admin&directConnection=true"
DOCUMENTDB_URI="mongodb://${DOCUMENTDB_USERNAME}:${DOCUMENTDB_PASSWORD}@${DOCUMENTDB_HOST}:${DOCUMENTDB_PORT}/?directConnection=true&retryWrites=false"

COLLECTIONS=(license_state license_state_key)

for net in "$MONGO_NETWORK" "$DOCUMENTDB_NETWORK"; do
    if ! docker network inspect "$net" >/dev/null 2>&1; then
        echo "error: docker network '$net' not found. Start the MongoDB stack and the 'documentdb' service first." >&2
        exit 1
    fi
done

# A named volume rather than a host directory: mongodump runs as uid 999 in the mongo image, and a
# bind mount would leave root-owned files behind that this script (running as the invoking user)
# cannot clean up. A volume is removed wholesale regardless of the files inside it.
dump_volume="waltid-license-migration-$$"
docker volume create "$dump_volume" >/dev/null
trap 'docker volume rm -f "$dump_volume" >/dev/null 2>&1 || true' EXIT
# mongodump runs as uid 999 in the mongo image while a fresh named volume is root-owned, so open
# the volume before dumping into it.
docker run --rm --user root --entrypoint chmod -v "$dump_volume:/dump" mongo:latest 777 /dump

echo "Dumping ${SOURCE_DB}.{${COLLECTIONS[*]// /,}} from ${MONGO_HOST} ..."
for collection in "${COLLECTIONS[@]}"; do
    docker run --rm \
        --network "$MONGO_NETWORK" \
        -v "$dump_volume:/dump" \
        mongo:latest \
        mongodump --uri="$MONGO_URI" --collection="$collection" --out=/dump >/dev/null
done

echo "Restoring into ${TARGET_DB} on ${DOCUMENTDB_HOST} ..."
docker run --rm \
    --network "$DOCUMENTDB_NETWORK" \
    -v "$dump_volume:/dump" \
    mongo:latest \
    mongorestore --uri="$DOCUMENTDB_URI" --drop \
        --nsFrom="${SOURCE_DB}.*" --nsTo="${TARGET_DB}.*" \
        /dump

echo
echo "License state migrated. Start the DocumentDB stack with:"
echo "  docker compose -f docker-compose-documentdb.yml up -d"
