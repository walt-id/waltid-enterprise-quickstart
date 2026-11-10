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

/** Seconds a relying party may cache the quickstart status list. The revocation journey waits this out. */
export const STATUS_LIST_TEST_TTL_SECONDS = 2;

const DEFAULT_STATUS_LIST_TTL_SECONDS = 43_200;

/** What the revocation journey must do with a status configuration it may be reusing. */
export function statusListAction(existingTtl: number | null): 'create' | 'reuse' | 'recreate' {
  if (existingTtl == null) return 'create';
  return existingTtl === STATUS_LIST_TEST_TTL_SECONDS ? 'reuse' : 'recreate';
}

/** TTL stored on a Token Status List, or the product default when the field was omitted. */
export function findStatusListTtl(body: unknown): number | null {
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = findStatusListTtl(item);
      if (found != null) return found;
    }
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (record.type === 'TokenStatusList') {
    return typeof record.ttl === 'number' ? record.ttl : DEFAULT_STATUS_LIST_TTL_SECONDS;
  }
  for (const value of Object.values(record)) {
    const found = findStatusListTtl(value);
    if (found != null) return found;
  }
  return null;
}

function statusConfigurationRequest(ctx: CommandContext): Record<string, unknown> {
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

async function readExistingStatusListTtl(ctx: CommandContext, target: string): Promise<number | null> {
  try {
    const response = await ctx.orgClient.get(`/v1/${target}`);
    return findStatusListTtl(response.data) ?? DEFAULT_STATUS_LIST_TTL_SECONDS;
  } catch (error) {
    if (httpStatus(error) === 404) return null;
    return DEFAULT_STATUS_LIST_TTL_SECONDS;
  }
}

async function deleteStatusConfiguration(ctx: CommandContext, target: string): Promise<void> {
  try {
    await ctx.orgClient.delete(
      `/v1/${target}/credential-status-service-api/status-credential/delete`
    );
  } catch (error) {
    if (httpStatus(error) !== 404) throw error;
  }
}

async function createStatusConfiguration(ctx: CommandContext, target: string): Promise<void> {
  const step = ctx.nextStep();
  const request = statusConfigurationRequest(ctx);
  ctx.saveJson('create-status-configuration-request.json', request, step);
  const response = await ctx.orgClient.post(
    `/v1/${target}/credential-status-service-api/status-credential/create`,
    request
  );
  ctx.saveJson('create-status-configuration-response.json', response.data, step);
}

/**
 * The revocation journey publishes through this configuration. An existing list keeps its old TTL,
 * so a reused 12-hour list is replaced before a credential is issued against it.
 */
export async function ensureShortTtlStatusConfiguration(ctx: CommandContext): Promise<void> {
  await loadDocumentSignerPem(ctx);
  const target = statusConfigRef(ctx, STATUS_CONFIG_IDS.tokenStatusListCwt);
  const action = statusListAction(await readExistingStatusListTtl(ctx, target));
  if (action === 'reuse') {
    console.log(`   [SKIP] Status configuration already uses a ${STATUS_LIST_TEST_TTL_SECONDS}s TTL`);
    return;
  }
  if (action === 'recreate') {
    console.log('   [INFO] Replacing status configuration so the revocation journey uses a short TTL');
    await deleteStatusConfiguration(ctx, target);
  }
  await createStatusConfiguration(ctx, target);
  console.log(`   [OK] TokenStatusList CWT configuration uses a ${STATUS_LIST_TEST_TTL_SECONDS}s TTL`);
}

/** Create TokenStatusList CWT configuration */
export async function setupCreateStatusConfiguration(ctx: CommandContext): Promise<void> {
  ctx.log('Create TokenStatusList CWT configuration', 'SETUP');
  await ensureShortTtlStatusConfiguration(ctx);
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
