# walt.ts - Enterprise Stack CLI Tool

A comprehensive CLI for setting up and running use cases against the walt.id Enterprise stack.

## Quick Start

```bash
cd cli
npm install

# Full setup + run (default)
npx tsx walt.ts

# Recreate database and start fresh
npx tsx walt.ts --recreate
```

## Commands Reference

### System Commands

| Command | Description |
|---------|-------------|
| `--recreate` | Recreate database and run full setup + primary use case |
| `--init-system` | Run system initialization only (no setup/run) |
| `--setup-recreate` | Recreate database only (alias for --init-system) |
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
| `--setup-create-issuer2` | Create issuer2 with client attestation |
| `--setup-create-issuer-profile` | Create issuer credential profile (mDL) |
| `--setup-link-wallet-to-attester` | Link wallet to client attester |
| `--setup-obtain-wallet-attestation` | Obtain wallet client attestation |

### Additional Setup Commands

| Command | Description |
|---------|-------------|
| `--setup-create-trust-registry` | Create trust registry service |
| `--setup-import-trust-list <file>` | Import trust list from file (TSL XML, LoTE JSON) |

### Run Commands

These commands execute use cases (issue/verify credentials). Assumes setup is complete.

| Command | Description |
|---------|-------------|
| `--run-all` | Run primary use case (issue + verify mDL) |
| `--run-create-credential-offer` | Create credential offer |
| `--run-wallet-receive-credential` | Wallet receives credential via pre-authorized flow |
| `--run-create-verification-session` | Create verifier2 verification session |
| `--run-wallet-present` | Wallet presents credential |
| `--run-assert-final-status` | Assert final verification status is SUCCESSFUL |

### Flow Commands (Placeholders)

| Command | Description |
|---------|-------------|
| `--flow-etsi-trust-lists` | Run ETSI trust lists verification flow |
| `--flow-credential-revocation` | Run credential revocation flow |

### Other Commands

| Command | Description |
|---------|-------------|
| `--help`, `-h` | Show help message |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `enterprise.localhost` | Enterprise stack base URL |
| `PORT` | `3000` | Port number (auto-omitted for HTTPS URLs) |
| `ORGANIZATION` | `waltid` | Organization ID |
| `TENANT` | `<organization>-tenant01` | Tenant ID |
| `EMAIL` | (from conf) | Superadmin email |
| `PASSWORD` | (from conf) | Superadmin password |
| `ADMIN_EMAIL` | `admin@walt.id` | Admin user email (used for regular operations) |
| `ADMIN_PASSWORD` | `admin123456` | Admin user password |
| `SUPERADMIN_TOKEN` | (from conf) | Superadmin registration token |

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
npx tsx walt.ts --setup-create-issuer2
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

### Different Organization/Tenant
```bash
ORGANIZATION=myorg TENANT=myorg-prod npx tsx walt.ts
```

### Custom Admin Credentials
```bash
ADMIN_EMAIL=my-admin@example.com ADMIN_PASSWORD=secret123 npx tsx walt.ts --recreate
```

### Remote Deployment (HTTPS)
```bash
export BASE_URL=https://enterprise.test.waltid.cloud
export ORGANIZATION=waltid-cli
# Note: PORT is auto-omitted for HTTPS URLs

npx tsx walt.ts --setup-login
npx tsx walt.ts --setup-all
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

## Output

Logs are saved to `walt-log-<date>-<count>/` directories:
- Step-numbered request/response JSON files (e.g., `001-login-request.json`)
- Combined HTTP log: `walt-http-log.json`

## Idempotency

The script is tolerant to already-provisioned resources:
- Existing resources show `[SKIP]` instead of failing
- Safe to run multiple times
- Use `--recreate` to start completely fresh

## Prerequisites

- Node.js 18+
- Enterprise stack running at configured URL
- Superadmin credentials in `config/superadmin-registration.conf`
