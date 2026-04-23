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

### Features
- **mDoc Issuance** - Full ISO 18013-5 mobile driving license flow
- **Client Attestation** - Wallet attestation enforcement
- **VICAL** - Verifiable Issuer Certificate Authority List
- **ETSI Trust Lists** - Enterprise trust registry integration
- **Trust List Import** - Import TSL XML, LoTE JSON, or PILOT format trust lists

## Journey Steps

1. Login
2. Create tenant
3. Initialize wallet
4. Create verifier
5. Create KMS, X509 Service, X509 Store
6. Link X509 dependencies
7. Import keys (all 4)
8. Create IACA certificate
9. Create document signer certificate
10. Store VICAL signer certificate
11. Create VICAL service
12. Publish VICAL
13. Create client attester service
14. Create issuer (client attestation config)
15. Create issuer credential profile (ISO 18013-5)
16. Attach client attester to wallet
17. Wallet obtains client attestation
18. Create credential offer (client attestation required)
19. Wallet receive credential
20. Create verification session
21. Wallet present credential
22. Assert final status (including VICAL check) = SUCCESSFUL




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
# TODO: import/export

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

Trust Registry Commands:
  --import-trust-list <file>
                        Import a trust list file into the Enterprise Trust Registry.
                        Supports TSL XML, LoTE JSON, and PILOT formats.
                        The trust-registry service must already exist in the tenant.

Journey Test Options:
  (no options)          Run the complete mDoc + Client Attestation + VICAL journey
  --etsi-trust-lists    Enable ETSI Trust List verification using external service
  --enterprise-trust-registry
                        Use Enterprise Trust Registry Service (no external deps)

Other Options:
  --help, -h            Show usage information
```

## ETSI Trust List Verification

The journey test supports ETSI Trust List verification for validating credential issuer certificates against trust lists.

### Option 1: Enterprise Trust Registry (Recommended)

```bash
# Run journey with enterprise trust registry
npx tsx journey-complete.ts --enterprise-trust-registry
```

This will:
1. Create a `trust-registry` service in the tenant
2. Load the IACA certificate as a trust source
3. Link the trust registry to verifier2
4. Add `etsi-trust-list` policy to verification sessions

### Option 2: External Trust Registry Service

```bash
# Start the external trust registry service first
TRUST_REGISTRY_URL=http://localhost:7005 npx tsx journey-complete.ts --etsi-trust-lists
```

### Importing Custom Trust Lists

Once a trust-registry service exists, you can import additional trust lists:

```bash
# Import a TSL XML file (e.g., South African DFID trust list)
npx tsx journey-complete.ts --import-trust-list /path/to/trust_list.xml

# Import a LoTE JSON file
npx tsx journey-complete.ts --import-trust-list /path/to/lote_source.json

# Example with the sample ZA trust list
npx tsx journey-complete.ts --import-trust-list ~/dev/walt-id/waltid-architecture/enterprise/trust-lists/samples/trust_list_structure_xml.xml
```

The command will:
- Detect the file format (XML or JSON)
- Load the trust source into the enterprise trust registry
- Report entities, services, and identities loaded
- List all sources in the registry after import

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

### Test Against Different Environment

```bash
BASE_URL=my-enterprise.example.com PORT=443 npx tsx journey-complete.ts
```
