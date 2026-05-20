/**
 * Tenant and basic service setup commands.
 * 
 * Handles creation of:
 * - Tenant
 * - Wallet service
 * - Verifier2 service
 * - KMS, X509 services
 */

import { CommandContext } from '../../context.js';
import { RESOURCES, defaultWalletKeyReference, defaultWalletDidReference } from '../../config.js';

/** Create tenant */
export async function setupCreateTenant(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log(`Create tenant: ${ctx.config.tenant}`, 'SETUP');
  
  const { created } = await ctx.tolerantCreate(
    `Tenant ${ctx.config.tenant}`,
    async () => {
      const request = { name: `Tenant ${ctx.config.tenant}` };
      ctx.saveJson('create-tenant-request.json', request, step);
      
      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}/resource-api/tenants/create`,
        request
      );
      ctx.saveJson('create-tenant-response.json', response.data, step);
      return response;
    }
  );
  
  if (created) {
    console.log(`   [OK] Tenant created: ${ctx.config.tenant}`);
  }
}

/** Initialize wallet service */
export async function setupCreateWallet(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Initialize wallet', 'SETUP');
  
  const { created } = await ctx.tolerantCreate(
    'Wallet',
    async () => {
      const request = {
        createKeyInKms: {
          keyType: 'secp256r1',
        },
        createDidWithDidService: 'jwk',
        kmsName: RESOURCES.walletKms,
        didStoreName: RESOURCES.walletDidStore,
        didServiceName: RESOURCES.walletDidService,
        credentialStoreName: RESOURCES.walletCredentialStore,
      };
      ctx.saveJson('init-wallet-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}/wallet-service-api/init-wallet`,
        request
      );
      ctx.saveJson('init-wallet-response.json', response.data, step);
      return response;
    }
  );

  // Set wallet key reference
  ctx.ctx.walletKeyRef = defaultWalletKeyReference(ctx.tenantPath);
  ctx.ctx.walletDid = defaultWalletDidReference(ctx.tenantPath);

  if (created) {
    console.log(`   [OK] Wallet initialized`);
  }
}

/** Create verifier2 service */
export async function setupCreateVerifier2(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create verifier2 service', 'SETUP');
  
  const { created } = await ctx.tolerantCreate(
    'Verifier2 service',
    async () => {
      const request = {
        type: 'verifier2',
        baseUrl: ctx.orgBaseUrl,
        clientId: 'verifier2-client',
      };
      ctx.saveJson('create-verifier2-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.verifier2}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-verifier2-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Verifier2 created`);
  }
}

/** Create KMS, X509 Service, X509 Store */
export async function setupCreateServices(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create KMS, X509 Service, X509 Store', 'SETUP');

  const services = [
    { name: RESOURCES.kms, type: 'kms' },
    { name: RESOURCES.x509Service, type: 'x509-service' },
    { name: RESOURCES.x509Store, type: 'x509-store' },
  ];

  for (const svc of services) {
    const { created } = await ctx.tolerantCreate(
      `${svc.name} service`,
      async () => {
        const request = { type: svc.type };
        const response = await ctx.orgClient.post(
          `/v1/${ctx.tenantPath}.${svc.name}/resource-api/services/create`,
          request
        );
        return response;
      }
    );
    
    if (created) {
      console.log(`   [OK] ${svc.name} created`);
    }
  }
}

/** Link X509 service dependencies */
export async function setupLinkX509Dependencies(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Link X509 dependencies', 'SETUP');

  // Link KMS to x509-service
  try {
    await ctx.orgClient.post(
      `/v1/${ctx.tenantPath}.${RESOURCES.x509Service}/x509-service-api/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.kms}`,
      'text/plain'
    );
    console.log(`   [OK] Linked KMS to x509-service`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] KMS already linked`);
    } else {
      throw error;
    }
  }

  // Link x509-store to x509-service
  try {
    await ctx.orgClient.post(
      `/v1/${ctx.tenantPath}.${RESOURCES.x509Service}/x509-service-api/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.x509Store}`,
      'text/plain'
    );
    console.log(`   [OK] Linked x509-store to x509-service`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] x509-store already linked`);
    } else {
      throw error;
    }
  }
}
