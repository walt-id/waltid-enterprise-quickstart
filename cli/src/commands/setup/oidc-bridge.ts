/**
 * OIDC Bridge setup commands
 */

import { CommandContext } from '../../context.js';
import { RESOURCES } from '../../config.js';

const OIDC_BRIDGE_SERVICE = 'oidc-bridge';
const DEFAULT_CLIENT_ID = 'ory-login-consent-app';
const DEFAULT_CLIENT_SECRET = 'ory-login-consent-secret';

/**
 * Create OIDC Bridge service
 * 
 * This command creates the OIDC Bridge service configured for integration
 * with identity providers like Ory Hydra, Keycloak, etc.
 */
export async function setupCreateOidcBridge(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create OIDC Bridge service', 'SETUP');
  
  const oidcBridgePath = `${ctx.tenantPath}.${OIDC_BRIDGE_SERVICE}`;
  
  // Check if already exists
  try {
    await ctx.orgClient.get(`/v1/${oidcBridgePath}`);
    console.log('   [SKIP] OIDC Bridge service already exists');
    return;
  } catch (e: any) {
    if (e.status !== 404) throw e;
  }
  
  // Get configuration from context or environment
  // Use orgBaseUrl which is already properly constructed with protocol and port
  const issuerUrl = ctx.orgBaseUrl;
  const clientId = process.env.OIDC_BRIDGE_CLIENT_ID || DEFAULT_CLIENT_ID;
  const clientSecret = process.env.OIDC_BRIDGE_CLIENT_SECRET || DEFAULT_CLIENT_SECRET;
  const redirectUri = process.env.OIDC_BRIDGE_REDIRECT_URI || 'http://login-app.localhost:3001/login/oidc-callback';
  
  console.log(`   [INFO] Issuer URL: ${issuerUrl}`);
  console.log(`   [INFO] Client ID: ${clientId}`);
  console.log(`   [INFO] Redirect URI: ${redirectUri}`);
  
  // Base DCQL query used for all flows.
  // Matches the working reference config used in production demos:
  //   waltid-identity-enterprise/ory/docs/oidc-bridge-config.json
  // Important: `multiple: false`, `meta.format`, and
  // `require_cryptographic_holder_binding: true` are required for the
  // Digital Credentials API browser flow to match an mDL credential.
  const baseDcqlQuery = {
    credentials: [
      {
        id: 'my_mdl',
        format: 'mso_mdoc',
        multiple: false,
        meta: {
          doctype_value: 'org.iso.18013.5.1.mDL',
          format: 'mso_mdoc',
        },
        require_cryptographic_holder_binding: true,
        claims: [
          { path: ['org.iso.18013.5.1', 'family_name'] },
          { path: ['org.iso.18013.5.1', 'given_name'] },
          { path: ['org.iso.18013.5.1', 'birth_date'] },
          { path: ['org.iso.18013.5.1', 'document_number'] },
          { path: ['org.iso.18013.5.1', 'issue_date'] },
          { path: ['org.iso.18013.5.1', 'expiry_date'] },
          { path: ['org.iso.18013.5.1', 'issuing_country'] },
          { path: ['org.iso.18013.5.1', 'issuing_authority'] },
          { path: ['org.iso.18013.5.1', 'un_distinguishing_sign'] },
        ],
      },
    ],
  };
  
  // Signing key and certificate chain for signed requests (used by all flows)
  const signingKey = {
    type: 'jwk',
    jwk: {
      kty: 'EC',
      crv: 'P-521',
      x: 'APWg4T3FQIeJD_xQN0kap5Mzp7lJ17Ctg_T8Gy24lwOp_EIhDzBK9MoCufSIITRolWlcjFTj3Ty91C9rctTuSf0F',
      y: 'AEnFDKiecuqnZ8XMKgt7dFZWRfmzPFrgQmauwlbXDC0kHCZhV76VOgCoWdzfSLegLKGn-nINAIRqPR9n2KPpQwKn',
      d: 'AZT9f0qOOSMQl25qXwvFs23rq0PIUOV1R8YcG1iqRNKEYYs5k8gXNNuud4W6amuItCGWCrKSXRoHmgj6C5NUDzhA',
    },
  };
  
  const certificateChain = [
    'MIIB7TCCAZOgAwIBAgIUXrHFKoaAx6+CFOOHp6fZ7Rs2EzgwCgYIKoZIzj0EAwIwHTEbMBkGA1UEAwwSQ3VzdG9tSW50ZXJtZWRpYXRlMB4XDTI2MDEyMjE1NTY0OFoXDTI3MDEyMjE1NTY0OFowEzERMA8GA1UEAwwIVmVyaWZpZXIwgZswEAYHKoZIzj0CAQYFK4EEACMDgYYABAD1oOE9xUCHiQ/8UDdJGqeTM6e5SdewrYP0/BstuJcDqfxCIQ8wSvTKArn0iCE0aJVpXIxU4908vdQva3LU7kn9BQBJxQyonnLqp2fFzCoLe3RWVkX5szxa4EJmrsJW1wwtJBwmYVe+lToAqFnc30i3oCyhp/pyDQCEaj0fZ9ij6UMCp6N4MHYwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwFgYDVR0RBA8wDYILZXhhbXBsZS5jb20wHQYDVR0OBBYEFFAdasyU1haLdvQdEizJEaAO+cmWMB8GA1UdIwQYMBaAFGVh3m3K6y5gABHGIuD7ibTR+AG6MAoGCCqGSM49BAMCA0gAMEUCIQDT9GYMvTTyEOmKDvilHmgejcbLWQ6ACUzlmbZDk67ztAIge2kWDxRetz6xIDtnfg4vlCW6pLbdBWasMrfm1eppDww=',
    'MIIBlzCCAT2gAwIBAgIUZFEF4iwIsLuJO7pJ9bU7vo9Dg3kwCgYIKoZIzj0EAwIwFTETMBEGA1UEAwwKQ3VzdG9tUm9vdDAeFw0yNjAxMjIxNTU1NDJaFw0zNjAxMjAxNTU1NDJaMB0xGzAZBgNVBAMMEkN1c3RvbUludGVybWVkaWF0ZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABAvlBFSSRWetJJSj5rvGoXtPnfw97YRHbJj4/kspQbSwxVN3RtofsSu0DevrISGx2MCPqqxHXdfSeu9SKgen6IOjYzBhMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBRlYd5tyusuYAARxiLg+4m00fgBujAfBgNVHSMEGDAWgBQ+D1YkeDpF+qaxAhlnb3XSkGZWCTAKBggqhkjOPQQDAgNIADBFAiEA789kIQsGTa/GJEgYaOID9VVoO0PyeeYEwub7P0a1+ZICIHI9bYi72XTca9e8rqGJuYmKz8qEQodLvaXdgwCfQ4KZ',
  ];
  
  // Default verification setup for cross-device flows (QR code, deep link)
  // This uses standard OpenID4VP with direct_post response mode.
  //
  // NOTE: signed_request / encrypted_response are intentionally `false` and
  // `policies: {}` is set explicitly to mirror the reference config.
  // Flipping these to `true` requires extra wallet/verifier configuration
  // (signed authorization request JWS, encrypted vp_token JWE) and broke
  // browser DC API flows in earlier tests.
  const defaultVerificationSetup = {
    flow_type: 'cross_device',
    core_flow: {
      dcql_query: baseDcqlQuery,
      signed_request: false,
      encrypted_response: false,
      policies: {},
      key: signingKey,
      x5c: certificateChain,
    },
    url_config: {},
  };
  
  // Multi-flow configuration: enables all four presentation flows
  const flows = {
    // QR Code flow: Cross-device presentation (scan QR with mobile wallet)
    qr: {
      enabled: true,
      buttonLabel: 'Scan QR Code with Mobile Wallet',
      // Uses defaultVerificationSetup (cross_device flow)
    },
    // Digital Credentials API flow: Browser-native credential picker
    dc_api: {
      enabled: true,
      buttonLabel: 'Browser Wallet (Digital Credentials API)',
      // DC API requires its own verification setup with expectedOrigins
      verificationSetup: {
        flow_type: 'dc_api',
        core: {
          dcql_query: baseDcqlQuery,
          // signed_request / encrypted_response stay `false` to match the
          // working reference config in waltid-identity-enterprise/ory/docs.
          signed_request: false,
          encrypted_response: false,
          policies: {},
          clientId: 'x509_hash:kZ5SI3MAFaLDPRxza8xguw-o6b8LYfmP2ZvrqVSRWng',
          key: signingKey,
          x5c: certificateChain,
        },
        // Expected origins for DC API - must match the page origin where credential.get() is called
        expectedOrigins: [issuerUrl],
        haip: false,
      },
    },
    // Deep Link flow: Same-device mobile wallet launch (openid4vp://)
    deep_link: {
      enabled: true,
      buttonLabel: 'Open Mobile Wallet App',
      // Uses defaultVerificationSetup (cross_device flow)
    },
    // Web Wallet flow: Redirect to browser-based wallet
    web_wallet: {
      enabled: false,
      buttonLabel: 'Open Web Wallet',
      // Disabled by default; enable if you have a web wallet deployed
    },
  };
  
  const request = {
    type: 'oidc-bridge',
    _id: oidcBridgePath,
    parent: ctx.tenantPath,
    issuerUrl: issuerUrl,
    enabled: true,
    clients: {
      [clientId]: {
        clientId: clientId,
        clientSecret: clientSecret,
        redirectUris: [redirectUri],
        allowedScopes: ['openid', 'profile', 'email'],
      },
    },
    defaultClaimMappings: [
      // mDL claim mappings - claims are in org.iso.18013.5.1 namespace
      { oidcClaim: 'sub', credentialPath: '$["org.iso.18013.5.1"]["document_number"]', transform: 'NONE' },
      { oidcClaim: 'given_name', credentialPath: '$["org.iso.18013.5.1"]["given_name"]', transform: 'NONE' },
      { oidcClaim: 'family_name', credentialPath: '$["org.iso.18013.5.1"]["family_name"]', transform: 'NONE' },
      { oidcClaim: 'birthdate', credentialPath: '$["org.iso.18013.5.1"]["birth_date"]', transform: 'NONE' },
      { oidcClaim: 'document_number', credentialPath: '$["org.iso.18013.5.1"]["document_number"]', transform: 'NONE' },
      { oidcClaim: 'issue_date', credentialPath: '$["org.iso.18013.5.1"]["issue_date"]', transform: 'NONE' },
      { oidcClaim: 'expiry_date', credentialPath: '$["org.iso.18013.5.1"]["expiry_date"]', transform: 'NONE' },
      { oidcClaim: 'issuing_country', credentialPath: '$["org.iso.18013.5.1"]["issuing_country"]', transform: 'NONE' },
      { oidcClaim: 'issuing_authority', credentialPath: '$["org.iso.18013.5.1"]["issuing_authority"]', transform: 'NONE' },
      { oidcClaim: 'un_distinguishing_sign', credentialPath: '$["org.iso.18013.5.1"]["un_distinguishing_sign"]', transform: 'NONE' },
    ],
    // Default verification setup for QR and deep link flows
    defaultVerificationSetup: defaultVerificationSetup,
    // Multi-flow configuration: enables all presentation flows
    flows: flows,
    tokenLifetime: {
      idTokenExpirySeconds: 3600,
      accessTokenExpirySeconds: 3600,
      authCodeExpirySeconds: 300,
    },
    presentationTimeoutSeconds: 300,
    // UI customization
    uiConfig: {
      brandName: 'walt.id Enterprise',
      primaryColor: '#3B82F6',
      webWalletBaseUrl: issuerUrl,
    },
    // `traversable: true` is required so the bridge's REST endpoints (e.g.
    // /authorize, /token, /.well-known/openid-configuration) are reachable
    // through the resource API gateway. Matches the reference config.
    traversable: true,
    dependencies: [
      `${ctx.tenantPath}.${RESOURCES.kms}`,
      `${ctx.tenantPath}.${RESOURCES.verifier2}`,
    ],
  };
  
  ctx.saveJson('create-oidc-bridge-request.json', request, step);
  
  const response = await ctx.orgClient.post(
    `/v1/${oidcBridgePath}/resource-api/services/create`,
    request
  );
  ctx.saveJson('create-oidc-bridge-response.json', response.data, step);
  
  console.log(`   [OK] OIDC Bridge service created at ${oidcBridgePath}`);
  console.log(`        Issuer URL: ${issuerUrl}`);
  console.log(`        Client ID: ${clientId}`);
  console.log(`        OIDC Discovery: ${issuerUrl}/v1/${oidcBridgePath}/oidc-bridge-api/.well-known/openid-configuration`);
}
