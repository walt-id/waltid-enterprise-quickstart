# walt.ts - Enterprise Stack CLI Tool

A comprehensive CLI for setting up and running use cases against the walt.id Enterprise stack. The primary use case is issuing and verifying an mDL (mobile Driver's License) credential.

## Project Structure

```
cli/
├── walt.ts                 # Entry point (thin wrapper)
├── AGENTS.md              # Guide for AI agents extending the CLI
├── src/
│   ├── index.ts           # CLI argument parsing and dispatch
│   ├── config.ts          # Configuration, constants, types
│   ├── context.ts         # CommandContext - shared state and utilities
│   ├── http/              # HTTP client with auth and logging
│   ├── commands/          # Individual commands
│   │   ├── system.ts      # System init (recreate DB, create org)
│   │   ├── run.ts         # Run commands (issue, verify, revoke)
│   │   └── setup/         # Setup commands by category
│   └── flows/             # Multi-step flows (ETSI, revocation)
├── keys/                   # Cryptographic key files
└── logs/                   # Runtime logs (gitignored)
```

## Quick Start

```bash
npm install

# First time: recreate DB, create superadmin/org/admin, run full setup + primary use case
npx tsx walt.ts --recreate

# Subsequent runs: re-run setup + primary use case without recreating the DB
npx tsx walt.ts
```

## Commands Reference

### System Commands

| Command | Description |
|---------|-------------|
| `--recreate` | Recreate DB, create superadmin/org/admin, run full setup + primary use case |
| `--setup-recreate` | Run system initialization only (recreate DB, create superadmin/org/admin) |
| `--setup-create-superadmin` | Create superadmin account |
| `--setup-create-organization` | Create organization |
| `--setup-create-admin-role` | Check/report admin role (auto-created with org) |
| `--setup-create-admin-account` | Create admin user account and assign role |

### Setup Commands

These commands create resources in the enterprise stack. Run them in order, or use `--setup-all`.

| Command | Description |
|---------|-------------|
| `--setup-all` | Run all setup commands in sequence |
| `--setup-login` | Login to the enterprise stack (uses admin credentials by default) |
| `--setup-login-superadmin` | Login as superadmin |
| `--setup-create-tenant` | Create tenant |
| `--setup-create-wallet` | Create/initialize wallet service |
| `--setup-create-verifier2` | Create verifier2 service |
| `--setup-create-services` | Create KMS, X509 Service, X509 Store |
| `--setup-link-x509-dependencies` | Link X509 service dependencies |
| `--setup-import-keys` | Import cryptographic keys (IACA, issuer, attester, VICAL) |
| `--setup-create-iaca-certificate` | Create IACA root certificate |
| `--setup-create-document-signer-certificate` | Create document signer certificate |
| `--setup-store-vical-signer-certificate` | Store VICAL signer certificate |
| `--setup-create-vical-service` | Create VICAL service |
| `--setup-publish-vical` | Publish VICAL with IACA certificate |
| `--setup-create-client-attester` | Create client attester service |
| `--setup-create-credential-status-service` | Create credential status service |
| `--setup-create-status-configuration` | Create TokenStatusList CWT configuration |
| `--setup-create-issuer2` | Create issuer2 with client attestation |
| `--setup-link-issuer-to-credential-status` | Link credential status service to issuer |
| `--setup-create-issuer-profile` | Create issuer credential profile (mDL) |
| `--setup-link-wallet-to-attester` | Link wallet to client attester |
| `--setup-obtain-wallet-attestation` | Obtain wallet client attestation |

### Additional Setup Commands

| Command | Description |
|---------|-------------|
| `--setup-create-trust-registry` | Create trust registry service |
| `--setup-etsi-trust-registry` | Complete ETSI trust registry setup (create, link, import lists) |
| `--setup-import-trust-list <file>` | Import trust list from file (TSL XML, LoTE JSON) |
| `--clear-wallet-credentials` | Clear all credentials from wallet (useful between flows) |

### Run Commands

These commands execute use cases (issue/verify credentials). Assumes setup is complete.

| Command | Description |
|---------|-------------|
| `--run-all` | Run primary use case |
| `--run-create-credential-offer` | Create credential offer (without status tracking) |
| `--run-create-credential-offer-with-status` | Create credential offer with status tracking enabled |
| `--run-wallet-receive-credential` | Wallet receives credential via pre-authorized flow |
| `--run-create-verification-session` | Create verifier2 verification session (signature + vical policies) |
| `--run-create-verification-session-with-status` | Create verifier2 verification session (signature + vical + status policies) |
| `--run-create-verification-session-status-only` | Create verifier2 verification session (signature + status only, no vical) |
| `--run-wallet-present` | Wallet presents credential |
| `--run-assert-final-status` | Assert final verification status is SUCCESSFUL |
| `--run-assert-final-status-failed` | Assert final verification status is FAILED |

### Credential Revocation Commands

These commands manage credential status and revocation.

| Command | Description |
|---------|-------------|
| `--run-revoke-credential` | Revoke credential (set status to INVALID/0x1) |
| `--run-unrevoke-credential` | Unrevoke credential (reset status to VALID/0x0) |
| `--run-update-credential-status <status>` | Update credential status to specified value (e.g., 0x0, 0x1) |

### Flow Commands

| Command | Description |
|---------|-------------|
| `--flow-etsi-trust-lists` | Run ETSI trust lists verification flow (see below) |
| `--flow-credential-revocation` | Run credential revocation flow (see below) |
| `--flow-iam-bridge` | Run IAM Bridge OIDC flow with Keycloak (see below) |

#### ETSI Trust Lists Flow (`--flow-etsi-trust-lists`)

Demonstrates trust list verification using the Enterprise Trust Registry Service. **This flow is self-contained** - it clears existing credentials and issues its own credential.

**Prerequisites:**
Run `--setup-etsi-trust-registry` once to set up the trust registry, import trust lists, and configure the verifier.

**Flow Steps:**
1. Clear existing credentials from wallet
2. **Issue a fresh credential** for this flow
3. Create verification session with policies: `signature`, `vical`, `etsi-trust-list`
4. Present credential
5. Verify result

**Trust Registry Setup (one-time):**
The `--setup-etsi-trust-registry` command performs:
- Create trust registry service
- Link Verifier2 to Trust Registry
- Import public trust lists (EWC Pilot, Austrian TSL)
- Load local IACA certificate into trust registry
- List trust sources with authenticity states

**Authenticity States:**
- ✅ `VALIDATED` - XMLDSig signature verified (passes `requireAuthenticated: true`)
- ⚠️ `SKIPPED_DEMO` - No signature validation (fails `requireAuthenticated: true`)

**Usage:**
```bash
# One-time setup
npx tsx walt.ts --setup-all  # Base setup
npx tsx walt.ts --setup-etsi-trust-registry  # ETSI-specific setup

# Run flow (can be run multiple times)
npx tsx walt.ts --flow-etsi-trust-lists
```

#### Credential Revocation Flow (`--flow-credential-revocation`)

Demonstrates the complete credential revocation lifecycle using TokenStatusList CWT. **This flow is self-contained** and can be run independently - it clears existing credentials and issues its own credential with status tracking.

**Steps:**
1. Clear existing credentials from wallet
2. **Issue credential with status tracking** enabled (TokenStatusList CWT)
3. Verify credential successfully (status: VALID/0x0)
4. Revoke the credential (set status to INVALID/0x1)
5. Verify credential fails due to revoked status
6. Unrevoke the credential (reset status to VALID/0x0)
7. Verify credential succeeds again

**Status Values:**
- `0x0` - VALID (credential is active and valid)
- `0x1` - INVALID (credential is revoked)

**Verification Policies:**
- Uses **status policy only** (no VICAL) for faster, focused testing

**Usage:**
```bash
# Can run independently - does not require prior setup
npx tsx walt.ts --setup-all  # Initial setup (only needed once)
npx tsx walt.ts --flow-credential-revocation
```

#### IAM Bridge Flow (`--flow-iam-bridge`)

Demonstrates the IAM Bridge service which acts as an OIDC Identity Provider backed by Verifiable Credential presentations. This enables IAM systems like Keycloak, Auth0, Okta, or Entra ID to accept VC-based logins.

**Prerequisites:**
- Base setup completed (`--setup-all`)
- Keycloak instance (local Docker or remote)

**Flow Steps:**
1. Create IAM Bridge service with Keycloak client configuration
2. Generate Keycloak realm with IAM Bridge as identity provider
3. Start Keycloak (if local) or provide realm for import (if remote)
4. Issue mDL credential to wallet
5. Simulate OIDC authorization request
6. Present credential via IAM Bridge
7. Exchange authorization code for tokens
8. Verify user info contains credential claims

**Local Setup (Docker Keycloak):**
```bash
npx tsx walt.ts --setup-all
npx tsx walt.ts --flow-iam-bridge
```

**Remote Setup (External Keycloak + Enterprise Stack):**
```bash
export BASE_URL=enterprise.test.waltid.cloud
export ORGANIZATION=waltid
export KEYCLOAK_URL=https://keycloak.demo.walt.id
export KEYCLOAK_REALM=waltid-vc
export IAM_BRIDGE_ISSUER_URL=https://iam-bridge.enterprise.test.waltid.cloud
export ENTERPRISE_UI_URL=https://waltid.enterprise.test.waltid.cloud

npx tsx walt.ts --setup-all
npx tsx walt.ts --flow-iam-bridge
```

For remote Keycloak, the flow will:
1. Generate the realm JSON file in the logs directory
2. Print instructions for importing the realm
3. Skip Docker container startup

**Import Realm to Remote Keycloak:**
1. Open Keycloak Admin Console at `$KEYCLOAK_URL/admin`
2. Create a new realm using the generated `keycloak-realm.json`
3. Or import via CLI: `kcadm.sh create realms -f keycloak-realm.json`

### Other Commands

| Command | Description |
|---------|-------------|
| `--help`, `-h` | Show help message |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `enterprise.localhost` | Enterprise stack base URL |
| `PORT` | `0` | Port number (0 = use protocol default: 80/443) |
| `ORGANIZATION` | `waltid` | Organization ID |
| `TENANT` | `<organization>-tenant01` | Tenant ID |
| `EMAIL` | (from conf) | Superadmin email |
| `PASSWORD` | (from conf) | Superadmin password |
| `ADMIN_EMAIL` | `admin@walt.id` | Admin user email (used for regular operations) |
| `ADMIN_PASSWORD` | `admin123456` | Admin user password |
| `SUPERADMIN_TOKEN` | (from conf) | Superadmin registration token |
| `KEYCLOAK_URL` | `http://keycloak.localhost:8080` | Keycloak base URL |
| `KEYCLOAK_REALM` | `waltid-vc` | Keycloak realm name |
| `ENTERPRISE_UI_URL` | `https://waltid.enterprise.localhost` | Enterprise UI URL (for web wallet) |
| `IAM_BRIDGE_ISSUER_URL` | (from BASE_URL) | IAM Bridge issuer URL for OIDC discovery |

Superadmin credentials are read from `config/superadmin-registration.conf` by default.

## Usage Examples

### Fresh Start
```bash
# Recreate DB and run everything
npx tsx walt.ts --recreate

# Or step by step:
npx tsx walt.ts --setup-recreate     # Recreate DB + create admin user
npx tsx walt.ts --setup-all          # Setup all services (logs in as admin)
npx tsx walt.ts --run-all            # Run primary use case
```

### Testing Individual Commands
```bash
# After --setup-recreate, run setup commands one by one:
npx tsx walt.ts --setup-login           # Login as admin (default)
npx tsx walt.ts --setup-login-superadmin # Or login as superadmin
npx tsx walt.ts --setup-create-tenant
npx tsx walt.ts --setup-create-wallet
npx tsx walt.ts --setup-create-verifier2
npx tsx walt.ts --setup-create-services
npx tsx walt.ts --setup-link-x509-dependencies
npx tsx walt.ts --setup-import-keys
npx tsx walt.ts --setup-create-iaca-certificate
npx tsx walt.ts --setup-create-document-signer-certificate
npx tsx walt.ts --setup-store-vical-signer-certificate
npx tsx walt.ts --setup-create-vical-service
npx tsx walt.ts --setup-publish-vical
npx tsx walt.ts --setup-create-client-attester
npx tsx walt.ts --setup-create-credential-status-service
npx tsx walt.ts --setup-create-status-configuration
npx tsx walt.ts --setup-create-issuer2
npx tsx walt.ts --setup-link-issuer-to-credential-status
npx tsx walt.ts --setup-create-issuer-profile
npx tsx walt.ts --setup-link-wallet-to-attester
npx tsx walt.ts --setup-obtain-wallet-attestation

# Then run use case commands:
npx tsx walt.ts --run-create-credential-offer
npx tsx walt.ts --run-wallet-receive-credential
npx tsx walt.ts --run-create-verification-session
npx tsx walt.ts --run-wallet-present
npx tsx walt.ts --run-assert-final-status
```

### Testing Credential Revocation
```bash
# After setup, test revocation flow step by step:
npx tsx walt.ts --run-create-credential-offer-with-status
npx tsx walt.ts --run-wallet-receive-credential
npx tsx walt.ts --run-create-verification-session-with-status
npx tsx walt.ts --run-wallet-present
npx tsx walt.ts --run-assert-final-status

# Revoke the credential
npx tsx walt.ts --run-revoke-credential

# Verify it fails
npx tsx walt.ts --run-create-verification-session-with-status
npx tsx walt.ts --run-wallet-present
npx tsx walt.ts --run-assert-final-status-failed

# Unrevoke the credential
npx tsx walt.ts --run-unrevoke-credential

# Verify it succeeds again
npx tsx walt.ts --run-create-verification-session-with-status
npx tsx walt.ts --run-wallet-present
npx tsx walt.ts --run-assert-final-status
```

### Different Organization/Tenant
```bash
ORGANIZATION=myorg TENANT=myorg-prod npx tsx walt.ts
```

### Custom Admin Credentials
```bash
ADMIN_EMAIL=my-admin@example.com ADMIN_PASSWORD=secret123 npx tsx walt.ts --recreate
```

### Remote Deployment (HTTPS)

**Basic remote setup:**
```bash
export BASE_URL=enterprise.test.waltid.cloud
export ORGANIZATION=waltid-cli
# Note: PORT=0 (default) uses HTTPS port 443

npx tsx walt.ts --setup-all
```

**Remote IAM Bridge with external Keycloak:**
```bash
# Enterprise stack URL (no port needed for HTTPS)
export BASE_URL=enterprise.test.waltid.cloud
export ORGANIZATION=waltid

# Remote Keycloak
export KEYCLOAK_URL=https://keycloak.demo.walt.id
export KEYCLOAK_REALM=waltid-vc

# IAM Bridge URLs
export IAM_BRIDGE_ISSUER_URL=https://iam-bridge.enterprise.test.waltid.cloud
export ENTERPRISE_UI_URL=https://waltid.enterprise.test.waltid.cloud

# Run setup and IAM Bridge flow
npx tsx walt.ts --setup-all
npx tsx walt.ts --flow-iam-bridge

# The flow will generate keycloak-realm.json - import it to your Keycloak
```

### Import Trust List
```bash
npx tsx walt.ts --setup-create-trust-registry
npx tsx walt.ts --setup-import-trust-list /path/to/trust_list.xml
```

## Authentication Flow

The script uses a two-tier authentication system:

1. **Superadmin** (`EMAIL`/`PASSWORD`): Used for system initialization
   - Credentials read from `config/superadmin-registration.conf`
   - Database recreation
   - Organization creation
   - Admin user creation

2. **Admin User** (`ADMIN_EMAIL`/`ADMIN_PASSWORD`): Used for regular operations
   - Creating tenants, services, credentials
   - All `--setup-*` and `--run-*` commands

The `--setup-recreate` command automatically creates both the superadmin and admin user.

## Flow Isolation

**Important**: Each flow (`--flow-etsi-trust-lists`, `--flow-credential-revocation`) is now **self-contained** and focuses on credential issuance and verification:

### Flow Behavior
- Flows automatically **clear existing credentials** from the wallet before starting
- Each flow **issues its own credential** with the appropriate configuration
- Flows can be run multiple times without interference
- Flows handle only the credential lifecycle (issue → verify)

### Setup vs Flow Separation
- **One-time setup commands**: Configure services, trust registries, and dependencies
  - `--setup-all`: Base infrastructure
  - `--setup-etsi-trust-registry`: ETSI-specific trust lists and registry
- **Repeatable flow commands**: Issue credentials and test verification
  - `--flow-credential-revocation`: Test status lifecycle
  - `--flow-etsi-trust-lists`: Test trust list verification

This ensures:
- ✅ Predictable credential selection during presentation
- ✅ Clean testing environment for each flow
- ✅ Flows can run in any order
- ✅ No LIFO/random credential selection issues
- ✅ Clear separation between setup and testing

**Example workflow:**
```bash
# Initial setup (once)
npx tsx walt.ts --setup-all
npx tsx walt.ts --setup-etsi-trust-registry  # For ETSI flow

# Run flows independently in any order (multiple times)
npx tsx walt.ts --flow-credential-revocation
npx tsx walt.ts --flow-etsi-trust-lists
npx tsx walt.ts --flow-credential-revocation  # Can run again

# Manually clear credentials if needed
npx tsx walt.ts --clear-wallet-credentials
```

## Output

Logs are saved to `walt-log-<date>-<time>-<count>/` directories (e.g., `walt-log-2026-05-07-14-30-15-001/`):
- **Request files**: Step-numbered JSON files with full HTTP details including method, endpoint, headers, and body (e.g., `001-login-request.json`)
- **Response files**: Step-numbered JSON files with status code, status text, and response body (e.g., `001-login-response.json`)
- **Combined HTTP log**: `walt-http-log.json` with all HTTP traffic

Example request file format:
```json
{
  "timestamp": "2026-05-07T14:30:15.123Z",
  "method": "POST",
  "endpoint": "/auth/account/emailpass",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer [REDACTED]"
  },
  "body": {
    "email": "admin@walt.id",
    "password": "..."
  }
}
```

## Idempotency

The script is tolerant to already-provisioned resources:
- Existing resources show `[SKIP]` instead of failing
- Safe to run multiple times
- Use `--recreate` to start completely fresh

## Prerequisites

- Node.js 18+
- Enterprise stack running at configured URL
- Superadmin credentials in `config/superadmin-registration.conf`

## Extending the CLI

See [AGENTS.md](./AGENTS.md) for detailed guidance on:
- Adding new setup commands
- Adding new run commands
- Creating new flows
- API patterns and conventions
