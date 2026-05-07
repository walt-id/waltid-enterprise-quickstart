/**
 * Key and certificate setup commands.
 * 
 * Handles:
 * - Key imports (IACA, issuer, attester, VICAL signing)
 * - Certificate creation (IACA, document signer)
 * - Certificate storage (VICAL signer)
 */

import { CommandContext } from '../../context.js';
import { RESOURCES, KEY_IDS, CERT_IDS, MDL_DOC_TYPE } from '../../config.js';

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

  // Check if certificate already exists
  try {
    const existing = await ctx.orgClient.get(
      `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
    );
    if (existing.data) {
      ctx.ctx.iacaPem = existing.data.data?.pem || existing.data.certificatePem || existing.data.pem;
      console.log(`   [SKIP] IACA certificate already exists`);
      return;
    }
  } catch (e) {
    // Certificate doesn't exist, create it
  }

  const request = {
    storedCertificateId: CERT_IDS.vicalIacaCert,
    certificateData: {
      country: 'US',
      commonName: 'Walt CLI Test IACA',
      issuerAlternativeNameConf: {
        uri: 'https://walt-cli.example/iaca',
      },
    },
    iacaKeyDesc: {
      type: 'kms-hosted-key-descriptor',
      keyIdPath: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.vicalIacaKey}`,
    },
    vicalEntryComplementaryMetadata: {
      docType: [MDL_DOC_TYPE],
    },
  };
  ctx.saveJson('create-iaca-cert-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.x509Service}/x509-service-api/iso/iacas`,
    request
  );
  ctx.saveJson('create-iaca-cert-response.json', response.data, step);

  // Retrieve PEM
  const certResp = await ctx.orgClient.get(
    `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
  );
  ctx.ctx.iacaPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
  
  console.log(`   [OK] IACA certificate created`);
}

/** Create document signer certificate */
export async function setupCreateDocumentSignerCertificate(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create document signer certificate', 'SETUP');

  // Check if certificate already exists
  try {
    const existing = await ctx.orgClient.get(
      `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
    );
    if (existing.data) {
      ctx.ctx.docSignerPem = existing.data.data?.pem || existing.data.certificatePem || existing.data.pem;
      console.log(`   [SKIP] Document signer certificate already exists`);
      return;
    }
  } catch (e) {
    // Certificate doesn't exist, create it
  }

  // Ensure we have IACA PEM
  if (!ctx.ctx.iacaPem) {
    try {
      const certResponse = await ctx.orgClient.get(
        `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
      );
      ctx.ctx.iacaPem = certResponse.data.data?.pem || certResponse.data.certificatePem || certResponse.data.pem;
    } catch (e) {
      throw new Error('IACA certificate not found. Run setup-create-iaca-certificate first.');
    }
  }

  const request = {
    storedCertificateId: CERT_IDS.docSignerCert,
    iacaSigner: {
      type: 'iaca-pem-cert-descriptor',
      iacaPemEncodedCertificate: ctx.ctx.iacaPem,
      iacaKeyDesc: {
        type: 'kms-hosted-key-descriptor',
        keyIdPath: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.vicalIacaKey}`,
      },
    },
    certificateData: {
      country: 'US',
      commonName: 'Walt CLI Document Signer',
      crlDistributionPointUri: 'https://walt-cli.example/crl',
    },
    dsKeyDescriptor: {
      type: 'kms-hosted-key-descriptor',
      keyIdPath: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
    },
  };
  ctx.saveJson('create-doc-signer-cert-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.x509Service}/x509-service-api/iso/document-signers`,
    request
  );
  ctx.saveJson('create-doc-signer-cert-response.json', response.data, step);

  // Retrieve PEM
  const certResp = await ctx.orgClient.get(
    `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
  );
  ctx.ctx.docSignerPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
  
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
