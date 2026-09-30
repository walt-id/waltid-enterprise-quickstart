/**
 * EUDI Demo setup: WRP Registry authentication and RP certificate registration.
 *
 * This command:
 * 1. Authenticates with the WRP Registry using PID/OID4VP (displays QR code)
 * 2. Creates all required entities in the registry (law, legal person, etc.)
 * 3. Obtains a WRPAC (PKCS#12) and WRPRC (JWT + COSE)
 * 4. Sets up a verifier2 instance configured with the certificate
 *
 * Configuration is loaded from cli/eudi-demo.env (see eudi-demo.env.example).
 */

import qrcode from 'qrcode-terminal';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CommandContext } from '../../context.js';
import {
  EudiDemoConfig,
  WrpAuthState,
  WrpEntityIds,
  buildEudiVerifierClientMetadata,
} from '../../eudi-demo-config.js';
import {
  decodeFlexibleBase64,
  extractCreatedId,
  extractCreatedIds,
  isAuthorizationPendingError,
  isoDateOnly,
  shouldRegisterProvidedAttestations,
  buildLiveRegistrarCredentialCreateItem,
} from '../../eudi-wrp.js';
import { setupLogin } from './auth.js';

// ============================================================================
// WRP Registry API Client
// ============================================================================

interface WrpApiClient {
  baseUrl: string;
  hashPid?: string;
}

interface WrpHttpLogEntry {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    data: unknown;
  };
  timestamp: string;
}

/** HTTP log for WRP Registry requests */
const wrpHttpLog: WrpHttpLogEntry[] = [];

/** Get the WRP HTTP log */
export function getWrpHttpLog(): WrpHttpLogEntry[] {
  return wrpHttpLog;
}

function redactSecrets(body: unknown): unknown {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const clone = { ...(body as Record<string, unknown>) };
  if ('password' in clone) {
    clone.password = '[REDACTED]';
  }
  return clone;
}

/** Clear the WRP HTTP log */
export function clearWrpHttpLog(): void {
  wrpHttpLog.length = 0;
}

async function wrpRequest<T>(
  ctx: CommandContext,
  client: WrpApiClient,
  method: string,
  path: string,
  body?: unknown,
  logName?: string
): Promise<T> {
  const url = `${client.baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const options: RequestInit = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const step = ctx.nextStep();
  const baseName = logName || path.replace(/^\//, '').replace(/[/?]/g, '-');

  // Log request
  const requestLog = {
    method,
    url,
    headers,
    body: redactSecrets(body),
  };
  ctx.saveJson(`wrp-${baseName}-request.json`, requestLog, step);

  const response = await fetch(url, options);
  
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  let data: T;
  let rawData: unknown;
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    rawData = await response.json();
    data = rawData as T;
  } else {
    rawData = await response.text();
    data = rawData as unknown as T;
  }

  // Log response
  const responseLog = {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    data: rawData,
  };
  ctx.saveJson(`wrp-${baseName}-response.json`, responseLog, step);

  // Add to HTTP log
  wrpHttpLog.push({
    request: requestLog,
    response: responseLog,
    timestamp: new Date().toISOString(),
  });

  if (!response.ok) {
    throw new Error(`WRP API error ${response.status}: ${JSON.stringify(rawData)}`);
  }

  return data;
}

// ============================================================================
// Authentication Flow
// ============================================================================

/** Start PID/OID4VP authentication and display QR code */
async function startAuthentication(
  ctx: CommandContext,
  client: WrpApiClient
): Promise<WrpAuthState> {
  ctx.log('Starting WRP Registry authentication', 'EUDI-DEMO');
  console.log('   Requesting authentication QR code...');

  const authResponse = await wrpRequest<{
    QR_code_url?: string;
    qr_code?: string;
    qrCode?: string;
    presentation_id?: string;
    presentationId?: string;
  }>(ctx, client, 'GET', '/authentication', undefined, 'authentication');

  // Handle different response field names
  const qrCodeData = authResponse.QR_code_url || authResponse.qr_code || authResponse.qrCode || '';
  const presentationId = authResponse.presentation_id || authResponse.presentationId || '';

  if (!qrCodeData) {
    throw new Error('No QR code data received from authentication endpoint');
  }

  ctx.saveJson('wrp-auth-qr-data.json', { qrCodeData, presentationId });

  console.log('\n   ┌─────────────────────────────────────────────────────────┐');
  console.log('   │  Scan this QR code with your EUDI Wallet to authenticate │');
  console.log('   └─────────────────────────────────────────────────────────┘\n');

  qrcode.generate(qrCodeData, { small: true }, (qr: string) => {
    console.log(qr);
  });

  console.log(`\n   Presentation ID: ${presentationId}`);
  console.log(`   QR Code URL: ${qrCodeData}\n`);

  return { presentationId, qrCodeData };
}

/** Poll for PID authorization completion */
async function waitForAuthorization(
  ctx: CommandContext,
  client: WrpApiClient,
  authState: WrpAuthState,
  maxAttempts: number = 60,
  intervalMs: number = 3000
): Promise<string> {
  ctx.log('Waiting for wallet authentication...', 'EUDI-DEMO');
  console.log('   Please scan the QR code with your EUDI Wallet');
  console.log(`   Polling every ${intervalMs / 1000}s (max ${maxAttempts} attempts)\n`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    process.stdout.write(`   Attempt ${attempt}/${maxAttempts}...`);

    try {
      const response = await wrpRequest<{
        authorized?: boolean;
        completed?: boolean;
        status?: string;
        message?: { message?: string } | string;
      }>(ctx, client, 'GET', `/pid_authorization?presentation_id=${authState.presentationId}`, undefined, `pid-authorization-poll-${attempt}`);

      // Check various success indicators from the API
      const messageText = typeof response.message === 'string' 
        ? response.message 
        : response.message?.message || '';
      const isSuccess = response.authorized || 
                       response.completed || 
                       response.status === 'completed' ||
                       messageText.toLowerCase().includes('sucess') ||
                       messageText.toLowerCase().includes('success');

      if (isSuccess) {
        console.log(' Authorized!');
        
        // API spec: /getpidoid4vp uses query parameter and returns plain string
        const hashPid = await wrpRequest<string>(
          ctx, client, 'GET', `/getpidoid4vp?presentation_id=${authState.presentationId}`, 
          undefined, 'getpidoid4vp'
        );

        if (!hashPid || typeof hashPid !== 'string') {
          throw new Error('No hash_pid received after authorization');
        }

        ctx.saveJson('wrp-auth-hash-pid.json', { hashPid });
        console.log(`   [OK] Authentication successful`);
        console.log(`   hash_pid: ${hashPid}`);
        return hashPid;
      }

      console.log(' pending');
    } catch (error: unknown) {
      if (isAuthorizationPendingError(error)) {
        console.log(' pending');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.log(` error: ${message}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error('Authentication timeout - wallet did not complete authorization');
}

// ============================================================================
// Entity Creation Functions
// ============================================================================

/** WRP create response envelope (ids live under data, often in a labeled map). */
interface WrpCreateResponse {
  code?: number;
  status?: string;
  message?: string;
  data?: number[] | Record<string, number[]>;
}

async function createLaw(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string
): Promise<number> {
  ctx.log('Creating law entry', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    law: [{
      legalBasis: config.law.legalBasis,
      legislativeIdentifier: config.law.legislativeIdentifier,
    }],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/law/create', request, 'create-law'
  );

  const id = extractCreatedId(response, 'law');
  console.log(`   [OK] Law created: ${id}`);
  return id;
}

async function createLegalPerson(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string,
  lawId: number
): Promise<number> {
  ctx.log('Creating legal person', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    legalPerson: [{
      law: [lawId],
      legalName: [config.legalEntity.legalName],
    }],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/legal_person/create', request, 'create-legal-person'
  );

  const id = extractCreatedId(response, 'legal person');
  console.log(`   [OK] Legal person created: ${id}`);
  return id;
}

async function createIdentifier(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string
): Promise<number> {
  ctx.log('Creating identifier', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    identifier: [{
      identifier: config.legalEntity.identifier,
      type: config.legalEntity.identifierType,
    }],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/identifier/create', request, 'create-identifier'
  );

  const id = extractCreatedId(response, 'identifier');
  console.log(`   [OK] Identifier created: ${id}`);
  return id;
}

async function createLegalEntity(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string,
  legalPersonId: number,
  identifierId: number
): Promise<number> {
  ctx.log('Creating legal entity', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    legal_entity: [{
      country: config.legalEntity.country,
      email: [config.legalEntity.email],
      identifiers: [identifierId],
      infoURI: [config.legalEntity.infoUri],
      legal_person_id: legalPersonId,
      phone: [config.legalEntity.phone],
      postalAddress: [config.legalEntity.postalAddress],
    }],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/legal_entity/create', request, 'create-legal-entity'
  );

  const id = extractCreatedId(response, 'legal entity');
  console.log(`   [OK] Legal entity created: ${id}`);
  return id;
}

async function createPolicies(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string
): Promise<{ wrpPolicyId: number; intendedUsePolicyId: number }> {
  ctx.log('Creating WRP and intended-use policies', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    policy: [
      {
        intention: 'wrp',
        policyURI: config.provider.policyUri,
        type: config.provider.policyType,
      },
      {
        intention: 'intended_use',
        policyURI: config.intendedUse.privacyPolicyUri,
        type: config.intendedUse.policyType,
      },
    ],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/policy/create', request, 'create-policy'
  );

  const ids = extractCreatedIds(response);
  const wrpPolicyId = ids[0];
  const intendedUsePolicyId = ids[1];
  if (wrpPolicyId === undefined || intendedUsePolicyId === undefined) {
    throw new Error(`Expected two policy IDs, received: ${JSON.stringify(response)}`);
  }
  console.log(`   [OK] Policies created: WRP ${wrpPolicyId}, intended use ${intendedUsePolicyId}`);
  return { wrpPolicyId, intendedUsePolicyId };
}

async function createProvider(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string,
  legalEntityId: number,
  policyId: number
): Promise<number> {
  ctx.log('Creating provider', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    provider: [{
      legalEntityId,
      policy_id: [policyId],
      providerType: config.provider.type,
    }],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/provider/create', request, 'create-provider'
  );

  const id = extractCreatedId(response, 'provider');
  console.log(`   [OK] Provider created: ${id}`);
  return id;
}

async function createCredential(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string
): Promise<number> {
  ctx.log('Creating credential definition', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    credentials: [
      buildLiveRegistrarCredentialCreateItem(
        config.credential.format,
        config.credential.claims,
        config.credential.meta
      ),
    ],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/credential/create', request, 'create-credential'
  );

  const id = extractCreatedId(response, 'credential');
  console.log(`   [OK] Credential created: ${id}`);
  return id;
}

async function createIntendedUse(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string,
  credentialId: number,
  policyId: number
): Promise<number> {
  ctx.log('Creating intended use', 'EUDI-DEMO');

  const now = new Date();
  const nextYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const request = {
    hash_pid: hashPid,
    intended_uses: [{
      createdAt: isoDateOnly(now),
      credential_ids: [credentialId],
      intendedUseIdentifier: config.intendedUse.identifier,
      privacyPolicy_id: [policyId],
      purpose: [{
        content: config.intendedUse.purpose,
        lang: 'en',
      }],
      revokedAt: isoDateOnly(nextYear),
    }],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/intended_use/create', request, 'create-intended-use'
  );

  const id = extractCreatedId(response, 'intended use');
  console.log(`   [OK] Intended use created: ${id}`);
  return id;
}

async function createProvidedAttestation(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string
): Promise<number> {
  ctx.log('Creating provided attestation', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    providesAttestations: [{
      format: config.credential.format,
      meta: config.credential.meta,
    }],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/provided_attestation/create', request, 'create-provided-attestation'
  );

  const id = extractCreatedId(response, 'provided attestation');
  console.log(`   [OK] Provided attestation created: ${id}`);
  return id;
}

async function createSupervisoryAuthority(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string
): Promise<number> {
  ctx.log('Creating supervisory authority', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    supervisoryAuthority: [{
      country: config.supervisoryAuthority.country,
      email: [config.supervisoryAuthority.email],
      formURI: [config.supervisoryAuthority.formUri],
      name: config.supervisoryAuthority.name,
      phone: [config.supervisoryAuthority.phone],
    }],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/supervisory_authority/create', request, 'create-supervisory-authority'
  );

  const id = extractCreatedId(response, 'supervisory authority');
  console.log(`   [OK] Supervisory authority created: ${id}`);
  return id;
}

async function createWalletRp(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string,
  providerId: number,
  intendedUseId: number,
  providedAttestationIds: number[],
  supervisoryAuthorityId: number
): Promise<number> {
  ctx.log('Creating Wallet Relying Party', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    WalletRelyingParty: [{
      entitlements: config.walletRp.entitlements,
      intendedUse_ids: [intendedUseId],
      isPSB: config.walletRp.isPsb,
      provider_id: providerId,
      providesAttestations_id: providedAttestationIds,
      registryURI: config.walletRp.registryUri,
      srvDescription: [{
        content: config.walletRp.description,
        lang: 'en',
      }],
      supervisoryAuthority: supervisoryAuthorityId,
      supportURI: [config.walletRp.supportUri],
      tradeName: config.walletRp.tradeName,
      usesIntermediary: [],
    }],
  };

  const response = await wrpRequest<WrpCreateResponse>(
    ctx, client, 'POST', '/wallet_rp/create', request, 'create-wallet-rp'
  );

  const id = extractCreatedId(response, 'wallet RP');
  console.log(`   [OK] Wallet Relying Party created: ${id}`);
  return id;
}

// ============================================================================
// Certificate Generation
// ============================================================================

/** WRP certificate response format */
interface WrpCertificateResponse {
  code?: number;
  status?: string;
  data?: {
    file_base64?: string;
    cose_base64?: string;
    filename?: string;
  };
}

async function generateWrpac(
  ctx: CommandContext,
  client: WrpApiClient,
  config: EudiDemoConfig,
  hashPid: string,
  wrpId: number
): Promise<Buffer> {
  ctx.log('Generating WRPAC (PKCS#12 access certificate)', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    password: config.certificatePassword,
    wrp_id: wrpId,
  };

  const response = await wrpRequest<WrpCertificateResponse>(
    ctx, client, 'POST', '/wallet_rp/certificate',
    request, 'generate-wrpac'
  );

  const base64Cert = response.data?.file_base64;
  if (!base64Cert) {
    throw new Error('No certificate data (file_base64) returned from API');
  }

  const certBuffer = Buffer.from(base64Cert, 'base64');
  console.log(`   [OK] WRPAC generated (${certBuffer.length} bytes)`);
  return certBuffer;
}

async function generateWrprc(
  ctx: CommandContext,
  client: WrpApiClient,
  hashPid: string,
  intendedUseId: number
): Promise<{ jwt: Buffer; cose: Buffer }> {
  ctx.log('Generating WRPRC (registration certificate)', 'EUDI-DEMO');

  const request = {
    hash_pid: hashPid,
    intended_use_id: intendedUseId,
  };

  const response = await wrpRequest<WrpCertificateResponse>(
    ctx, client, 'POST', '/intended_use/certificate',
    request, 'generate-wrprc'
  );

  const jwtBase64 = response.data?.file_base64;
  const coseBase64 = response.data?.cose_base64;
  if (!jwtBase64 || !coseBase64) {
    throw new Error('No WRPRC data (file_base64 / cose_base64) returned from API');
  }

  const jwt = decodeFlexibleBase64(jwtBase64);
  const cose = decodeFlexibleBase64(coseBase64);
  console.log(`   [OK] WRPRC generated (jwt ${jwt.length} bytes, cose ${cose.length} bytes)`);
  return { jwt, cose };
}

// ============================================================================
// Verifier2 Setup
// ============================================================================

async function createEudiVerifier(
  ctx: CommandContext,
  config: EudiDemoConfig,
  certPaths: { wrpac: string; wrprcJwt: string; wrprcCose: string }
): Promise<void> {
  ctx.log('Creating EUDI demo verifier2 service', 'EUDI-DEMO');

  const verifierPath = `${ctx.config.organization}.${config.tenantId}.${config.verifierName}`;

  const { created: tenantCreated } = await ctx.tolerantCreate(
    `Tenant ${config.tenantId}`,
    async () => {
      const request = { name: 'EUDI Demo Tenant' };
      return ctx.orgClient.post(
        `/v1/${ctx.config.organization}.${config.tenantId}/resource-api/tenants/create`,
        request
      );
    }
  );
  if (tenantCreated) {
    console.log(`   [OK] Tenant created: ${ctx.config.organization}.${config.tenantId}`);
  }

  const { created: verifierCreated } = await ctx.tolerantCreate(
    `Verifier ${config.verifierName}`,
    async () => {
      const request = {
        type: 'verifier2',
        baseUrl: config.serviceBaseUrl,
        clientMetadata: buildEudiVerifierClientMetadata(config),
      };
      ctx.saveJson('create-eudi-verifier-request.json', request);

      const response = await ctx.orgClient.post(
        `/v1/${verifierPath}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-eudi-verifier-response.json', response.data);
      return response;
    }
  );

  if (verifierCreated) {
    console.log(`   [OK] Verifier created: ${verifierPath}`);
  }

  console.log(`\n   WRPAC saved to: ${certPaths.wrpac}`);
  console.log(`   WRPRC (JWT) saved to: ${certPaths.wrprcJwt}`);
  console.log(`   WRPRC (COSE) saved to: ${certPaths.wrprcCose}`);
  console.log(`   Certificate password: ${config.certificatePassword}`);
  console.log(`\n   To configure the verifier with the certificate, import it into your KMS`);
  console.log(`   and update the verifier configuration to use the certificate for client authentication.`);
}

// ============================================================================
// Main Setup Function
// ============================================================================

/**
 * Run EUDI demo setup: WRP Registry authentication and verifier configuration.
 */
export async function runEudiDemoSetup(
  ctx: CommandContext,
  config: EudiDemoConfig
): Promise<void> {
  console.log('\n=== EUDI Demo Setup ===\n');
  console.log(`WRP Registry: ${config.registryBaseUrl}`);
  console.log(`Tenant: ${config.tenantId}`);
  console.log(`Verifier: ${config.verifierName}`);
  console.log(`Service Base URL: ${config.serviceBaseUrl}`);
  console.log(`Legal Entity: ${config.legalEntity.legalName} (${config.legalEntity.country})\n`);

  // Clear any previous WRP HTTP log
  clearWrpHttpLog();

  const client: WrpApiClient = { baseUrl: config.registryBaseUrl };
  const entityIds: WrpEntityIds = {};

  await setupLogin(ctx);

  // Step 1: Authenticate with WRP Registry
  console.log('\n--- Step 1: WRP Registry Authentication ---\n');
  const authState = await startAuthentication(ctx, client);
  const hashPid = await waitForAuthorization(ctx, client, authState);
  client.hashPid = hashPid;

  // Step 2: Create all required entities
  console.log('\n--- Step 2: Create Registry Entities ---\n');

  entityIds.lawId = await createLaw(ctx, client, config, hashPid);
  entityIds.legalPersonId = await createLegalPerson(ctx, client, config, hashPid, entityIds.lawId);
  entityIds.identifierId = await createIdentifier(ctx, client, config, hashPid);
  entityIds.legalEntityId = await createLegalEntity(
    ctx, client, config, hashPid,
    entityIds.legalPersonId, entityIds.identifierId
  );

  const policies = await createPolicies(ctx, client, config, hashPid);
  entityIds.policyWrpId = policies.wrpPolicyId;
  entityIds.policyIntendedUseId = policies.intendedUsePolicyId;
  entityIds.providerId = await createProvider(
    ctx, client, config, hashPid,
    entityIds.legalEntityId, entityIds.policyWrpId
  );

  entityIds.credentialId = await createCredential(ctx, client, config, hashPid);
  entityIds.intendedUseId = await createIntendedUse(
    ctx, client, config, hashPid,
    entityIds.credentialId, entityIds.policyIntendedUseId
  );

  const providedAttestationIds: number[] = [];
  if (shouldRegisterProvidedAttestations(config.walletRp.entitlements)) {
    entityIds.providedAttestationId = await createProvidedAttestation(ctx, client, config, hashPid);
    providedAttestationIds.push(entityIds.providedAttestationId);
  } else {
    console.log('   [SKIP] Provided attestation (no issuer entitlement on this RP)');
  }
  entityIds.supervisoryAuthorityId = await createSupervisoryAuthority(ctx, client, config, hashPid);

  entityIds.walletRpId = await createWalletRp(
    ctx, client, config, hashPid,
    entityIds.providerId, entityIds.intendedUseId,
    providedAttestationIds, entityIds.supervisoryAuthorityId
  );

  // Save entity IDs summary
  ctx.saveJson('wrp-entity-ids-summary.json', entityIds);

  // Step 3: Generate WRPAC then WRPRC
  console.log('\n--- Step 3: Generate RP Certificates ---\n');
  const wrpacBuffer = await generateWrpac(ctx, client, config, hashPid, entityIds.walletRpId);
  const wrprc = await generateWrprc(ctx, client, hashPid, entityIds.intendedUseId);

  const certDir = join(ctx.cliDir, 'certs');
  mkdirSync(certDir, { recursive: true });
  const certPaths = {
    wrpac: join(certDir, 'eudi-rp-certificate.p12'),
    wrprcJwt: join(certDir, 'eudi-wrprc.jwt'),
    wrprcCose: join(certDir, 'eudi-wrprc.cose'),
  };
  writeFileSync(certPaths.wrpac, wrpacBuffer);
  writeFileSync(certPaths.wrprcJwt, wrprc.jwt);
  writeFileSync(certPaths.wrprcCose, wrprc.cose);

  // Step 4: Create verifier2 service
  console.log('\n--- Step 4: Create Verifier Service ---\n');
  await createEudiVerifier(ctx, config, certPaths);

  // Save WRP HTTP log
  const wrpLog = getWrpHttpLog();
  if (wrpLog.length > 0) {
    writeFileSync(
      join(ctx.workdir, 'wrp-http-log.json'),
      JSON.stringify(wrpLog, null, 2)
    );
  }

  console.log('\n[EUDI-DEMO] Setup completed successfully');
  console.log('\nCreated entities:');
  console.log(`  Law ID: ${entityIds.lawId}`);
  console.log(`  Legal Person ID: ${entityIds.legalPersonId}`);
  console.log(`  Identifier ID: ${entityIds.identifierId}`);
  console.log(`  Legal Entity ID: ${entityIds.legalEntityId}`);
  console.log(`  Provider ID: ${entityIds.providerId}`);
  console.log(`  Wallet RP ID: ${entityIds.walletRpId}`);
  console.log(`\nCertificates:`);
  console.log(`  WRPAC: ${certPaths.wrpac}`);
  console.log(`  WRPRC (JWT): ${certPaths.wrprcJwt}`);
  console.log(`  WRPRC (COSE): ${certPaths.wrprcCose}`);
  console.log(`Verifier: ${ctx.config.organization}.${config.tenantId}.${config.verifierName}`);
  console.log(`\nLogs saved to: ${ctx.workdir}`);
}
