# Guide: Configure Keycloak + Enterprise for external role mapping

This guide sets up:
- Keycloak (realm, client, roles, users)
- Enterprise external role mapping (`auth.conf`)
- OIDC login linkage to Enterprise accounts
- Running OIDC allow/deny integration scenarios

---

## 0) Preconditions

- Enterprise stack is running (e.g. `http://enterprise.localhost:3000/swagger/index.html`)
- Keycloak container is running on `http://localhost:8080`
- You can log in as Enterprise superadmin

---

## 1) Start Keycloak (if not already running)

```bash
docker run --name waltid-keycloak \
  -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:26.0 \
  start-dev
```

Keycloak admin UI: `http://localhost:8080` (`admin` / `admin`)

---

## 2) Keycloak configuration

### 2.1 Create realm
- Realm name: `waltid`

### 2.2 Create roles
Create **realm roles**:
- `tenant-admin`
- `wallet-operator`

### 2.3 Create OIDC client (exact fields)

Use **Clients → Create client** and fill it exactly like this.

#### Step 1: General settings
- **Client type**: `OpenID Connect`
- **Client ID**: `waltid_enterprise`
- **Name**: `waltid_enterprise` (or leave empty)
- **Description**: leave empty
- Click **Next**

#### Step 2: Capability config
- **Client authentication**: `ON`  ✅ (required, gives client secret)
- **Authorization**: `OFF`
- **Authentication flow**
  - **Standard flow**: `ON` ✅
  - **Direct access grants**: `OFF` (can be ON, but not required for this guide)
  - **Implicit flow**: `OFF`
  - **Service accounts roles**: `OFF`
  - **OAuth 2.0 Device Authorization Grant**: `OFF`
  - **OIDC CIBA Grant**: `OFF`
- Click **Next**

#### Step 3: Login settings
- **Root URL**: leave empty
- **Home URL**: leave empty
- **Valid redirect URIs** (add both):
  - `http://enterprise.localhost:3000/auth/account/oidc/callback`
  - `http://enterprise.localhost:3000/*`
- **Valid post logout redirect URIs**:
  - `http://enterprise.localhost:3000/*`
- **Web origins**:
  - `http://enterprise.localhost:3000`
- **Capability config**
  - Turn Client authentication ON (otherwise the Credential tab is not shown)
- Click **Save**

#### After save
- Open client tab **Credentials**
- Copy **Client secret** (needed later in Enterprise OIDC config)

### 2.4 Ensure roles are present in ID token (click-by-click)

This is required because Enterprise reads external roles from ID token claims.

#### 2.4.1 Check client scopes on your client
- Go to **Clients** → `waltid_enterprise` → **Client scopes**
- You should see built-in scopes (e.g. `profile`, `email`, ...)
- Look for `roles`

If `roles` is present:
- set **Assigned type** to `Default`
- continue with **2.4.3 Validate**

If `roles` is NOT present (your current situation):
- continue with **2.4.2 Add role mappers manually**

#### 2.4.2 Add role mappers manually on the client
Go to **Clients** → `waltid_enterprise` → **Client scopes** and click
`waltid_enterprise-dedicated` (the dedicated scope for this client), then open **Mappers**.

Create mapper A (realm roles):
- **Add mapper** → **By configuration** → choose mapper type for realm roles
  (usually named `User Realm Role` or similar)
- **Name**: `realm-roles`
- **Token claim name**: `realm_access.roles`
- **Multivalued**: `ON`
- **Add to ID token**: `ON`
- **Add to access token**: `ON`
- Save

Create mapper B (client roles):
- **Add mapper** → **By configuration** → choose mapper type for client roles
  (usually named `User Client Role` or similar)
- **Name**: `client-roles-waltid-enterprise`
- **Client ID**: `waltid_enterprise`
- **Token claim name**: `resource_access.waltid_enterprise.roles`
- **Multivalued**: `ON`
- **Add to ID token**: `ON`
- **Add to access token**: `ON`
- Save

#### 2.4.3 Validate claims are present
After a login, decode the ID token and verify payload contains:

```json
{
  "realm_access": { "roles": ["tenant-admin"] },
  "resource_access": {
    "waltid_enterprise": { "roles": ["wallet-operator"] }
  }
}
```

If either block is missing, mapping in Enterprise will not grant permissions.

### 2.5 Create users
Create two users:
- `waltid-admin / waltid-admin@waltid.local`
- `waltid-operator / waltid-operator@waltid.local`

Set passwords and disable temporary-password flag.

Assign roles:
- `waltid-admin@waltid.local` -> realm role `tenant-admin`
- `waltid-operator@waltid.local` -> realm role `wallet-operator`

---

## 3) Enterprise auth flow + external role mapping config

Edit:
- `~/dev/walt-id/waltid-enterprise-quickstart/config/auth.conf`

### 3.1 Enable OIDC login flow (this creates OIDC login endpoint)

Your current stack exposes `/auth/account/emailpass` because auth flow method is `email`.
To switch login to OIDC, set authFlow method to `oidc`:

```hocon
authFlow = {
  method = "oidc"
  config = {
    type = "oidc-config"
    openIdConfigurationUrl = "http://localhost:8080/realms/waltid/.well-known/openid-configuration"
    clientId = "waltid_enterprise"
    clientSecret = "<KEYCLOAK_CLIENT_SECRET>"
    callbackUri = "http://waltid.enterprise.localhost:3000/auth/account/oidc/callback"
    accountIdentifierClaim = "sub"
    externalRoleExtraction = {
      enabled = true
      clientId = "waltid_enterprise"
    }
  }
  success = true
}
```

After restart, login endpoint should be:
- `GET /auth/account/oidc/auth`

### 3.2 Enable external role mapping in enterprise

Add/update:

```hocon
externalRoleMapping = {
  enabled = true
  strict = true
  expectedIssuer = "http://localhost:8080/realms/waltid"
  expectedClientId = "waltid_enterprise"
  mappings = [
    # IMPORTANT: Use role IDs that exist in your enterprise organization tree.
    { externalRole = "tenant-admin", roleId = "integration-test.bw-phase1.BW_ADMIN" },
    { externalRole = "wallet-operator", roleId = "integration-test.bw-phase1.BW_OPERATOR" }
  ]
}
```

> Replace role IDs above with your real role IDs if different.

Restart stack:

```bash
cd ~/dev/walt-id/waltid-enterprise-quickstart
docker compose down && docker compose up -d
```

---

## 4) Link OIDC identities to Enterprise accounts

Enterprise needs account linkage by `(issuer, subject)`.

### 4.1 Get Keycloak user subject IDs
In Keycloak users, copy each user UUID (this is `sub` claim):
- admin user subject UUID
- operator user subject UUID

### 4.2 Create/find Enterprise accounts for those users
Use your existing admin workflow to create 2 Enterprise accounts (or reuse existing).
Capture account IDs:
- `<ENTERPRISE_ADMIN_ACCOUNT_ID>`
- `<ENTERPRISE_OPERATOR_ACCOUNT_ID>`

### 4.3 Add OIDC initial auth mapping (superadmin)
Use endpoint:
- `POST /v1/admin/account/auth/{id}/add-initial`

Body for admin account:

```json
{
  "type": "oidc",
  "identifier": {
    "type": "oidc",
    "issuer": "http://localhost:8080/realms/waltid",
    "subject": "<KEYCLOAK_ADMIN_SUBJECT_UUID>"
  },
  "config": {
    "type": "oidc-config",
    "openIdConfigurationUrl": "http://localhost:8080/realms/waltid/.well-known/openid-configuration",
    "clientId": "waltid_enterprise",
    "clientSecret": "<KEYCLOAK_CLIENT_SECRET>",
    "callbackUri": "http://enterprise.localhost:3000/auth/account/oidc/callback"
  }
}
```

Repeat for operator account with operator subject UUID.

---

## 5) Obtain Enterprise auth tokens via OIDC login

You need **Enterprise** bearer tokens (not raw Keycloak access tokens).

Recommended approach:
1. Start OIDC login at Enterprise endpoint: `GET /auth/account/oidc/auth`
2. Complete Keycloak login in browser.
3. Capture resulting Enterprise token from login response / authenticated session flow.

Do this once for admin user and once for operator user.

---

## 6) Run OIDC integration scenarios

```bash
export OIDC_ROLE_MAPPING_ENABLED=true
export OIDC_ADMIN_TOKEN="<enterprise token of oidc-admin user>"
export OIDC_OPERATOR_TOKEN="<enterprise token of oidc-operator user>"

cd ~/dev/walt-id/waltid-unified-build
./gradlew :waltid-enterprise-integration-tests:test \
  --tests "id.walt.enterprise.test.integration.tests.wallet.OidcExternalRoleMappingIntegrationTest" \
  --stacktrace --no-configuration-cache
```

Expected:
- admin token => wallet creation allowed
- operator token => wallet creation forbidden

---

## 7) Troubleshooting

- **Issuer mismatch**: ensure `expectedIssuer` exactly matches Keycloak token `iss`.
- **No mapped permissions**: verify `roleId` exists and starts with correct organization prefix.
- **OIDC login works but no permissions**: verify Keycloak roles are in ID token claims.
- **Tests skipped/no-op**: ensure `OIDC_ROLE_MAPPING_ENABLED=true` and both tokens are set.

---

## 8) Cleanup

```bash
docker rm -f waltid-keycloak
```
