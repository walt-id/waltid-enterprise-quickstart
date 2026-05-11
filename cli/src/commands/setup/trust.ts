/**
 * Trust registry setup commands.
 * 
 * Handles:
 * - Trust registry service creation
 * - Trust list imports
 * - ETSI trust registry setup
 */

import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import { CommandContext } from '../../context.js';
import { RESOURCES, CERT_IDS } from '../../config.js';

/** Create trust registry service */
export async function setupCreateTrustRegistry(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create trust registry service', 'SETUP');

  const { created } = await ctx.tolerantCreate(
    'Trust registry service',
    async () => {
      const request = {
        type: 'trust-registry'
      };
      ctx.saveJson('create-trust-registry-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.trustRegistry}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-trust-registry-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Trust registry created`);
  }
}

/** Import trust list from file */
export async function setupImportTrustList(ctx: CommandContext, filePath: string): Promise<void> {
  const step = ctx.nextStep();
  ctx.log(`Import trust list: ${basename(filePath)}`, 'SETUP');

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const fileName = basename(filePath);
  const sourceId = fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9-_]/g, '-');

  const request = {
    sourceId,
    content,
    validateSignature: false,
  };
  ctx.saveJson('import-trust-list-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources/load`,
    request
  );
  ctx.saveJson('import-trust-list-response.json', response.data, step);

  ctx.ctx.trustRegistrySourceId = sourceId;
  console.log(`   [OK] Trust list imported: ${sourceId}`);
  console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
  console.log(`        Services: ${response.data.servicesLoaded || 0}`);
  console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
}

/** Link Verifier2 to Trust Registry */
export async function linkVerifier2ToTrustRegistry(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Link Verifier2 to Trust Registry (via service dependency)', 'FLOW');

  const trustRegistryTarget = `${ctx.tenantPath}.${RESOURCES.trustRegistry}`;
  const verifier2Target = `${ctx.tenantPath}.${RESOURCES.verifier2}`;

  try {
    await ctx.orgClient.postRaw(
      `/v1/${verifier2Target}/verifier2-service-api/dependencies/add`,
      trustRegistryTarget
    );
    console.log(`   [OK] Trust registry linked to verifier2: ${trustRegistryTarget}`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] Trust registry already linked to verifier2`);
    } else {
      throw error;
    }
  }
}

/** Import public trust lists from URLs */
export async function importPublicTrustLists(ctx: CommandContext): Promise<void> {
  const publicTrustLists = [
    {
      sourceId: 'ewc-pilot',
      url: 'https://ewc-consortium.github.io/ewc-trust-list/EWC-TL',
      description: 'EWC Pilot Trust List (JSON/LoTE format, unauthenticated)',
      validateSignature: false,
    },
    {
      sourceId: 'at-tsl-authenticated', 
      url: 'https://www.signatur.rtr.at/currenttl.xml',
      description: 'Austrian TSL (XML format, XMLDSig VALIDATED)',
      validateSignature: true,
    },
  ];
  
  for (const trustList of publicTrustLists) {
    const step = ctx.nextStep();
    ctx.log(`Import: ${trustList.description}`, 'FLOW');
    
    const request = {
      sourceId: trustList.sourceId,
      url: trustList.url,
      validateSignature: trustList.validateSignature,
    };
    ctx.saveJson(`import-${trustList.sourceId}-request.json`, request, step);
    
    try {
      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources/load`,
        request
      );
      ctx.saveJson(`import-${trustList.sourceId}-response.json`, response.data, step);
      
      if (response.data.success) {
        console.log(`   [OK] ${trustList.sourceId} loaded`);
        console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
        console.log(`        Services: ${response.data.servicesLoaded || 0}`);
        console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
      } else {
        console.log(`   [WARN] ${trustList.sourceId} load failed: ${response.data.error}`);
      }
    } catch (error: any) {
      const errMsg = error.message || error.response?.data?.message || '';
      if (error.status === 409 || 
          errMsg.includes('Duplicate target') || 
          errMsg.includes('already exists') ||
          errMsg.includes('Overwriting targets')) {
        console.log(`   [SKIP] ${trustList.sourceId} already exists`);
      } else {
        console.log(`   [WARN] Failed to import ${trustList.sourceId}: ${errMsg}`);
      }
    }
  }
}

/** Load local IACA certificate into trust registry */
export async function loadIacaIntoTrustRegistry(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Load local IACA certificate into trust registry', 'FLOW');
  
  // First, retrieve the IACA certificate PEM
  let iacaPem = ctx.ctx.iacaPem;
  if (!iacaPem) {
    ctx.log('Retrieving IACA certificate...', 'FLOW');
    try {
      const certResp = await ctx.orgClient.get(
        `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
      );
      iacaPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
      ctx.ctx.iacaPem = iacaPem;
    } catch (error: any) {
      throw new Error(`IACA certificate not found. Run full setup first: ${error.message}`);
    }
  }
  
  if (!iacaPem) {
    throw new Error('IACA certificate PEM is empty');
  }
  
  // Use a fixed sourceId so we can detect duplicates
  const sourceId = 'journey-iaca-local';
  
  // Create a LoTE-format JSON source with the IACA certificate
  const loteSource = {
    listMetadata: {
      listId: sourceId,
      listType: 'mdl-issuers',
      territory: 'US',
      issueDate: new Date().toISOString(),
      nextUpdate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      sequenceNumber: '1',
    },
    trustedEntities: [
      {
        entityId: 'journey-test-iaca',
        entityType: 'PID_PROVIDER',
        legalName: 'Walt CLI Journey Test IACA',
        country: 'US',
        services: [
          {
            serviceId: 'mdl-issuing',
            serviceType: 'MDL_ISSUER',
            status: 'GRANTED',
            statusStart: new Date().toISOString(),
            identities: [
              {
                matchType: 'CERTIFICATE_PEM',
                value: iacaPem,
              },
            ],
          },
        ],
      },
    ],
  };
  
  ctx.saveJson('journey-iaca-lote-source.json', loteSource, step);
  
  const request = {
    sourceId: sourceId,
    content: JSON.stringify(loteSource),
    sourceUrl: 'local://journey-test',
    validateSignature: false,
  };
  ctx.saveJson('load-journey-iaca-request.json', request, step);
  
  try {
    const response = await ctx.orgClient.post(
      `/v1/${ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources/load`,
      request
    );
    ctx.saveJson('load-journey-iaca-response.json', response.data, step);
    
    if (!response.data.success) {
      throw new Error(`Failed to load IACA trust source: ${response.data.error}`);
    }
    
    ctx.ctx.trustRegistrySourceId = sourceId;
    console.log(`   [OK] Journey IACA trust source loaded: ${sourceId}`);
    console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
    console.log(`        Services: ${response.data.servicesLoaded || 0}`);
    console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
  } catch (error: any) {
    // Check for duplicate/already exists errors
    const errMsg = error.message || error.response?.data?.message || '';
    if (error.status === 409 || 
        errMsg.includes('Duplicate target') || 
        errMsg.includes('already exists') ||
        errMsg.includes('Overwriting targets')) {
      ctx.ctx.trustRegistrySourceId = sourceId;
      console.log(`   [SKIP] Journey IACA trust source already exists: ${sourceId}`);
    } else {
      throw new Error(`Failed to load IACA trust source: ${errMsg}`);
    }
  }
}

/** List all trust sources */
export async function listTrustSources(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('List trust sources', 'FLOW');
  
  const response = await ctx.orgClient.get(
    `/v1/${ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources`
  );
  ctx.saveJson('list-trust-sources-response.json', response.data, step);
  
  const sources = response.data as Array<{
    sourceId: string;
    displayName?: string;
    sourceFamily?: string;
    territory?: string;
    entitiesCount?: number;
    authenticityState?: string;
  }>;
  
  console.log(`   [OK] Trust registry has ${sources.length} source(s):`);
  for (const src of sources) {
    const authIcon = src.authenticityState === 'VALIDATED' ? '[y]' : '[n]';
    console.log(`        ${authIcon} ${src.sourceId}`);
    console.log(`           Family: ${src.sourceFamily || 'unknown'}, Territory: ${src.territory || '?'}`);
    console.log(`           Authenticity: ${src.authenticityState || 'UNKNOWN'}`);
  }
  
  console.log('');
  console.log('   [y] VALIDATED = XMLDSig signature verified (requireAuthenticated: true will pass)');
  console.log('   [n]️  SKIPPED_DEMO = No signature validation (requireAuthenticated: true will fail)');
}

/** Complete ETSI trust registry setup */
export async function setupEtsiTrustRegistry(ctx: CommandContext): Promise<void> {
  console.log('\n=== Setting up ETSI Trust Registry ===\n');
  
  console.log('--- Step 1: Create Trust Registry Service ---');
  await setupCreateTrustRegistry(ctx);

  console.log('\n--- Step 2: Link Verifier2 to Trust Registry ---');
  await linkVerifier2ToTrustRegistry(ctx);

  console.log('\n--- Step 3: Import Public Trust Lists ---');
  await importPublicTrustLists(ctx);

  console.log('\n--- Step 4: Load Local IACA Certificate ---');
  await loadIacaIntoTrustRegistry(ctx);

  console.log('\n--- Step 5: List Trust Sources ---');
  await listTrustSources(ctx);

  console.log('\n[SETUP] ETSI Trust Registry setup complete');
}
