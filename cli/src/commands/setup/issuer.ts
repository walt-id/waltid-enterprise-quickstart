/**
 * Issuer setup commands.
 * 
 * Handles:
 * - VICAL service creation and publishing
 * - Client attester service
 * - Issuer2 service with client attestation
 * - Issuer credential profiles
 * - Wallet attestation
 */

import { CommandContext } from '../../context.js';
import { RESOURCES, KEY_IDS, CERT_IDS, MDL_DOC_TYPE } from '../../config.js';

/** Create VICAL service */
export async function setupCreateVicalService(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create VICAL service', 'SETUP');

  const { created } = await ctx.tolerantCreate(
    'VICAL service',
    async () => {
      const request = {
        type: 'vical-service',
        _id: `${ctx.tenantPath}.${RESOURCES.vical}`,
        signingKeyId: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.vicalSigningKey}`,
        signerCertificateId: `${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalSignerCert}`,
        dependencies: [
          `${ctx.tenantPath}.${RESOURCES.kms}`,
          `${ctx.tenantPath}.${RESOURCES.x509Store}`,
        ],
      };
      ctx.saveJson('create-vical-service-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.vical}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-vical-service-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] VICAL service created`);
  }
}

/** Publish VICAL */
export async function setupPublishVical(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Publish VICAL', 'SETUP');

  const request = {
    vicalProvider: 'Walt CLI VICAL Provider',
  };
  ctx.saveJson('publish-vical-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.vical}/vical-service-api/publish`,
    request
  );
  ctx.saveJson('publish-vical-response.json', response.data, step);

  ctx.ctx.vicalVersionIdPath = response.data.versionIdPath?.path || response.data.versionIdPath || '';
  const entryCount = response.data.entryCount || 0;
  
  console.log(`   [OK] VICAL published (version: ${ctx.ctx.vicalVersionIdPath}, entries: ${entryCount})`);
}

/** Create client attester service */
export async function setupCreateClientAttester(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create client attester service', 'SETUP');

  const { created } = await ctx.tolerantCreate(
    'Client attester service',
    async () => {
      const request = {
        type: 'client-attester',
        _id: `${ctx.tenantPath}.${RESOURCES.clientAttester}`,
        signingKeyId: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.attesterSigningKey}`,
      };
      ctx.saveJson('create-client-attester-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.clientAttester}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-client-attester-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Client attester created`);
  }

  // Add KMS dependency
  try {
    await ctx.orgClient.postRaw(
      `/v1/${ctx.tenantPath}.${RESOURCES.clientAttester}/client-attester-api/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.kms}`
    );
    console.log(`   [OK] KMS dependency added to client attester`);
  } catch (error: any) {
    if (error.status !== 409 && !error.message?.includes('already')) {
      console.log(`   [WARN] KMS dependency issue, continuing...`);
    }
  }
}

/** Create issuer2 with client attestation enforcement */
export async function setupCreateIssuer2(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create issuer2 with client attestation enforcement', 'SETUP');

  const { created } = await ctx.tolerantCreate(
    'Issuer2 service',
    async () => {
      // Read attester public key
      const attesterKey = ctx.loadKeyFile('attester-key.json');
      const attesterPublicJwk = {
        kty: attesterKey.kty,
        crv: attesterKey.crv,
        x: attesterKey.x,
        y: attesterKey.y,
      };

      const request = {
        type: 'issuer2',
        _id: `${ctx.tenantPath}.${RESOURCES.issuer}`,
        tokenKeyId: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
        kms: `${ctx.tenantPath}.${RESOURCES.kms}`,
        credentialConfigurations: {
          [MDL_DOC_TYPE]: {
            format: 'mso_mdoc',
            doctype: MDL_DOC_TYPE,
            scope: MDL_DOC_TYPE,
            credential_signing_alg_values_supported: [-7, -9],
            cryptographic_binding_methods_supported: ['cose_key'],
            proof_types_supported: {
              jwt: {
                proof_signing_alg_values_supported: ['ES256'],
              },
            },
          },
        },
        clientAuthenticationConfig: {
          supportedMethods: [
            {
              type: 'client-attestation',
              config: {
                verificationMethod: {
                  type: 'static-jwk',
                  jwk: attesterPublicJwk,
                },
                clockSkewSeconds: 300,
                replayWindowSeconds: 300,
              },
            },
          ],
        },
      };
      ctx.saveJson('create-issuer2-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.issuer}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-issuer2-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Issuer2 created with client attestation`);
  }
}

/** Create issuer credential profile */
export async function setupCreateIssuerProfile(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create issuer credential profile', 'SETUP');

  const { created } = await ctx.tolerantCreate(
    'Issuer profile',
    async () => {
      const ISO_NAMESPACE = 'org.iso.18013.5.1';
      
      // Ensure we have certificates
      if (!ctx.ctx.docSignerPem) {
        try {
          const certResponse = await ctx.orgClient.get(
            `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
          );
          ctx.ctx.docSignerPem = certResponse.data.data?.pem || certResponse.data.certificatePem || certResponse.data.pem;
        } catch (e) {
          throw new Error('Document signer certificate not found. Run setup-create-document-signer-certificate first.');
        }
      }
      
      if (!ctx.ctx.iacaPem) {
        try {
          const certResponse = await ctx.orgClient.get(
            `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
          );
          ctx.ctx.iacaPem = certResponse.data.data?.pem || certResponse.data.certificatePem || certResponse.data.pem;
        } catch (e) {
          // IACA cert is optional for the chain
        }
      }

      // Build the full x5c chain: [Document Signer (leaf), IACA (root)]
      const x5Chain: Array<{ type: string; pemEncodedCertificate: string }> = [
        {
          type: 'pem-encoded-x509-certificate-descriptor',
          pemEncodedCertificate: ctx.ctx.docSignerPem,
        },
      ];
      
      if (ctx.ctx.iacaPem) {
        x5Chain.push({
          type: 'pem-encoded-x509-certificate-descriptor',
          pemEncodedCertificate: ctx.ctx.iacaPem,
        });
      }

      const request = {
        name: RESOURCES.issuerProfile,
        credentialConfigurationId: MDL_DOC_TYPE,
        issuerKeyId: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
        x5Chain,
        credentialData: {
          [ISO_NAMESPACE]: {
            family_name: 'Doe',
            given_name: 'John',
            birth_date: '1990-01-01',
            issue_date: '2024-01-01',
            expiry_date: '2029-01-01',
            issuing_country: 'US',
            issuing_authority: 'Test DMV',
            document_number: 'DL123456789',
            un_distinguishing_sign: 'USA',
          },
        },
      };
      ctx.saveJson('create-issuer-profile-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v2/${ctx.tenantPath}.${RESOURCES.issuer}.${RESOURCES.issuerProfile}/issuer-service-api/credentials/profiles`,
        request
      );
      ctx.saveJson('create-issuer-profile-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Issuer profile created`);
  }
}

/** Link wallet to client attester */
export async function setupLinkWalletToAttester(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Attach client attester dependency to wallet', 'SETUP');

  try {
    await ctx.orgClient.postRaw(
      `/v1/${ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.clientAttester}`
    );
    console.log(`   [OK] Client attester linked to wallet`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] Client attester already linked to wallet`);
    } else {
      throw error;
    }
  }
}

/** Obtain wallet attestation */
export async function setupObtainWalletAttestation(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Wallet obtains client attestation', 'SETUP');

  const request = {
    clientAttesterServiceRef: `${ctx.tenantPath}.${RESOURCES.clientAttester}`,
    instanceKeyReference: ctx.ctx.walletKeyRef,
  };
  ctx.saveJson('obtain-attestation-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/client-attestation/obtain`,
    request
  );
  ctx.saveJson('obtain-attestation-response.json', response.data, step);

  ctx.ctx.clientAttestationJwt = response.data.clientAttestationJwt;
  if (!ctx.ctx.clientAttestationJwt) {
    throw new Error('Wallet did not return clientAttestationJwt');
  }
  
  console.log(`   [OK] Wallet attestation obtained (expires: ${response.data.expiresAt || 'unknown'})`);
}
