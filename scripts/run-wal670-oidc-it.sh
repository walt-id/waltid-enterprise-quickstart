#!/usr/bin/env bash
set -euo pipefail

# WAL-670 OIDC integration test runner (semi-automated)
# - Starts stack
# - Ensures externalRoleMapping config is present
# - Switches to OIDC mode so you can mint fresh Enterprise OIDC tokens manually
# - Switches back to email mode for test bootstrap compatibility
# - Runs OidcExternalRoleMappingIntegrationTest against REMOTE_ENV=local

QS_DIR="$HOME/dev/walt-id/waltid-enterprise-quickstart"
UB_DIR="$HOME/dev/walt-id/waltid-unified-build"
AUTH_CONF="$QS_DIR/config/auth.conf"

EMAIL_BLOCK='authFlow = {
  method = "email"
  expiration = "7d"
  success = true
}
'

OIDC_BLOCK='authFlow = {
  method = "oidc"
  config = {
    openIdConfigurationUrl = "http://keycloak:8080/realms/waltid/.well-known/openid-configuration"
    clientId = "waltid_enterprise"
    clientSecret = "waltid-enterprise-dev-secret"
    callbackUri = "http://waltid.enterprise.localhost:3000/auth/account/oidc/callback"
    accountIdentifierClaim = "sub"
    pkceEnabled = true
  }
  success = true
}
'

EXT_ROLE_BLOCK='externalRoleMapping = {
  enabled = true
  strict = true
  mappings = [
    { externalRole = "tenant-admin", roleId = "integration-test.oidc-role-map.BW_ADMIN" },
    { externalRole = "wallet-operator", roleId = "integration-test.oidc-role-map.BW_OPERATOR" }
  ]
}
'

write_conf() {
  local flow="$1"
  {
    cat <<'HEAD'
# Will secure login cookies with `Secure` context, enable HTTS and HTTP->HTTPS redirect
requireHttps = false

# Key (all waltid-crypto supported) to sign login token - has to be key allowing signing (private key)
signingKey = {"type": "jwk", "jwk": {"kty": "OKP", "d": "L_2RuCSFUu818ZzM6Xml6uxesqTcxo8323-Q2S_qq4c", "use": "sig", "crv": "Ed25519", "x": "vvCN3xMAb0ZCt4sWIdtKDhkVHSERJZeBxybN-eSRkgw", "alg": "EdDSA"}}

# Key (all waltid-crypto supported) to verify incoming login tokens - public key is ok.
verificationKey = {"type": "jwk", "jwk": {"kty": "OKP", "d": "L_2RuCSFUu818ZzM6Xml6uxesqTcxo8323-Q2S_qq4c", "use": "sig", "crv": "Ed25519", "x": "vvCN3xMAb0ZCt4sWIdtKDhkVHSERJZeBxybN-eSRkgw", "alg": "EdDSA"}}

pepper = "waltid-enterprise12345678"
hashAlgorithm = ARGON2
hashMigrations = {
    MESSAGE_DIGEST: ARGON2
}
HEAD

    if [[ "$flow" == "oidc" ]]; then
      printf "%s\n" "$OIDC_BLOCK"
    else
      printf "%s\n" "$EMAIL_BLOCK"
    fi

    printf "%s\n" "$EXT_ROLE_BLOCK"
  } > "$AUTH_CONF"
}

require_token() {
  local name="$1"
  local label="$2"
  local val="${!name-}"
  if [[ -z "$val" ]]; then
    echo
    echo "Paste $label token now (must start with eyJ):"
    read -r -p "> " val
    export "$name=$val"
  else
    echo "$label token already set via environment."
  fi
  if [[ "$val" != eyJ* ]]; then
    echo "ERROR: $label token is invalid (must start with 'eyJ')"
    exit 1
  fi
}

echo "[1/7] Start stack"
cd "$QS_DIR"
docker compose up -d
docker compose -f docker-compose.keycloak.yml up -d

echo "[2/7] Switch enterprise to OIDC mode + role mappings"
write_conf oidc
docker compose restart waltid-enterprise
sleep 4

echo "[3/7] Verify OIDC endpoint"
curl -sf -o /dev/null http://enterprise.localhost:3000/auth/account/oidc/auth || {
  echo "OIDC endpoint check failed."
  exit 1
}

echo
cat <<'MSG'
[MANUAL STEP]
Open these in fresh/private browser windows and complete login:
  1) http://waltid.enterprise.localhost:3000/auth/account/oidc/auth  (login as waltid-admin)
  2) http://waltid.enterprise.localhost:3000/auth/account/oidc/auth  (login as waltid-operator)

Copy the resulting Enterprise auth tokens (JWTs starting with eyJ).
MSG

echo
read -r -p "Press ENTER once both fresh tokens are ready... " _

echo
 echo "[TOKEN INPUT] Step 1/2: admin token"
require_token OIDC_ADMIN_TOKEN "ADMIN"

echo
 echo "[TOKEN INPUT] Step 2/2: operator token"
require_token OIDC_OPERATOR_TOKEN "OPERATOR"

echo "[4/7] Switch enterprise back to email mode (test bootstrap compatibility)"
write_conf email
docker compose restart waltid-enterprise
sleep 4

echo "[5/7] Verify email endpoint"
curl -sf -o /dev/null -X POST http://enterprise.localhost:3000/auth/account/emailpass \
  -H 'content-type: application/json' \
  -d '{"username":"superadmin@walt.id","password":"super123456"}' || {
  echo "Email endpoint check failed."
  exit 1
}

echo "[6/7] Run WAL-670 integration test"
cd "$UB_DIR"
export REMOTE_ENV=local
export OIDC_ROLE_MAPPING_ENABLED=true
./gradlew :waltid-enterprise-integration-tests:test \
  --tests "id.walt.enterprise.test.integration.tests.wallet.OidcExternalRoleMappingIntegrationTest" \
  --stacktrace --no-configuration-cache

echo "[7/7] Done ✅"
echo "If test still fails, check enterprise logs for role resolution:"
echo "  docker logs --tail=200 waltid-enterprise-quickstart-waltid-enterprise-1"
