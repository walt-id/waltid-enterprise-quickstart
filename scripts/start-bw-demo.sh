#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIR_DEFAULT="/home/pp/dev/walt-id/waltid-unified-build/waltid-identity-enterprise/waltid-enterprise-bw"
UI_DIR="${UI_DIR:-$UI_DIR_DEFAULT}"
KEYCLOAK_REALM_FILE="${KEYCLOAK_REALM_FILE:-$ROOT_DIR/keycloak/import/waltid-realm-business-wallet-demo.json}"
KEYCLOAK_COMPOSE_TMP="$ROOT_DIR/docker-compose.keycloak.bw.generated.yml"
LOG_DIR="$ROOT_DIR/.logs"
UI_LOG="$LOG_DIR/waltid-enterprise-bw.log"
UI_PID_FILE="$LOG_DIR/waltid-enterprise-bw.pid"

mkdir -p "$LOG_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] docker not found"
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "[ERROR] curl not found"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm not found"
  exit 1
fi

if [[ ! -f "$KEYCLOAK_REALM_FILE" ]]; then
  echo "[ERROR] Realm file not found: $KEYCLOAK_REALM_FILE"
  exit 1
fi

if [[ ! -d "$UI_DIR" ]]; then
  echo "[ERROR] UI dir not found: $UI_DIR"
  exit 1
fi

echo "[1/6] Starting Enterprise Stack (mongo + api + caddy)..."
docker compose -f "$ROOT_DIR/docker-compose.yml" up -d

echo "[2/6] Recreating Keycloak with Business Wallet realm import..."
docker compose -f "$ROOT_DIR/docker-compose.keycloak.yml" down -v || true

cat > "$KEYCLOAK_COMPOSE_TMP" <<EOF
services:
  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    container_name: waltid-keycloak
    command: ["start-dev", "--import-realm", "--hostname=keycloak.localhost", "--hostname-strict=false"]
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: admin
    ports:
      - "8080:8080"
    volumes:
      - keycloak-data:/opt/keycloak/data
      - ${KEYCLOAK_REALM_FILE}:/opt/keycloak/data/import/waltid-realm-business-wallet-demo.json:ro
    networks:
      mongo-network:
        aliases:
          - keycloak.localhost

volumes:
  keycloak-data:
    name: waltid-keycloak-data

networks:
  mongo-network:
    external: true
    name: mongo-network
EOF

docker compose -f "$KEYCLOAK_COMPOSE_TMP" up -d

echo "[3/6] Waiting for Keycloak..."
for i in {1..60}; do
  if curl -fsS "http://localhost:8080/realms/waltid/.well-known/openid-configuration" >/dev/null; then
    echo "  Keycloak is up"
    break
  fi
  sleep 2
  if [[ "$i" == "60" ]]; then
    echo "[ERROR] Keycloak did not become ready"
    exit 1
  fi
done

echo "[4/6] Ensuring BW UI dependencies..."
cd "$UI_DIR"
npm install --silent

if [[ -f "$UI_PID_FILE" ]] && kill -0 "$(cat "$UI_PID_FILE")" 2>/dev/null; then
  echo "  UI already running (pid $(cat "$UI_PID_FILE")), restarting..."
  kill "$(cat "$UI_PID_FILE")" || true
  sleep 1
fi

# ensure port/process cleanup from old runs
if command -v fuser >/dev/null 2>&1; then
  fuser -k 3002/tcp 2>/dev/null || true
fi
pkill -f "waltid-enterprise-bw.*nuxt dev" 2>/dev/null || true

echo "[5/6] Starting BW UI on port 3002..."
KEYCLOAK_BASE_URL="${KEYCLOAK_BASE_URL:-http://localhost:8080}" \
KEYCLOAK_REALM="${KEYCLOAK_REALM:-waltid}" \
KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:-waltid_enterprise}" \
KEYCLOAK_CLIENT_SECRET="${KEYCLOAK_CLIENT_SECRET:-waltid-enterprise-dev-secret}" \
WALLET_API_BASE_URL="${WALLET_API_BASE_URL:-http://waltid.enterprise.localhost}" \
nohup npm run dev -- --port 3002 > "$UI_LOG" 2>&1 &
echo $! > "$UI_PID_FILE"

echo "[6/6] Waiting for UI and validating login..."
for i in {1..60}; do
  if curl -fsS "http://localhost:3002" >/dev/null; then
    echo "  UI is up"
    break
  fi
  sleep 2
  if [[ "$i" == "60" ]]; then
    echo "[ERROR] UI did not become ready"
    exit 1
  fi
done

LOGIN_STATUS=$(curl -s -o /tmp/bw-login-check.json -w "%{http_code}" -X POST "http://localhost:3002/api/demo/login" \
  -H "Content-Type: application/json" \
  -d '{"tenantName":"acme","email":"alice.admin@acme.demo","password":"Demo123!"}')

if [[ "$LOGIN_STATUS" == "200" ]]; then
  echo "✅ Everything is running. Login validation succeeded (alice.admin@acme.demo)."
else
  echo "⚠️ Stack is up, but login validation failed (HTTP $LOGIN_STATUS)."
  echo "   Check: /tmp/bw-login-check.json and UI log: $UI_LOG"
fi

echo "\nServices:"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'waltid-keycloak|waltid-enterprise|mongo|caddy' || true

echo "\nURLs:"
echo "- Enterprise API: http://enterprise.localhost:3000/swagger"
echo "- Keycloak:       http://localhost:8080"
echo "- BW Demo UI:     http://localhost:3002"
echo "\nUI log: $UI_LOG"
