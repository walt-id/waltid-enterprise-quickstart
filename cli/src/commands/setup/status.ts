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

/** Create credential status service */
export async function setupCreateCredentialStatusService(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create credential status service', 'SETUP');

  const { created } = await ctx.tolerantCreate(
    'Credential status service',
    async () => {
      const request = {
        type: 'credential-status',
        config: {
          registry: {
            type: 'in-memory',
          },
        },
      };
      ctx.saveJson('create-credential-status-service-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.credentialStatus}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-credential-status-service-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Credential status service created`);
  }

  // Link KMS dependency
  try {
    await ctx.orgClient.post(
      `/v1/${ctx.tenantPath}.${RESOURCES.credentialStatus}/credential-status-service-api/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.kms}`,
      'text/plain'
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

/** Create TokenStatusList CWT configuration */
export async function setupCreateStatusConfiguration(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create TokenStatusList CWT configuration', 'SETUP');

  // Ensure we have the document signer certificate
  if (!ctx.ctx.docSignerPem) {
    try {
      const certResponse = await ctx.orgClient.get(
        `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
      );
      ctx.ctx.docSignerPem = certResponse.data.data?.pem || certResponse.data.certificatePem || certResponse.data.pem;
      console.log(`   [INFO] Retrieved document signer certificate from x509-store`);
    } catch (e) {
      throw new Error('Document signer certificate not found. Run setup-create-document-signer-certificate first.');
    }
  }

  const { created } = await ctx.tolerantCreate(
    'Status configuration',
    async () => {
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
    }
  );

  if (created) {
    console.log(`   [OK] TokenStatusList CWT configuration created`);
  }
}

/** Link credential status service to issuer */
export async function setupLinkIssuerToCredentialStatus(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Link credential status service to issuer', 'SETUP');

  try {
    await ctx.orgClient.post(
      `/v2/${ctx.tenantPath}.${RESOURCES.issuer}/issuer-service-api/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.credentialStatus}`,
      'text/plain'
    );
    console.log(`   [OK] Credential status service linked to issuer`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] Credential status service already linked to issuer`);
    } else {
      throw error;
    }
  }
}
