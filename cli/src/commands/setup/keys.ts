/**
 * Key and certificate setup commands.
 *
 * Handles:
 * - Key imports (IACA, issuer, attester, VICAL signing)
 * - Certificate creation (IACA, document signer) via the unified X.509 service
 * - Certificate storage (VICAL signer)
 */

import { CommandContext } from '../../context.js';
import {
  RESOURCES,
  KEY_IDS,
  CERT_IDS,
  CERT_PROFILES,
  CERT_VALIDITY_DAYS,
  CLI_IACA_IAN_URI,
  CLI_DS_CRL_URI,
  MDL_DOC_TYPE,
  PID_DOC_TYPE,
} from '../../config.js';

/** GeneralName entry used by subject/issuer alternative names */
export interface X509GeneralName {
  type: 'dnsName' | 'email' | 'uri' | 'ipAddress';
  name: string;
}

/** Request body for POST/PUT `/x509-service-api/certificates` */
export interface UpsertGeneratedCertificateRequest {
  createStrategy?: 'CREATE_NONE' | 'CREATE_ONE' | 'CREATE_ALL';
  storeRef?: string;
  certificateProfile?: string;
  selfSigned?: boolean;
  issuerKeyRef?: string;
  issuerCertificateRef?: string;
  issuerCertificatePem?: string;
  subjectKeyRef?: string;
  subjectDn?: string;
  validFrom: string;
  validTo: string;
  issuerAlternativeNames?: X509GeneralName[];
  crlDistributionPointUri?: string;
  metadata?: Record<string, unknown>;
}

/** Build an ISO-style subject DN (`C=...,CN=...`) matching the enterprise adapters. */
export function isoSubjectDn(parts: {
  country: string;
  commonName: string;
  stateOrProvinceName?: string;
  organizationName?: string;
  localityName?: string;
}): string {
  return [
    `C=${parts.country}`,
    `CN=${parts.commonName}`,
    parts.stateOrProvinceName ? `ST=${parts.stateOrProvinceName}` : undefined,
    parts.organizationName ? `O=${parts.organizationName}` : undefined,
    parts.localityName ? `L=${parts.localityName}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(',');
}

export function certificateValidityWindow(days: number): { validFrom: string; validTo: string } {
  const validFrom = new Date();
  const validTo = new Date(validFrom.getTime() + days * 24 * 60 * 60 * 1000);
  return {
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
  };
}

export function kmsKeyRef(ctx: CommandContext, keyId: string): string {
  return `${ctx.tenantPath}.${RESOURCES.kms}.${keyId}`;
}

export function x509StoreCertificateRef(ctx: CommandContext, certId: string): string {
  return `${ctx.tenantPath}.${RESOURCES.x509Store}.${certId}`;
}

function x509StoreCertificatePath(ctx: CommandContext, certId: string): string {
  return `/v1/${x509StoreCertificateRef(ctx, certId)}/x509-store-api/certificates`;
}

function x509ServiceCreateCertificatePath(ctx: CommandContext, certId: string): string {
  return `/v1/${ctx.tenantPath}.${RESOURCES.x509Service}.${certId}/x509-service-api/certificates`;
}

export function extractCertificatePem(data: any): string | undefined {
  return (
    data?.certificate?.certificatePem ||
    data?.certificate?.data?.pem ||
    data?.data?.pem ||
    data?.certificatePem ||
    data?.pem
  );
}

/** Load a stored certificate PEM from the linked X.509 store, if present. */
export async function getStoredCertificatePem(
  ctx: CommandContext,
  certId: string
): Promise<string | undefined> {
  try {
    const existing = await ctx.orgClient.get(x509StoreCertificatePath(ctx, certId));
    return extractCertificatePem(existing.data);
  } catch {
    return undefined;
  }
}

/**
 * Create a certificate through the unified X.509 service (`PUT /certificates/{id}`)
 * using a stable child id so later store lookups stay deterministic.
 */
export async function createGeneratedCertificate(
  ctx: CommandContext,
  certId: string,
  request: UpsertGeneratedCertificateRequest,
  logName: string,
  step?: string
): Promise<string> {
  const body = {
    storeRef: `${ctx.tenantPath}.${RESOURCES.x509Store}`,
    ...request,
  };
  ctx.saveJson(`create-${logName}-request.json`, body, step);

  const response = await ctx.orgClient.put(
    x509ServiceCreateCertificatePath(ctx, certId),
    body
  );
  ctx.saveJson(`create-${logName}-response.json`, response.data, step);

  const pem = extractCertificatePem(response.data) || (await getStoredCertificatePem(ctx, certId));
  if (!pem) {
    throw new Error(`Certificate '${certId}' was created but PEM could not be retrieved`);
  }
  return pem;
}

/** Import cryptographic keys */
export async function setupImportKeys(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Import keys', 'SETUP');

  const keys = [
    { id: KEY_IDS.vicalIacaKey, file: 'iacakey.json', name: 'IACA key' },
    { id: KEY_IDS.issuerSigningKey, file: 'dskey.json', name: 'Issuer/Document Signer key' },
    { id: KEY_IDS.attesterSigningKey, file: 'attester-key.json', name: 'Attester key' },
    { id: KEY_IDS.vicalSigningKey, file: 'vical-signing-key.json', name: 'VICAL Signing key' },
  ];

  for (const key of keys) {
    const { created } = await ctx.tolerantCreate(
      `Key ${key.name}`,
      async () => {
        const jwk = ctx.loadKeyFile(key.file);
        
        const response = await ctx.orgClient.post(
          `/v1/${ctx.tenantPath}.${RESOURCES.kms}.${key.id}/kms-service-api/keys/import/jwk`,
          jwk
        );
        return response;
      }
    );
    
    if (created) {
      console.log(`   [OK] ${key.name} imported`);
    }
  }
}

/** Create IACA certificate */
export async function setupCreateIacaCertificate(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create IACA certificate', 'SETUP');

  const existingPem = await getStoredCertificatePem(ctx, CERT_IDS.vicalIacaCert);
  if (existingPem) {
    ctx.ctx.iacaPem = existingPem;
    console.log(`   [SKIP] IACA certificate already exists`);
    return;
  }

  ctx.ctx.iacaPem = await createGeneratedCertificate(
    ctx,
    CERT_IDS.vicalIacaCert,
    {
      selfSigned: true,
      certificateProfile: CERT_PROFILES.isoIacaRoot,
      subjectKeyRef: kmsKeyRef(ctx, KEY_IDS.vicalIacaKey),
      subjectDn: isoSubjectDn({ country: 'US', commonName: 'Walt CLI Test IACA' }),
      ...certificateValidityWindow(CERT_VALIDITY_DAYS.iaca),
      issuerAlternativeNames: [{ type: 'uri', name: CLI_IACA_IAN_URI }],
      metadata: {
        // Both doctypes, since this IACA is shared by the mDL and PID flows (CREDENTIAL_TYPE)
        // and the vical verification policy filters trust anchors by the presented doctype.
        vicalDocType: [MDL_DOC_TYPE, PID_DOC_TYPE],
      },
    },
    'iaca-cert',
    step
  );

  console.log(`   [OK] IACA certificate created`);
}

/** Create document signer certificate */
export async function setupCreateDocumentSignerCertificate(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create document signer certificate', 'SETUP');

  const existingPem = await getStoredCertificatePem(ctx, CERT_IDS.docSignerCert);
  if (existingPem) {
    ctx.ctx.docSignerPem = existingPem;
    console.log(`   [SKIP] Document signer certificate already exists`);
    return;
  }

  if (!ctx.ctx.iacaPem) {
    ctx.ctx.iacaPem = (await getStoredCertificatePem(ctx, CERT_IDS.vicalIacaCert)) || '';
    if (!ctx.ctx.iacaPem) {
      throw new Error('IACA certificate not found. Run setup-create-iaca-certificate first.');
    }
  }

  ctx.ctx.docSignerPem = await createGeneratedCertificate(
    ctx,
    CERT_IDS.docSignerCert,
    {
      certificateProfile: CERT_PROFILES.isoDocumentSigner,
      issuerCertificateRef: x509StoreCertificateRef(ctx, CERT_IDS.vicalIacaCert),
      issuerKeyRef: kmsKeyRef(ctx, KEY_IDS.vicalIacaKey),
      subjectKeyRef: kmsKeyRef(ctx, KEY_IDS.issuerSigningKey),
      subjectDn: isoSubjectDn({ country: 'US', commonName: 'Walt CLI Document Signer' }),
      ...certificateValidityWindow(CERT_VALIDITY_DAYS.documentSigner),
      issuerAlternativeNames: [{ type: 'uri', name: CLI_IACA_IAN_URI }],
      crlDistributionPointUri: CLI_DS_CRL_URI,
    },
    'doc-signer-cert',
    step
  );

  console.log(`   [OK] Document signer certificate created`);
}

/** Store VICAL signer certificate */
export async function setupStoreVicalSignerCertificate(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Store VICAL signer certificate', 'SETUP');

  const { created } = await ctx.tolerantCreate(
    'VICAL signer certificate',
    async () => {
      const certPem = ctx.loadPemFile('vical-signer-cert.pem');
      const request = {
        type: 'base',
        certificatePem: certPem,
      };
      ctx.saveJson('store-vical-signer-cert-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalSignerCert}/x509-store-api/certificates`,
        request
      );
      ctx.saveJson('store-vical-signer-cert-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] VICAL signer certificate stored`);
  }
}
