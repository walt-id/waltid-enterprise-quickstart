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
import {
  getStoredCertificatePem,
  setupCreateVerifierRequestSigningCertificate,
  setupGenerateVerifierRequestSigningKey,
} from './keys.js';
import { linkVerifier2ToKms } from './tenant.js';
import {
  buildCertificateAnchorLote,
  LOTE_TYPE_EU_WRP_RC_PROVIDERS,
  MDL_ISSUER_SERVICE_TYPE,
  RELYING_PARTY_SERVICE_TYPE,
} from '../../trust-registry/index.js';

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
    await ctx.addServiceDependency(
      `/v2/${verifier2Target}/verifier-service-api/dependencies/add`,
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

/**
 * Link Wallet2 to Trust Registry so relying-party identities can join the JAR
 * trust store. This journey still pins the IACA as a CA via
 * pinWallet2RequestObjectTrustAnchor: PKIX looks up the leaf's issuer, and an
 * RP LoTE leaf is not a CA.
 */
export async function linkWallet2ToTrustRegistry(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Link Wallet2 to Trust Registry (via service dependency)', 'FLOW');

  const trustRegistryTarget = `${ctx.tenantPath}.${RESOURCES.trustRegistry}`;
  const walletTarget = `${ctx.tenantPath}.${RESOURCES.wallet}`;

  try {
    await ctx.addServiceDependency(
      `/v2/${walletTarget}/wallet-service-api/dependencies/add`,
      trustRegistryTarget
    );
    console.log(`   [OK] Trust registry linked to wallet: ${trustRegistryTarget}`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] Trust registry already linked to wallet`);
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
      sourceId: 'de-tsl-authenticated',
      url: 'https://tl.bundesnetzagentur.de/TL-DE.xml',
      description: 'German TSL (XML format, RSASSA-PSS/MGF1-SHA256 XMLDSig integrity verified)',
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

/**
 * Real signer certificate of Germany's national TSL (BNetzA), extracted from that list's own
 * ds:Signature/ds:KeyInfo at https://tl.bundesnetzagentur.de/TL-DE.xml on 2026-09-28.
 * CN=German Trusted List Signer 14, O=Federal Network Agency, C=DE,
 * SHA-256 88:BB:9B:30:8D:E7:09:08:AC:55:58:3A:9F:8D:22:E6:93:34:C0:99:C8:B9:C5:A8:C5:8D:53:4A:40:EF:DF:C1,
 * valid until 2027-04-29.
 *
 * If BNetzA rotates this certificate, demonstrateAuthenticatedSignerTrust below will start
 * failing with SIGNATURE_VALIDATION_FAILED - re-extract the current one from the list's own
 * <ds:X509Certificate> and replace the constant below.
 */
const GERMAN_TSL_SIGNER_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
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
uxYuOBiQYQ==
-----END CERTIFICATE-----`;

function normalizePem(pem: string): string {
  return pem.replace(/\s/g, '');
}

/**
 * Demonstrates trustedSourceSignerCertificates end-to-end: pins Germany's real TSL signer
 * certificate on the trust registry's own configuration (not a service-creation-time-only
 * field - configuration/update takes the identical shape), then re-loads that same TSL under
 * REQUIRE_AUTHENTICATED to prove the pin is actually honored, not just accepted and ignored.
 *
 * Uses REQUIRE_AUTHENTICATED specifically (not REQUIRE_VALID_SIGNATURE, which
 * importPublicTrustLists already covers) so the response's assurance.authenticityState is
 * AUTHENTICATED only if trustedSourceSignerCertificates actually gated admission.
 */
export async function demonstrateAuthenticatedSignerTrust(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Configure trustedSourceSignerCertificates and load an authenticated TSL', 'FLOW');

  const trustRegistryPath = `${ctx.tenantPath}.${RESOURCES.trustRegistry}`;
  const viewPath = `/v1/${trustRegistryPath}/trust-registry-api/configuration/view`;
  const current = (await ctx.orgClient.get(viewPath)).data ?? {};
  ctx.saveJson('trust-registry-configuration-view.json', current, step);

  const existingSigners: string[] = current.trustedSourceSignerCertificates ?? [];
  if (!existingSigners.some((pem) => normalizePem(pem) === normalizePem(GERMAN_TSL_SIGNER_CERTIFICATE_PEM))) {
    const updated = {
      ...current,
      trustedSourceSignerCertificates: [...existingSigners, GERMAN_TSL_SIGNER_CERTIFICATE_PEM],
    };
    ctx.saveJson('trust-registry-configuration-update-request.json', updated, step);
    await ctx.orgClient.put(
      `/v1/${trustRegistryPath}/trust-registry-api/configuration/update`,
      updated
    );
    console.log('   [OK] trustedSourceSignerCertificates now pins the German TSL signer certificate');
  } else {
    console.log('   [SKIP] German TSL signer certificate already pinned');
  }

  const sourceId = 'de-tsl-authenticated-trusted-signer';
  const request = {
    sourceId,
    url: 'https://tl.bundesnetzagentur.de/TL-DE.xml',
    acceptancePolicy: 'REQUIRE_AUTHENTICATED',
  };
  ctx.saveJson(`import-${sourceId}-request.json`, request, step);

  try {
    const response = await ctx.orgClient.post(
      `/v1/${trustRegistryPath}/trust-registry-api/sources/load`,
      request
    );
    ctx.saveJson(`import-${sourceId}-response.json`, response.data, step);

    if (response.data.success && response.data.assurance?.authenticityState === 'AUTHENTICATED') {
      console.log(`   [OK] ${sourceId} loaded and AUTHENTICATED via the pinned signer certificate`);
      console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
      console.log(`        Services: ${response.data.servicesLoaded || 0}`);
      console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
    } else {
      console.log(
        `   [WARN] ${sourceId} did not authenticate as expected: ` +
        `${response.data.error || response.data.assurance?.authenticityState}`
      );
    }
  } catch (error: any) {
    const errMsg = error.message || error.response?.data?.message || '';
    if (error.status === 409 ||
        errMsg.includes('Duplicate target') ||
        errMsg.includes('already exists') ||
        errMsg.includes('Overwriting targets')) {
      console.log(`   [SKIP] ${sourceId} already exists`);
    } else {
      console.log(`   [WARN] Failed to import ${sourceId}: ${errMsg}`);
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

/**
 * Pin the IACA as Wallet2's Request Object CA.
 *
 * `x509_hash` PKIX looks up the leaf's issuer in the trust store. The journey
 * IACA is a PID/mDL issuer on the trust list, not a relying party, so registry
 * RP identities do not supply it. The leaf still goes in session `x5c`.
 */
export async function pinWallet2RequestObjectTrustAnchor(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Pin IACA as Wallet2 Request Object trust anchor', 'SETUP');

  const iacaPem = ctx.ctx.iacaPem || (await getStoredCertificatePem(ctx, CERT_IDS.vicalIacaCert));
  if (!iacaPem) {
    throw new Error('IACA certificate not found. Run setup-create-iaca-certificate first.');
  }
  ctx.ctx.iacaPem = iacaPem;

  const walletPath = `${ctx.tenantPath}.${RESOURCES.wallet}`;
  const viewPath = `/v2/${walletPath}/wallet-service-api/configuration/view`;
  const current = (await ctx.orgClient.get(viewPath)).data ?? {};
  ctx.saveJson('wallet2-configuration-view.json', current, step);

  const existingPins: string[] =
    current.configuration?.requestObjectX509Trust?.x509TrustAnchorsPem ?? [];
  if (existingPins.some((pem) => normalizePem(pem) === normalizePem(iacaPem))) {
    console.log('   [SKIP] Wallet2 already pins the IACA as a Request Object trust anchor');
    return;
  }

  const updated = {
    ...current,
    configuration: {
      ...(current.configuration ?? {}),
      requestObjectX509Trust: {
        x509TrustAnchorsPem: [iacaPem, ...existingPins],
      },
    },
  };
  ctx.saveJson('wallet2-configuration-update-request.json', updated, step);
  await ctx.orgClient.put(
    `/v2/${walletPath}/wallet-service-api/configuration/update`,
    updated,
  );
  console.log('   [OK] Wallet2 pins the IACA for x509_hash Request Object authentication');
}

type TrustSourceSummary = {
  sourceId: string;
  assurance?: {
    authenticityState?: string;
    accepted?: boolean;
  };
};

async function getTrustSource(
  ctx: CommandContext,
  sourceId: string,
): Promise<TrustSourceSummary | undefined> {
  const response = await ctx.orgClient.get(
    `/v1/${ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources`
  );
  const sources = (response.data ?? []) as TrustSourceSummary[];
  return sources.find((source) => source.sourceId === sourceId);
}

function isAcceptedTrustSource(source?: TrustSourceSummary): boolean {
  return source?.assurance?.accepted === true;
}

/**
 * Load the verifier request-signing leaf as a relying-party LoTE.
 * The IACA stays a PID/mDL issuer identity; reusing it here makes
 * `etsi-trust-list` report MULTIPLE_MATCHES on the issuer chain.
 * JAR PKIX uses the IACA PEM pin from pinWallet2RequestObjectTrustAnchor,
 * not this leaf.
 */
export async function loadRelyingPartyIntoTrustRegistry(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Load relying-party identities into trust registry', 'FLOW');

  const leafPem = await getStoredCertificatePem(ctx, CERT_IDS.verifierRequestSigningCert);
  if (!leafPem) {
    throw new Error(
      'Verifier request-signing certificate not found. Run setup-create-verifier-request-signing-certificate first.'
    );
  }

  const sourceId = 'journey-rp-local';
  const existing = await getTrustSource(ctx, sourceId);
  if (isAcceptedTrustSource(existing)) {
    console.log(`   [SKIP] Journey relying-party trust source already loaded and accepted: ${sourceId}`);
    return;
  }

  const loteSource = buildCertificateAnchorLote(
    sourceId,
    'US',
    [{
      id: 'journey-test-rp',
      legalName: 'Walt CLI Journey Test Relying Party',
      country: 'US',
      serviceName: 'OpenID4VP relying party',
      serviceType: RELYING_PARTY_SERVICE_TYPE,
      certificatePem: leafPem,
    }],
    LOTE_TYPE_EU_WRP_RC_PROVIDERS
  );

  ctx.saveJson('journey-rp-lote-source.json', loteSource, step);

  const request = {
    sourceId,
    content: JSON.stringify(loteSource),
    sourceUrl: 'local://journey-rp',
    acceptancePolicy: 'ALLOW_UNSIGNED',
  };
  ctx.saveJson('load-journey-rp-request.json', request, step);

  try {
    const response = await ctx.orgClient.post(
      `/v1/${ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources/load`,
      request
    );
    ctx.saveJson('load-journey-rp-response.json', response.data, step);

    if (!response.data.success || response.data.assurance?.accepted === false) {
      throw new Error(
        `Failed to load relying-party trust source: ${response.data.error || 'source was not accepted'}`
      );
    }

    console.log(`   [OK] Journey relying-party trust source loaded: ${sourceId}`);
    console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
    console.log(`        Services: ${response.data.servicesLoaded || 0}`);
    console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
  } catch (error: any) {
    const errMsg = error.message || error.response?.data?.message || '';
    const isDuplicate = error.status === 409 ||
        errMsg.includes('Duplicate target') ||
        errMsg.includes('already exists') ||
        errMsg.includes('Overwriting targets');
    if (isDuplicate) {
      const after = await getTrustSource(ctx, sourceId);
      if (isAcceptedTrustSource(after)) {
        console.log(`   [SKIP] Journey relying-party trust source already exists and is accepted: ${sourceId}`);
        return;
      }
      throw new Error(
        `Relying-party trust source ${sourceId} exists but is not accepted; refusing to treat a failed import as success`
      );
    }
    throw new Error(`Failed to load relying-party trust source: ${errMsg}`);
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

  console.log('\n--- Step 4: Demonstrate trustedSourceSignerCertificates ---');
  await demonstrateAuthenticatedSignerTrust(ctx);

  console.log('\n--- Step 5: Load Local IACA Certificate ---');
  await loadIacaIntoTrustRegistry(ctx);

  console.log('\n--- Step 6: Create Verifier Request-Signing Key and Certificate ---');
  await setupGenerateVerifierRequestSigningKey(ctx);
  await setupCreateVerifierRequestSigningCertificate(ctx);
  await linkVerifier2ToKms(ctx);

  console.log('\n--- Step 7: Pin IACA as Wallet2 Request Object CA ---');
  await pinWallet2RequestObjectTrustAnchor(ctx);

  console.log('\n--- Step 8: Load Relying-Party Identities ---');
  await loadRelyingPartyIntoTrustRegistry(ctx);

  console.log('\n--- Step 9: Link Wallet2 to Trust Registry ---');
  await linkWallet2ToTrustRegistry(ctx);

  console.log('\n--- Step 10: List Trust Sources ---');
  await listTrustSources(ctx);

  console.log('\n[SETUP] ETSI Trust Registry setup complete');
}
