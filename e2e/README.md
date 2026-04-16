# End-to-End Journey Test: mDoc + Client Attestation + VICAL

Complete TypeScript implementation of the enterprise mDoc issuance journey with client attestation and VICAL trust infrastructure.

## What's Included

### Core Implementation
- **`journey-complete.ts`** - Full journey test implementation with all 22 steps
- **`keys/`** - Pre-generated cryptographic material:
  - `iacakey.json` - IACA signing key (JWK)
  - `dskey.json` - Document signer key (JWK)
  - `attester-key.json` - Client attestation signing key (JWK)
  - `vical-signing-key.json` - VICAL publication signing key (JWK)
  - `vical-signer-cert.pem` - VICAL signer certificate (matches signing key)
- **`package.json`** - Node.js dependencies
- **`tsconfig.json`** - TypeScript configuration

## Journey Steps

1. Login
2. Create tenant
3. Initialize wallet
4. Create verifier2
5. Create KMS, X509 Service, X509 Store
6. Link X509 dependencies
7. Import keys (all 4)
8. Create IACA certificate
9. Create document signer certificate
10. Store VICAL signer certificate
11. Create VICAL service
12. Publish VICAL
13. Create client attester service
14. Create issuer2 with client attestation
15. Create issuer credential profile
16. Attach client attester to wallet
17. Wallet obtains client attestation
18. Create credential offer
19. Wallet receive credential
20. Create verification session
21. Wallet present credential
22. Assert final status = SUCCESSFUL

## Quick Start

### Prerequisites

- Node.js 18+ and npm/yarn
- Enterprise stack running at `http://enterprise.localhost:3000`
- Superadmin credentials configured in `config/superadmin-registration.conf`

### Installation

```bash
cd e2e
npm install
```

### Configuration

The script reads credentials from `../config/superadmin-registration.conf` by default.

You can override settings with environment variables:

```bash
export BASE_URL=enterprise.localhost
export PORT=3000
export ORGANIZATION=waltid
export TENANT=wallet-mdoc-client-attestation
export EMAIL=superadmin@walt.id
export PASSWORD=super123456
export SUPERADMIN_TOKEN=1234567890-my-token
```

### System Initialization

For a fresh database, run the system init first:

```bash
# Full system init (clean slate - WARNING: deletes all data!)
npx tsx journey-complete.ts --init-system

# Or individual steps:
npx tsx journey-complete.ts --recreate-db          # Recreate database
npx tsx journey-complete.ts --create-superadmin    # Create superadmin account
npx tsx journey-complete.ts --init-db              # Initialize database
npx tsx journey-complete.ts --create-organization  # Create organization
```

### Run the Journey Test

```bash
npx tsx journey-complete.ts
```

The script will:
- Create a test organization/tenant
- Set up all required services
- Import keys and create certificates
- Configure VICAL and client attestation
- Create an issuer with attestation enforcement
- Issue and verify an mDL credential
- Generate detailed logs in `journey-test-<timestamp>/`

## CLI Reference

```
Usage: npx tsx journey-complete.ts [options]

System Init Options:
  --recreate-db         Recreate all database collections (WARNING: deletes all data!)
  --create-superadmin   Create superadmin account from token
  --init-db             Initialize database (runs initial-setup)
  --create-organization Create the configured organization
  --init-system         Run full system initialization sequence
  --full-init           Alias for --init-system

Journey Test Options:
  (no options)          Run the complete mDoc + Client Attestation + VICAL journey

Other Options:
  --help, -h            Show usage information
```

## Features

### Idempotent Execution
- Safe to re-run multiple times
- Handles HTTP 409 (DuplicateTarget) gracefully
- Skips existing resources automatically

### Comprehensive Logging
- All HTTP requests/responses logged to `http-log.json`
- Intermediate payloads saved as individual JSON files
- Step-by-step progress output

### Production-Ready
- Full error handling with descriptive messages
- Type-safe TypeScript implementation
- Complete interfaces for all API requests/responses

## Key and Certificate Inventory

### Static Keys (Imported from Files)
| File | Purpose | Used By |
|------|---------|---------|
| `iacakey.json` | Signs IACA certificate | IACA cert creation |
| `dskey.json` | Signs document signer cert and credentials | Doc signer cert, issuer2 |
| `attester-key.json` | Signs client attestation JWTs | Client attester service |
| `vical-signing-key.json` | Signs VICAL publications | VICAL service |

### Generated Certificates
| Certificate | Type | Signed By | Purpose |
|-------------|------|-----------|---------|
| IACA | Dynamic | IACA key | Root trust anchor |
| Document Signer | Dynamic | IACA key (chained) | Signs issued mDocs |
| VICAL Signer | Static (PEM) | Self-signed | Authenticates VICAL publications |

Note: VICAL signer certificate (`vical-signer-cert.pem`) must match `vical-signing-key.json`.

## Architecture

```
Organization (waltid)
  Tenant (wallet-mdoc-client-attestation)
    wallet (Wallet Service)
    verifier2 (OID4VP Verifier)
    kms (Key Management)
    x509-service (Certificate Operations)
    x509-store (Certificate Storage)
      vical-iaca-cert
      vical-doc-signer-cert
      vical-signer-cert
    vical (VICAL Service)
      versions/
        <uuid> (Published VICAL)
    client-attester (Attestation Service)
    issuer2 (OID4VCI Issuer)
      mdl-profile (Credential Profile)
```

## Debugging

### Log Files

Logs are automatically saved to `journey-test-<timestamp>/`:
- `http-log.json` - All HTTP requests/responses
- `<step-name>-request.json` - Request payloads
- `<step-name>-response.json` - Response data

### Common Issues

1. **HTTP 404 on publish**: Server config issue, VICAL service needs restart
2. **HTTP 409 DuplicateTarget**: Resource already exists (script handles this)
3. **Key-certificate mismatch**: Regenerate `vical-signer-cert.pem` from JWK
4. **"Path not found"**: Ensure KMS/X509 services were created successfully
5. **"unknown scheme" fetch error**: Missing http:// prefix in URL configuration

### Test Against Different Environment

```bash
BASE_URL=my-enterprise.example.com PORT=443 npx tsx journey-complete.ts
```

## Related Documentation

- **Bash version**: Located in parent directory
- **Integration test**: `waltid-unified-build/.../MdocClientAttestationVicalJourneyIntegrationTest.kt`
