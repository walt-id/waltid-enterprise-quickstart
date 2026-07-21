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
import { buildCertificateAnchorLote, MDL_ISSUER_SERVICE_TYPE } from '../../trust-registry/index.js';

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
    acceptancePolicy: 'ALLOW_UNSIGNED',
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
      sourceId: 'at-tsl-authenticated',
      url: 'https://www.signatur.rtr.at/vertrauensliste.xml',
      description: 'Austrian TSL (XML format, XMLDSig integrity verified)',
      acceptancePolicy: 'REQUIRE_VALID_SIGNATURE',
    },
    {
      sourceId: 'it-tsl-authenticated',
      url: 'https://eidas.agid.gov.it/TL/TSL-IT.xml',
      description: 'Italian TSL (XML format, XMLDSig integrity verified)',
      acceptancePolicy: 'REQUIRE_VALID_SIGNATURE',
    },
    {
      sourceId: 'eu-lotl',
      url: 'https://ec.europa.eu/tools/lotl/eu-lotl.xml',
      description: 'EU LoTL (signed pointer list; member lists are not loaded automatically)',
      acceptancePolicy: 'REQUIRE_VALID_SIGNATURE',
    },
  ];
  
  for (const trustList of publicTrustLists) {
    const step = ctx.nextStep();
    ctx.log(`Import: ${trustList.description}`, 'FLOW');
    
    const request = {
      sourceId: trustList.sourceId,
      url: trustList.url,
      acceptancePolicy: trustList.acceptancePolicy,
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
  
  const loteSource = buildCertificateAnchorLote(sourceId, 'US', [{
    id: 'journey-test-iaca',
    legalName: 'Walt CLI Journey Test IACA',
    country: 'US',
    serviceName: 'mDL issuing',
    serviceType: MDL_ISSUER_SERVICE_TYPE,
    certificatePem: iacaPem,
  }]);
  
  ctx.saveJson('journey-iaca-lote-source.json', loteSource, step);
  
  const request = {
    sourceId: sourceId,
    content: JSON.stringify(loteSource),
    sourceUrl: 'local://journey-test',
    acceptancePolicy: 'ALLOW_UNSIGNED',
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
    format?: string;
    freshnessState?: string;
    territory?: string;
    entitiesCount?: number;
    assurance?: {
      authenticityState?: string;
      accepted?: boolean;
    };
  }>;
  
  console.log(`   [OK] Trust registry has ${sources.length} source(s):`);
  for (const src of sources) {
    const authenticity = src.assurance?.authenticityState || 'UNKNOWN';
    const authIcon = src.assurance?.accepted ? '[y]' : '[n]';
    console.log(`        ${authIcon} ${src.sourceId}`);
    console.log(`           Family: ${src.sourceFamily || 'unknown'}, Format: ${src.format || 'unknown'}`);
    console.log(`           Territory: ${src.territory || '?'}, Freshness: ${src.freshnessState || 'UNKNOWN'}`);
    console.log(`           Authenticity: ${authenticity}`);
  }
  
  console.log('');
  console.log('   [y] AUTHENTICATED = signature and independently trusted signer verified');
  console.log('   [y] INTEGRITY_VERIFIED = signature integrity verified; signer trust not evaluated');
  console.log('   [y] UNVERIFIED = explicitly admitted unsigned or unchecked source');
  console.log('   [n] FAILED/UNKNOWN = source is not active for trust resolution');
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
