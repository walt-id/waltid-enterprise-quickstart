/**
 * IAM Bridge Flow
 * 
 * Demonstrates the IAM Bridge service which acts as an OIDC Identity Provider
 * backed by Verifiable Credential presentations. This enables IAM systems like
 * Keycloak, Auth0, Okta, or Entra ID to accept VC-based logins.
 * 
 * Steps:
 * 1. Setup IAM Bridge service with Keycloak client
 * 2. Start Keycloak with the IAM Bridge realm
 * 3. Issue a credential to the wallet
 * 4. Trigger OIDC login flow through Keycloak
 * 5. Present credential and complete authentication
 */

import { mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { CommandContext } from '../context.js';
import { RESOURCES } from '../config.js';
import { setupLogin } from '../commands/setup/index.js';
import {
  runCreateCredentialOffer,
  runWalletReceiveCredential,
  runWalletPresent,
  clearWalletCredentials,
} from '../commands/run.js';

// ============================================================================
// Constants
// ============================================================================

const IAM_BRIDGE_SERVICE = 'iam-bridge';
const KEYCLOAK_CLIENT_ID = 'keycloak';
const KEYCLOAK_CLIENT_SECRET = 'keycloak-client-secret';

// ============================================================================
// Setup Functions
// ============================================================================

/** Create IAM Bridge service */
async function setupIamBridge(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create IAM Bridge service', 'SETUP');
  
  const iamBridgePath = `${ctx.tenantPath}.${IAM_BRIDGE_SERVICE}`;
  
  // Check if already exists
  try {
    await ctx.orgClient.get(`/v1/${iamBridgePath}`);
    console.log('   [SKIP] IAM Bridge service already exists');
    return;
  } catch (e: any) {
    if (e.status !== 404) throw e;
  }
  
  const keycloakRedirectUri = `http://keycloak.localhost:8080/realms/waltid-vc/broker/waltid-vc/endpoint`;
  
  // For Docker to reach the Enterprise API, we need to use localhost:PORT
  // instead of the subdomain-based URL (waltid.enterprise.localhost:3000)
  // because Docker's --network host mode resolves localhost to host, but
  // custom subdomains may not resolve correctly inside the container.
  const port = ctx.config.port || 3000;
  const dockerAccessibleUrl = `http://localhost:${port}`;
  
  // Standard cross-device verification setup for CLI testing
  // Uses ISO mDL format - same as the main verification flow
  const verificationSetup = {
    flow_type: 'cross_device',
    core_flow: {
      dcql_query: {
        credentials: [
          {
            id: 'my_mdl',
            format: 'mso_mdoc',
            meta: {
              doctype_value: 'org.iso.18013.5.1.mDL',
            },
            claims: [
              { path: ['org.iso.18013.5.1', 'family_name'] },
              { path: ['org.iso.18013.5.1', 'given_name'] },
              { path: ['org.iso.18013.5.1', 'birth_date'] },
            ],
          },
        ],
      },
    },
  };
  
  const request = {
    type: 'iam-bridge',
    _id: iamBridgePath,
    // Use Docker-accessible URL for token/userinfo endpoints that Keycloak calls
    issuerUrl: dockerAccessibleUrl,
    enabled: true,
    clients: {
      [KEYCLOAK_CLIENT_ID]: {
        clientId: KEYCLOAK_CLIENT_ID,
        clientSecret: KEYCLOAK_CLIENT_SECRET,
        redirectUris: [keycloakRedirectUri],
        allowedScopes: ['openid', 'profile', 'email'],
      },
    },
    defaultClaimMappings: [
      { oidcClaim: 'sub', credentialPath: '$.credentialSubject.id', transform: 'NONE' },
      { oidcClaim: 'email', credentialPath: '$.credentialSubject.email', transform: 'LOWERCASE' },
      { oidcClaim: 'given_name', credentialPath: '$.credentialSubject.given_name', transform: 'NONE' },
      { oidcClaim: 'family_name', credentialPath: '$.credentialSubject.family_name', transform: 'NONE' },
    ],
    // Standard cross-device verification setup for CLI testing
    // (DC API is handled separately in the browser with dc_api=true)
    defaultVerificationSetup: verificationSetup,
    tokenLifetime: {
      idTokenExpirySeconds: 3600,
      accessTokenExpirySeconds: 3600,
    },
    presentationTimeoutSeconds: 300,
    dependencies: [
      `${ctx.tenantPath}.${RESOURCES.kms}`,
      `${ctx.tenantPath}.${RESOURCES.verifier2}`,
    ],
  };
  ctx.saveJson('create-iam-bridge-request.json', request, step);
  
  const response = await ctx.orgClient.post(
    `/v1/${iamBridgePath}/resource-api/services/create`,
    request
  );
  ctx.saveJson('create-iam-bridge-response.json', response.data, step);
  
  console.log(`   [OK] IAM Bridge service created at ${iamBridgePath}`);
}

/** Configure verification setup for IAM Bridge */
async function setupIamBridgeVerification(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Configure IAM Bridge verification setup', 'SETUP');
  
  const iamBridgePath = `${ctx.tenantPath}.${IAM_BRIDGE_SERVICE}`;
  
  const verificationSetup = {
    core: {
      presentationDefinition: {
        id: 'vc-login',
        input_descriptors: [
          {
            id: 'identity-credential',
            name: 'Identity Credential',
            purpose: 'We need to verify your identity to log you in',
            constraints: {
              fields: [
                {
                  path: ['$.type'],
                  filter: {
                    type: 'array',
                    contains: {
                      type: 'string',
                      pattern: 'VerifiableId|IdentityCredential|PersonalIdentityCredential|mDL',
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  };
  ctx.saveJson('iam-bridge-verification-setup-request.json', verificationSetup, step);
  
  // Update the service config with verification setup
  const configResponse = await ctx.orgClient.get(`/v1/${iamBridgePath}`);
  const currentConfig = configResponse.data;
  
  const updateRequest = {
    ...currentConfig,
    defaultVerificationSetup: verificationSetup,
  };
  
  await ctx.orgClient.put(`/v1/${iamBridgePath}/configuration`, updateRequest);
  
  console.log('   [OK] IAM Bridge verification setup configured');
}

/** Get IAM Bridge discovery document */
async function getIamBridgeDiscovery(ctx: CommandContext): Promise<any> {
  const step = ctx.nextStep();
  ctx.log('Get IAM Bridge OIDC discovery', 'INFO');
  
  const iamBridgePath = `${ctx.tenantPath}.${IAM_BRIDGE_SERVICE}`;
  
  const response = await ctx.orgClient.get(
    `/v1/${iamBridgePath}/iam-bridge-api/.well-known/openid-configuration`
  );
  ctx.saveJson('iam-bridge-discovery.json', response.data, step);
  
  console.log('   [OK] OIDC Discovery:');
  console.log(`        Issuer: ${response.data.issuer}`);
  console.log(`        Authorization: ${response.data.authorization_endpoint}`);
  console.log(`        Token: ${response.data.token_endpoint}`);
  console.log(`        JWKS: ${response.data.jwks_uri}`);
  
  return response.data;
}

/** Generate Keycloak realm configuration */
function generateKeycloakRealm(ctx: CommandContext, discovery: any): string {
  // Replace subdomain-based URLs with localhost URLs for Docker accessibility
  // The browser uses waltid.enterprise.localhost:PORT but Docker needs localhost:PORT
  const port = ctx.config.port || 3000;
  const subdomainPattern = new RegExp(`https?://[^/]+\\.localhost:${port}`, 'g');
  const dockerBaseUrl = `http://localhost:${port}`;
  
  // Convert discovery URLs to Docker-accessible URLs
  const tokenUrl = discovery.token_endpoint.replace(subdomainPattern, dockerBaseUrl);
  const authorizationUrl = discovery.authorization_endpoint; // Keep as-is for browser redirect
  const jwksUrl = discovery.jwks_uri.replace(subdomainPattern, dockerBaseUrl);
  const issuer = discovery.issuer.replace(subdomainPattern, dockerBaseUrl);
  
  const realm = {
    realm: 'waltid-vc',
    enabled: true,
    displayName: 'walt.id Enterprise (VC Login)',
    displayNameHtml: '<strong>walt.id</strong> Enterprise - VC Login',
    loginTheme: 'keycloak',
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 36000,
    roles: {
      realm: [
        { name: 'vc-verified', description: 'User verified via Verifiable Credential' },
      ],
    },
    clients: [
      {
        clientId: 'demo-app',
        name: 'Demo Application',
        description: 'Demo application using VC-based login',
        enabled: true,
        protocol: 'openid-connect',
        publicClient: true,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        redirectUris: ['http://localhost:8081/*', 'http://demo.localhost:8081/*'],
        webOrigins: ['http://localhost:8081', 'http://demo.localhost:8081'],
      },
    ],
    identityProviders: [
      {
        alias: 'waltid-vc',
        displayName: 'Login with Verifiable Credential',
        providerId: 'oidc',
        enabled: true,
        updateProfileFirstLoginMode: 'on',
        trustEmail: true,
        storeToken: false,
        addReadTokenRoleOnCreate: false,
        authenticateByDefault: false,
        linkOnly: false,
        firstBrokerLoginFlowAlias: 'first broker login',
        config: {
          hideOnLoginPage: 'false',
          validateSignature: 'true',
          clientId: KEYCLOAK_CLIENT_ID,
          // Use Docker-accessible URLs for backend calls
          tokenUrl: tokenUrl,
          // Authorization URL can use subdomain since it's a browser redirect
          authorizationUrl: authorizationUrl,
          clientAuthMethod: 'client_secret_post',
          jwksUrl: jwksUrl,
          clientSecret: KEYCLOAK_CLIENT_SECRET,
          // Use Docker-accessible issuer URL
          issuer: issuer,
          useJwksUrl: 'true',
          pkceEnabled: 'true',
          pkceMethod: 'S256',
          defaultScope: 'openid profile email',
          syncMode: 'IMPORT',
        },
      },
    ],
    identityProviderMappers: [
      {
        name: 'email-mapper',
        identityProviderAlias: 'waltid-vc',
        identityProviderMapper: 'oidc-user-attribute-idp-mapper',
        config: { claim: 'email', 'user.attribute': 'email', syncMode: 'INHERIT' },
      },
      {
        name: 'given-name-mapper',
        identityProviderAlias: 'waltid-vc',
        identityProviderMapper: 'oidc-user-attribute-idp-mapper',
        config: { claim: 'given_name', 'user.attribute': 'firstName', syncMode: 'INHERIT' },
      },
      {
        name: 'family-name-mapper',
        identityProviderAlias: 'waltid-vc',
        identityProviderMapper: 'oidc-user-attribute-idp-mapper',
        config: { claim: 'family_name', 'user.attribute': 'lastName', syncMode: 'INHERIT' },
      },
      {
        name: 'vc-verified-role-mapper',
        identityProviderAlias: 'waltid-vc',
        identityProviderMapper: 'hardcoded-role-idp-mapper',
        config: { role: 'vc-verified', syncMode: 'INHERIT' },
      },
    ],
    users: [],
  };
  
  return JSON.stringify(realm, null, 2);
}

/** Start Keycloak with custom realm */
async function startKeycloak(ctx: CommandContext, realmJson: string): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Start Keycloak with IAM Bridge realm', 'SETUP');
  
  // Save realm file
  const realmPath = `${ctx.workdir}/keycloak-realm.json`;
  writeFileSync(realmPath, realmJson);
  console.log(`   [OK] Realm config saved to ${realmPath}`);
  
  // Check if Keycloak is already running
  try {
    const result = execSync('docker ps --filter name=waltid-keycloak-iam-bridge --format "{{.Names}}"', { encoding: 'utf-8' });
    if (result.includes('waltid-keycloak-iam-bridge')) {
      console.log('   [SKIP] Keycloak already running');
      return;
    }
  } catch (_) {
    // Docker command failed, continue to start
  }
  
  // Stop any existing container
  try {
    execSync('docker rm -f waltid-keycloak-iam-bridge 2>/dev/null || true', { encoding: 'utf-8' });
  } catch (_) {
    // Ignore errors
  }
  
  // Start Keycloak
  const dockerCmd = `docker run -d \
    --name waltid-keycloak-iam-bridge \
    --network host \
    -v ${realmPath}:/opt/keycloak/data/import/realm.json:ro \
    -e KEYCLOAK_ADMIN=admin \
    -e KEYCLOAK_ADMIN_PASSWORD=admin \
    quay.io/keycloak/keycloak:26.0 \
    start-dev --import-realm --hostname=keycloak.localhost --hostname-strict=false --http-enabled=true`;
  
  console.log('   [INFO] Starting Keycloak container...');
  execSync(dockerCmd, { encoding: 'utf-8' });
  
  // Wait for Keycloak to be ready
  console.log('   [INFO] Waiting for Keycloak to start...');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      execSync('curl -sf http://keycloak.localhost:8080/realms/master', { encoding: 'utf-8' });
      ready = true;
      break;
    } catch (_) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  if (!ready) {
    throw new Error('Keycloak failed to start within 2 minutes');
  }
  
  console.log('   [OK] Keycloak started at http://keycloak.localhost:8080');
  console.log('        Admin console: http://keycloak.localhost:8080/admin (admin/admin)');
  console.log('        Login page: http://keycloak.localhost:8080/realms/waltid-vc/account');
}

/** Simulate OIDC authorization request */
async function simulateOidcAuthorize(ctx: CommandContext): Promise<{ bridgeSessionId: string; verificationUrl: string }> {
  const step = ctx.nextStep();
  ctx.log('Simulate OIDC authorization request', 'FLOW');
  
  const iamBridgePath = `${ctx.tenantPath}.${IAM_BRIDGE_SERVICE}`;
  const redirectUri = 'http://keycloak.localhost:8080/realms/waltid-vc/broker/waltid-vc/endpoint';
  const state = `test-state-${Date.now()}`;
  const nonce = `test-nonce-${Date.now()}`;
  
  // Make authorize request using fetch for more control
  const authorizeUrl = `/v1/${iamBridgePath}/iam-bridge-api/authorize?` +
    `response_type=code&` +
    `client_id=${KEYCLOAK_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=openid%20profile%20email&` +
    `state=${state}&` +
    `nonce=${nonce}`;
  
  const fullUrl = `${ctx.orgBaseUrl}${authorizeUrl}`;
  const headers: Record<string, string> = {};
  if (ctx.ctx.token) {
    headers['Authorization'] = `Bearer ${ctx.ctx.token}`;
  }
  
  const response = await fetch(fullUrl, {
    method: 'GET',
    headers,
    redirect: 'manual',
  });
  
  const html = await response.text();
  
  // Parse the HTML response to extract session info
  // Look for various patterns the HTML might use
  const sessionIdMatch = html.match(/sessionId['": \s]*['"]([^'"]+)['"]/) || 
                         html.match(/data-session-id=['"]([^'"]+)['"]/) ||
                         html.match(/bridgeSessionId['": \s]*['"]([^'"]+)['"]/) ||
                         html.match(/\/sessions\/([a-f0-9-]+)\/status/);
  const verificationUrlMatch = html.match(/verificationUrl['": \s]*['"]([^'"]+)['"]/) ||
                               html.match(/(openid4vp:\/\/[^'"<>\s]+)/) ||
                               html.match(/data-verification-url=['"]([^'"]+)['"]/) ||
                               html.match(/text:\s*['"]?(openid4vp:\/\/[^'"]+)['"]?/);  
  if (!sessionIdMatch || !verificationUrlMatch) {
    ctx.saveJson('iam-bridge-authorize-raw.html', html, step);
    console.log('   [DEBUG] Raw HTML saved to logs - could not parse session info');
    throw new Error('Could not extract session info from authorize response');
  }
  
  const bridgeSessionId = sessionIdMatch[1];
  let verificationUrl = verificationUrlMatch[1];
  verificationUrl = verificationUrl.replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  
  ctx.saveJson('iam-bridge-authorize-response.json', { bridgeSessionId, verificationUrl, state, nonce }, step);
  
  console.log(`   [OK] Bridge session created: ${bridgeSessionId}`);
  console.log(`        Verification URL: ${verificationUrl.substring(0, 80)}...`);
  
  // Store for wallet presentation
  ctx.ctx.sessionId = bridgeSessionId;
  ctx.ctx.requestUrl = verificationUrl;
  
  return { bridgeSessionId, verificationUrl };
}

/** Poll IAM Bridge session status */
async function pollSessionStatus(ctx: CommandContext, bridgeSessionId: string): Promise<any> {
  const step = ctx.nextStep();
  ctx.log('Poll IAM Bridge session status', 'FLOW');
  
  const iamBridgePath = `${ctx.tenantPath}.${IAM_BRIDGE_SERVICE}`;
  
  let status: any;
  for (let i = 0; i < 30; i++) {
    const response = await ctx.orgClient.get(
      `/v1/${iamBridgePath}/iam-bridge-api/sessions/${bridgeSessionId}/status`
    );
    status = response.data;
    
    if (status.status === 'success') {
      ctx.saveJson('iam-bridge-session-status.json', status, step);
      console.log(`   [OK] Session completed successfully`);
      console.log(`        Redirect URL: ${status.redirectUrl?.substring(0, 80)}...`);
      return status;
    }
    
    if (status.status === 'failed' || status.status === 'expired') {
      ctx.saveJson('iam-bridge-session-status.json', status, step);
      throw new Error(`Session ${status.status}: ${status.error}`);
    }
    
    console.log(`   [INFO] Session status: ${status.status} (attempt ${i + 1}/30)`);
    await new Promise(r => setTimeout(r, 2000));
  }
  
  throw new Error('Session polling timeout');
}

/** Exchange authorization code for tokens */
async function exchangeToken(ctx: CommandContext, redirectUrl: string): Promise<any> {
  const step = ctx.nextStep();
  ctx.log('Exchange authorization code for tokens', 'FLOW');
  
  const iamBridgePath = `${ctx.tenantPath}.${IAM_BRIDGE_SERVICE}`;
  
  // Parse code from redirect URL
  const url = new URL(redirectUrl);
  const code = url.searchParams.get('code');
  
  if (!code) {
    throw new Error('No authorization code in redirect URL');
  }
  
  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'http://keycloak.localhost:8080/realms/waltid-vc/broker/waltid-vc/endpoint',
    client_id: KEYCLOAK_CLIENT_ID,
    client_secret: KEYCLOAK_CLIENT_SECRET,
  });
  
  ctx.saveJson('iam-bridge-token-request.json', Object.fromEntries(tokenParams), step);
  
  const response = await ctx.orgClient.post(
    `/v1/${iamBridgePath}/iam-bridge-api/token`,
    tokenParams.toString(),
    'application/x-www-form-urlencoded'
  );
  ctx.saveJson('iam-bridge-token-response.json', response.data, step);
  
  console.log('   [OK] Tokens received:');
  console.log(`        ID Token: ${response.data.id_token?.substring(0, 50)}...`);
  console.log(`        Access Token: ${response.data.access_token?.substring(0, 50)}...`);
  console.log(`        Expires In: ${response.data.expires_in}s`);
  
  return response.data;
}

/** Get user info from access token */
async function getUserInfo(ctx: CommandContext, accessToken: string): Promise<any> {
  const step = ctx.nextStep();
  ctx.log('Get user info', 'FLOW');
  
  const iamBridgePath = `${ctx.tenantPath}.${IAM_BRIDGE_SERVICE}`;
  
  // Need to use fetch directly since we need custom auth header
  const fullUrl = `${ctx.orgBaseUrl}/v1/${iamBridgePath}/iam-bridge-api/userinfo`;
  const response = await fetch(fullUrl, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  
  const data = await response.json() as Record<string, any>;
  ctx.saveJson('iam-bridge-userinfo.json', data, step);
  
  console.log('   [OK] User Info:');
  console.log(`        Subject: ${data.sub}`);
  console.log(`        Email: ${data.email || '(not provided)'}`);
  console.log(`        Name: ${data.given_name || ''} ${data.family_name || ''}`);
  
  return data;
}

// ============================================================================
// Main Flow
// ============================================================================

/**
 * Run the IAM Bridge flow.
 * 
 * This demonstrates how the IAM Bridge enables VC-based authentication
 * for traditional IAM systems.
 */
export async function flowIamBridge(ctx: CommandContext): Promise<void> {
  console.log('\n========================================');
  console.log('  Flow: IAM Bridge (OIDC IdP)');
  console.log('========================================\n');
  console.log(`Organization: ${ctx.config.organization}`);
  console.log(`Tenant: ${ctx.config.tenant}`);
  console.log(`Working directory: ${ctx.workdir}`);

  mkdirSync(ctx.workdir, { recursive: true });

  try {
    // Login first
    await setupLogin(ctx);

    // Set wallet key reference if not already set
    if (!ctx.ctx.walletKeyRef) {
      ctx.ctx.walletKeyRef = `${ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;
    }

    // Step 1: Setup IAM Bridge service
    console.log('\n--- Step 1: Setup IAM Bridge Service ---');
    await setupIamBridge(ctx);
    // Note: Verification setup is included in the service creation with defaultClaimMappings
    
    // Step 2: Get discovery and generate Keycloak config
    console.log('\n--- Step 2: Configure Keycloak ---');
    const discovery = await getIamBridgeDiscovery(ctx);
    const realmJson = generateKeycloakRealm(ctx, discovery);
    await startKeycloak(ctx, realmJson);

    // Step 3: Issue a credential to the wallet
    console.log('\n--- Step 3: Issue Credential to Wallet ---');
    await clearWalletCredentials(ctx);
    await runCreateCredentialOffer(ctx, false);
    await runWalletReceiveCredential(ctx);

    // Step 4: Simulate OIDC authorization flow
    console.log('\n--- Step 4: Start OIDC Authorization ---');
    const { bridgeSessionId } = await simulateOidcAuthorize(ctx);

    // Step 5: Wallet presents credential
    console.log('\n--- Step 5: Present Credential ---');
    await runWalletPresent(ctx);

    // Step 6: Poll for session completion
    console.log('\n--- Step 6: Poll Session Status ---');
    const sessionStatus = await pollSessionStatus(ctx, bridgeSessionId);

    // Step 7: Exchange code for tokens
    console.log('\n--- Step 7: Exchange Tokens ---');
    const tokens = await exchangeToken(ctx, sessionStatus.redirectUrl);

    // Step 8: Get user info
    console.log('\n--- Step 8: Get User Info ---');
    await getUserInfo(ctx, tokens.access_token);

    console.log('\n========================================');
    console.log('  SUCCESS - IAM Bridge Flow Complete');
    console.log('========================================\n');
    console.log('The IAM Bridge successfully:');
    console.log('1. Received OIDC authorization request from Keycloak');
    console.log('2. Triggered VC presentation request');
    console.log('3. Verified the presented credential');
    console.log('4. Issued OIDC tokens with claims from the credential');
    console.log('\nKeycloak is running at: http://keycloak.localhost:8080');
    console.log('Login page: http://keycloak.localhost:8080/realms/waltid-vc/account');
    console.log('Admin console: http://keycloak.localhost:8080/admin (admin/admin)');
  } finally {
    ctx.saveHttpLog();
    console.log(`\nLogs saved to: ${ctx.workdir}`);
  }
}

/** Stop Keycloak container */
export async function stopKeycloak(): Promise<void> {
  console.log('\n[CLEANUP] Stopping Keycloak...');
  try {
    execSync('docker rm -f waltid-keycloak-iam-bridge 2>/dev/null || true', { encoding: 'utf-8' });
    console.log('   [OK] Keycloak stopped');
  } catch (_) {
    console.log('   [SKIP] Keycloak was not running');
  }
}
