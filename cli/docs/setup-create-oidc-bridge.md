# OIDC Bridge Setup Command

## Overview

The `--setup-create-oidc-bridge` command creates an OIDC Bridge service in the walt.id Enterprise stack. The OIDC Bridge acts as an OIDC Identity Provider backed by Verifiable Credential presentations, enabling IAM systems like Keycloak, Auth0, Okta, or Entra ID to accept VC-based logins.

## Usage

```bash
npx tsx walt.ts --setup-create-oidc-bridge
```

This will:
1. Create an OIDC Bridge service at `{organization}.{tenant}.oidc-bridge`
2. Configure it with:
   - Default Keycloak client
   - Multi-flow support (QR, DC API, Deep Link, Web Wallet)
   - mDL credential verification
   - Claim mappings for OIDC attributes
   - UI branding

## Configuration

The command uses environment variables for customization:

### Required Environment Variables
None - sensible defaults are provided

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OIDC_CLIENT_ID` | `keycloak` | OIDC client identifier |
| `OIDC_CLIENT_SECRET` | `keycloak-client-secret` | Client secret for authentication |
| `KEYCLOAK_REALM` | `waltid-vc` | Keycloak realm name |
| `KEYCLOAK_URL` | `http://keycloak.localhost:8080` | Keycloak base URL |
| `OIDC_REDIRECT_URI` | (auto-generated) | OIDC redirect URI after authentication |
| `OIDC_ISSUER_URL` | (uses org base URL) | OIDC issuer URL for tokens |
| `ENTERPRISE_UI_URL` | `https://waltid.enterprise.localhost` | Enterprise UI URL for web wallet |

## Features

### Supported Flows
- **QR Code**: Cross-device flow with QR code scanning
- **DC API**: Browser-based Digital Credentials API (Chrome)
- **Deep Link**: openid4vp:// scheme for same-device mobile wallets
- **Web Wallet**: Direct link to Enterprise UI web wallet

### Credential Support
- mDL (ISO 18013-5.1) with full namespace support
- Configurable DCQL queries
- JSONPath-based claim extraction

### Claim Mappings
Standard OIDC claims mapped from mDL attributes:
- `sub` ← document_number
- `given_name` ← given_name
- `family_name` ← family_name
- `birthdate` ← birth_date
- Plus additional document fields

## Dependencies

The OIDC Bridge service depends on:
- `{organization}.{tenant}.kms` - Key Management Service
- `{organization}.{tenant}.verifier2` - Verifier Service

These must exist before creating the OIDC Bridge.

## Example Output

```
>> Create OIDC Bridge service
   [INFO] Client ID: keycloak
   [INFO] Redirect URI: http://keycloak.localhost:8080/realms/waltid-vc/broker/waltid-vc/endpoint
   [INFO] Issuer URL: https://waltid.enterprise.localhost
   [INFO] Web Wallet URL: https://waltid.enterprise.localhost
   [OK] OIDC Bridge service created: waltid.waltid-tenant01.oidc-bridge
   [INFO] OIDC Discovery: https://waltid.enterprise.localhost/.well-known/openid-configuration
   [INFO] Authorization endpoint: https://waltid.enterprise.localhost/v1/waltid.waltid-tenant01.oidc-bridge/authorize
```

## OIDC Endpoints

After creation, the following OIDC endpoints are available:

- **Discovery**: `{issuerUrl}/.well-known/openid-configuration`
- **JWKS**: `{issuerUrl}/v1/{org}.{tenant}.oidc-bridge/jwks`
- **Authorization**: `{issuerUrl}/v1/{org}.{tenant}.oidc-bridge/authorize`
- **Token**: `{issuerUrl}/v1/{org}.{tenant}.oidc-bridge/token`
- **UserInfo**: `{issuerUrl}/v1/{org}.{tenant}.oidc-bridge/userinfo`

## Integration with IAM Systems

### Keycloak Example

1. Create OIDC Bridge:
   ```bash
   npx tsx walt.ts --setup-create-oidc-bridge
   ```

2. In Keycloak Admin Console:
   - Go to Identity Providers → Add provider → OpenID Connect v1.0
   - Set Discovery URL: `{issuerUrl}/.well-known/openid-configuration`
   - Set Client ID: `keycloak` (or your custom value)
   - Set Client Secret: `keycloak-client-secret` (or your custom value)
   - Save

3. Users can now login via "walt.id VC" button in Keycloak

### Other IAM Systems

The OIDC Bridge implements standard OIDC 1.0 protocol and should work with:
- Auth0
- Okta
- Azure Entra ID (formerly Azure AD)
- Google Identity Platform
- Any OIDC-compliant identity provider

## Files Created

The command saves request/response JSON to the working directory:
- `{step}-create-oidc-bridge-request.json`
- `{step}-create-oidc-bridge-response.json`

## Related Commands

- `--setup-all` - Runs full setup including all prerequisites
- `--setup-create-tenant` - Creates tenant (required)
- `--setup-create-wallet` - Creates wallet service (for credential issuance)
- `--setup-create-verifier2` - Creates verifier2 service (required dependency)

## Troubleshooting

### "Resource already exists"
The command is idempotent - it will skip creation if the service already exists.

### "KMS not found"
Run `--setup-create-services` first to create KMS and other base services.

### "Verifier2 not found"
Run `--setup-create-verifier2` first.

## Architecture

```
┌─────────┐     ┌─────────┐     ┌──────────────┐     ┌──────────┐
│   IAM   │────▶│  OIDC   │────▶│  Verifier2   │────▶│  Wallet  │
│ System  │     │ Bridge  │     │   Service    │     │   App    │
└─────────┘     └─────────┘     └──────────────┘     └──────────┘
    │               │                   │                   │
    │ 1. Redirect   │                   │                   │
    │──────────────▶│                   │                   │
    │               │ 2. Create session │                   │
    │               │──────────────────▶│                   │
    │               │                   │ 3. Present VC     │
    │               │                   │◀──────────────────│
    │               │ 4. Issue tokens   │                   │
    │◀──────────────│                   │                   │
```

## Security Considerations

- Client secrets should be kept secure and rotated periodically
- Use HTTPS in production for all URLs
- Validate redirect URIs carefully to prevent open redirects
- Token lifetimes are configurable (default: 1 hour)
- Presentation timeout prevents stale sessions (default: 5 minutes)

## Next Steps

After creating the OIDC Bridge:

1. **Issue a credential** to test wallet
2. **Configure IAM system** to use OIDC Bridge as identity provider
3. **Test login flow** end-to-end
4. **Customize UI branding** via `uiConfig` if needed
5. **Add additional clients** for other IAM systems
