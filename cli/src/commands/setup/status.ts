/**
 * Credential status setup commands.
 * 
 * Handles:
 * - Credential status service creation
 * - TokenStatusList CWT configuration
 * - Linking issuer to credential status
 */

import { CommandContext } from '../../context.js';
import { RESOURCES, KEY_IDS, CERT_IDS, STATUS_CONFIG_IDS } from '../../config.js';

/**
 * Where status lists are published. S3 when CREDENTIAL_STATUS_S3_BUCKET is set, otherwise the
 * enterprise database. Every API pod serves that list from /fetch, including after a restart.
 * In-memory remains available for tests; it is not shared across pods.
 */
export function credentialStatusRegistry(): Record<string, unknown> {
  const bucketName = process.env.CREDENTIAL_STATUS_S3_BUCKET;
  if (!bucketName) {
    return { type: 'database' };
  }
  const region = process.env.CREDENTIAL_STATUS_S3_REGION;
  if (!region) {
    throw new Error('CREDENTIAL_STATUS_S3_REGION is required when CREDENTIAL_STATUS_S3_BUCKET is set');
  }
  return {
    type: 'aws',
    bucketName,
    region,
    // Without keys the API falls back to the AWS SDK's default credential chain.
    ...(process.env.CREDENTIAL_STATUS_S3_ACCESS_KEY_ID && {
      accessKeyId: process.env.CREDENTIAL_STATUS_S3_ACCESS_KEY_ID,
      secretKey: process.env.CREDENTIAL_STATUS_S3_SECRET_KEY,
    }),
  };
}

/** Copy of a request or response with the S3 secret key masked, for the saved JSON logs */
function redactRegistrySecret(data: any): any {
  return JSON.parse(JSON.stringify(data, (key, value) => (key === 'secretKey' && value ? '[redacted]' : value)));
}

/** Create credential status service */
export async function setupCreateCredentialStatusService(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  const registry = credentialStatusRegistry();
  ctx.log(`Create credential status service (${registry.type} registry)`, 'SETUP');

  const { created } = await ctx.tolerantCreate(
    'Credential status service',
    async () => {
      const request = {
        type: 'credential-status',
        config: { registry },
      };
      ctx.saveJson('create-credential-status-service-request.json', redactRegistrySecret(request), step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.credentialStatus}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-credential-status-service-response.json', redactRegistrySecret(response.data), step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Credential status service created`);
  }

  // Link KMS dependency
  try {
    await ctx.addServiceDependency(
      `/v1/${ctx.tenantPath}.${RESOURCES.credentialStatus}/credential-status-service-api/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.kms}`
    );
    console.log(`   [OK] Linked KMS to credential status service`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] KMS already linked to credential status service`);
    } else {
      throw error;
    }
  }
}

/** Seconds a relying party may cache the revocation journey's own status list. */
export const STATUS_LIST_TEST_TTL_SECONDS = 2;

/** Separate from the issued quickstart list, so the journey never rewrites that list's TTL. */
export const REVOCATION_JOURNEY_STATUS_CONFIG_ID = 'token-status-list-cwt-revocation';

export function revocationJourneyCreatePath(target: string): string {
  return `/v1/${target}/credential-status-service-api/status-credential/create`;
}

export function revocationJourneyStatusRequest(ctx: CommandContext): Record<string, unknown> {
  return {
    kid: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
    x5Chain: [ctx.ctx.docSignerPem],
    config: {
      type: 'TokenStatusList',
      format: 'CWT',
      ttl: STATUS_LIST_TEST_TTL_SECONDS,
    },
  };
}

/** Creates the journey list. An existing list is left untouched, including when create reports a conflict. */
export async function createRevocationJourneyStatusList(
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>,
  target: string,
  request: Record<string, unknown>,
): Promise<'created' | 'exists'> {
  try {
    await post(revocationJourneyCreatePath(target), request);
    return 'created';
  } catch (error) {
    if (httpStatus(error) === 409 || alreadyExists(error)) return 'exists';
    throw error;
  }
}

async function loadDocumentSignerPem(ctx: CommandContext): Promise<void> {
  if (ctx.ctx.docSignerPem) return;
  try {
    const certResponse = await ctx.orgClient.get(
      `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
    );
    ctx.ctx.docSignerPem = certResponse.data.data?.pem || certResponse.data.certificatePem || certResponse.data.pem;
    console.log(`   [INFO] Retrieved document signer certificate from x509-store`);
  } catch {
    throw new Error('Document signer certificate not found. Run setup-create-document-signer-certificate first.');
  }
}

function httpStatus(error: unknown): number | undefined {
  const candidate = error as { status?: number; response?: { status?: number } };
  return candidate.status ?? candidate.response?.status;
}

function alreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  const responseMessage = (error as { response?: { data?: { message?: string } } }).response?.data?.message ?? '';
  return message.includes('already exists') || responseMessage.includes('already exists');
}

/** Create the journey's own short-TTL list. A read failure is not used, and an existing list is not deleted. */
export async function ensureRevocationJourneyStatusList(ctx: CommandContext): Promise<void> {
  await loadDocumentSignerPem(ctx);
  const target = statusConfigRef(ctx, REVOCATION_JOURNEY_STATUS_CONFIG_ID);
  const outcome = await createRevocationJourneyStatusList(
    (path, body) => ctx.orgClient.post(path, body),
    target,
    revocationJourneyStatusRequest(ctx),
  );
  if (outcome === 'exists') {
    console.log('   [SKIP] Revocation journey status list already exists');
    return;
  }
  console.log(`   [OK] Revocation journey status list uses a ${STATUS_LIST_TEST_TTL_SECONDS}s TTL`);
}

/** Create TokenStatusList CWT configuration */
export async function setupCreateStatusConfiguration(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create TokenStatusList CWT configuration', 'SETUP');
  await loadDocumentSignerPem(ctx);

  const { created } = await ctx.tolerantCreate('Status configuration', async () => {
    const request = {
      kid: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
      x5Chain: [ctx.ctx.docSignerPem],
      config: {
        type: 'TokenStatusList',
        format: 'CWT',
      },
    };
    ctx.saveJson('create-status-configuration-request.json', request, step);
    const response = await ctx.orgClient.post(
      `/v1/${ctx.tenantPath}.${RESOURCES.credentialStatus}.${STATUS_CONFIG_IDS.tokenStatusListCwt}/credential-status-service-api/status-credential/create`,
      request
    );
    ctx.saveJson('create-status-configuration-response.json', response.data, step);
    return response;
  });

  if (created) {
    console.log('   [OK] TokenStatusList CWT configuration created');
  }
}

/** Target of a status list configuration in the tenant's credential status service */
export function statusConfigRef(ctx: CommandContext, configId: string): string {
  return `${ctx.tenantPath}.${RESOURCES.credentialStatus}.${configId}`;
}

/** Link the credential status service to the issuer service [service]. Already linked is not an error. */
export async function linkIssuerToCredentialStatus(ctx: CommandContext, service: string): Promise<void> {
  try {
    await ctx.addServiceDependency(
      `/v2/${ctx.tenantPath}.${service}/issuer-service-api/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.credentialStatus}`
    );
    console.log(`   [OK] Credential status service linked to ${service}`);
  } catch (error: any) {
    if (error.status !== 409 && !error.message?.includes('already')) throw error;
    console.log(`   [SKIP] Credential status service already linked to ${service}`);
  }
}

/** Link credential status service to issuer */
export async function setupLinkIssuerToCredentialStatus(ctx: CommandContext): Promise<void> {
  ctx.nextStep();
  ctx.log('Link credential status service to issuer', 'SETUP');
  await linkIssuerToCredentialStatus(ctx, RESOURCES.issuer);
}
