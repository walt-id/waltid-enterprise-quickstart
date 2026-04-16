#!/usr/bin/env node
/**
 * Complete mDoc + Client Attestation + VICAL Journey Test
 * 
 * TypeScript translation of customer-setup-mdoc-client-attestation-vical.sh
 * 
 * This implements the full 21-step journey:
 * 1. Login
 * 2. Create tenant
 * 3. Create wallet
 * 4. Create verifier2
 * 5. Create KMS/X509 services
 * 6. Link X509 dependencies
 * 7. Import keys
 * 8. Create IACA certificate
 * 9. Create document signer certificate
 * 10. Store VICAL signer certificate
 * 11. Create VICAL service
 * 12. Publish VICAL
 * 13. Create client attester
 * 14. Create issuer2
 * 15. Create issuer profile
 * 16. Link wallet to attester
 * 17. Obtain wallet attestation
 * 18. Create credential offer
 * 19. Wallet receive credential
 * 20. Create verification session
 * 21. Wallet present credential
 * 22. Assert final status = SUCCESSFUL
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
interface Config {
  baseUrl: string;
  organization: string;
  tenant: string;
  email: string;
  password: string;
  port: number;
}

interface HttpResponse<T = any> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

interface JourneyContext {
  token: string;
  workdir: string;
  tenantPath: string;
  orgBaseUrl: string;
  walletKeyRef: string;
  iacaPem: string;
  docSignerPem: string;
  clientAttestationJwt: string;
  vicalVersionIdPath: string;
  offerId: string;
  sessionId: string;
  requestUrl: string;
}

// Constants
const RESOURCES = {
  wallet: 'wallet',
  issuer: 'issuer2',
  verifier2: 'verifier2',
  x509Service: 'x509-service',
  x509Store: 'x509-store',
  kms: 'kms',
  vical: 'vical',
  clientAttester: 'client-attester',
  issuerProfile: 'mdl-profile',
};

const KEY_IDS = {
  vicalIacaKey: 'vical-iaca-key',
  issuerSigningKey: 'issuer-signing-key',
  vicalSigningKey: 'vical-signing-key',
  attesterSigningKey: 'attester-signing-key',
};

const CERT_IDS = {
  vicalIacaCert: 'vical-iaca-cert',
  docSignerCert: 'vical-doc-signer-cert',
  vicalSignerCert: 'vical-signer-cert',
};

const MDL_DOC_TYPE = 'org.iso.18013.5.1.mDL';
const VERIFIER2_CLIENT_ID = 'wallet-mdoc-client-attestation-verifier';

// HTTP Client
class HttpClient {
  private token: string = '';
  private requestLog: any[] = [];

  constructor(private baseUrl: string) {}

  setToken(token: string) {
    this.token = token;
  }

  getLog() {
    return this.requestLog;
  }

  async request<T = any>(
    method: string,
    path: string,
    body?: any,
    contentType: string = 'application/json',
    skipStringify: boolean = false
  ): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const logEntry: any = { method, url, body };
    this.requestLog.push(logEntry);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? (
          skipStringify ? body : // Send raw if skipStringify
          contentType === 'application/json' ? JSON.stringify(body) : body
        ) : undefined,
      });

      const responseText = await response.text();
      let data: any;
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        data = responseText;
      }

      logEntry.response = data;
      logEntry.status = response.status;

      if (!response.ok) {
        // Check if it's an "already exists" error - treat as success
        if ((response.status === 400 || response.status === 409) && 
            (data.message?.includes('already exists') || 
             data.message?.includes('already in use') ||
             data.message?.includes('already attached') ||
             data.type === 'DuplicateTarget')) {
          console.log(`   ⚠️  Resource already exists, continuing...`);
          return { status: response.status, data, headers: Object.fromEntries(response.headers.entries()) };
        }
        
        const error = new Error(`HTTP ${response.status}: ${JSON.stringify(data, null, 2)}`);
        logEntry.error = error.message;
        throw error;
      }

      return {
        status: response.status,
        data,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (error: any) {
      logEntry.error = error.message;
      // If it's already an "already exists" case, don't re-throw
      if (error.message?.includes('already exists')) {
        return { status: 200, data: {}, headers: {} };
      }
      throw error;
    }
  }

  async get<T = any>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path);
  }

  async post<T = any>(path: string, body?: any, contentType?: string): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, contentType);
  }
}

// Journey Runner
class CompleteJourney {
  private client: HttpClient;
  private orgClient: HttpClient;
  private ctx: Partial<JourneyContext> = {};
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    
    this.ctx = {
      workdir: join(process.cwd(), `journey-test-${timestamp}`),
      tenantPath: `${config.organization}.${config.tenant}`,
      orgBaseUrl: `http://${config.organization}.${config.baseUrl.replace('http://', '')}:${config.port}`,
      token: '',
      walletKeyRef: '',
      iacaPem: '',
      docSignerPem: '',
      clientAttestationJwt: '',
      vicalVersionIdPath: '',
      offerId: '',
      sessionId: '',
      requestUrl: '',
    };

    this.client = new HttpClient(`${config.baseUrl}:${config.port}`);
    this.orgClient = new HttpClient(this.ctx.orgBaseUrl!);
  }

  log(message: string) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`\n▶️  ${message}`);
  }

  saveJson(filename: string, data: any) {
    const path = join(this.ctx.workdir!, filename);
    writeFileSync(path, JSON.stringify(data, null, 2));
  }

  async run() {
    mkdirSync(this.ctx.workdir!, { recursive: true });

    console.log('🚀 Complete Journey Test Started');
    console.log(`📂 Working directory: ${this.ctx.workdir}`);
    console.log(`🌐 Base URL: ${this.config.baseUrl}:${this.config.port}`);
    console.log(`🏢 Organization: ${this.config.organization}`);
    console.log(`👤 Tenant: ${this.config.tenant}`);
    console.log('');

    try {
      await this.login();
      await this.createTenant();
      await this.createWallet();
      await this.createVerifier2();
      await this.createServices();
      await this.linkX509Dependencies();
      await this.importKeys();
      await this.createIacaCertificate();
      await this.createDocumentSignerCertificate();
      await this.storeVicalSignerCertificate();
      await this.createVicalService();
      await this.publishVical();
      await this.createClientAttester();
      await this.createIssuer2();
      await this.createIssuerProfile();
      await this.linkWalletToAttester();
      await this.obtainWalletAttestation();
      await this.createCredentialOffer();
      await this.walletReceiveCredential();
      await this.createVerificationSession();
      await this.walletPresent();
      await this.assertFinalStatus();

      console.log('\n✅ Complete journey finished successfully!');
      console.log(`\n📂 Results saved in: ${this.ctx.workdir}`);

      // Save HTTP log
      const httpLogPath = join(this.ctx.workdir!, 'http-log.json');
      writeFileSync(httpLogPath, JSON.stringify(this.client.getLog().concat(this.orgClient.getLog()), null, 2));
      console.log(`📝 HTTP log saved: ${httpLogPath}`);
    } catch (error: any) {
      console.error('\n❌ Journey failed:', error.message);
      // Save HTTP log even on failure
      const httpLogPath = join(this.ctx.workdir!, 'http-log.json');
      writeFileSync(httpLogPath, JSON.stringify(this.client.getLog().concat(this.orgClient.getLog()), null, 2));
      console.log(`📝 HTTP log saved: ${httpLogPath}`);
      throw error;
    }
  }

  async login() {
    this.log('Login');
    const request = {
      email: this.config.email,
      password: this.config.password,
    };

    this.saveJson('login-request.json', request);

    const response = await this.client.post('/auth/account/emailpass', request);
    this.saveJson('login-response.json', response.data);

    this.ctx.token = response.data.token || response.data.accessToken || response.data.data?.token;
    if (!this.ctx.token) {
      throw new Error('Could not extract bearer token from login response');
    }

    this.client.setToken(this.ctx.token);
    this.orgClient.setToken(this.ctx.token);

    console.log('   ✓ Logged in successfully');
  }

  async createTenant() {
    this.log('Create tenant');
    const request = {
      name: 'mDoc client attestation + VICAL journey tenant',
    };

    this.saveJson('create-tenant-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}/resource-api/tenants/create`,
        request
      );
      this.saveJson('create-tenant-response.json', response.data);
      console.log(`   ✓ Tenant created: ${this.ctx.tenantPath}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ Tenant already exists: ${this.ctx.tenantPath}`);
      } else {
        throw error;
      }
    }
  }

  async createWallet() {
    this.log('Initialize wallet');
    const request = {
      createKeyInKms: {
        keyType: 'secp256r1',
      },
    };

    this.saveJson('init-wallet-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}/wallet-service-api/init-wallet`,
        request
      );
      this.saveJson('init-wallet-response.json', response.data);
      this.ctx.walletKeyRef = `${this.ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;
      console.log(`   ✓ Wallet initialized: ${this.ctx.tenantPath}.${RESOURCES.wallet}`);
    } catch (error: any) {
      if (error.message?.includes('already exists') || error.message?.includes('already initialized')) {
        this.ctx.walletKeyRef = `${this.ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;
        console.log(`   ✓ Wallet already initialized`);
      } else {
        throw error;
      }
    }
  }

  async createVerifier2() {
    this.log('Create verifier2');
    const request = {
      type: 'verifier2',
      baseUrl: this.ctx.orgBaseUrl,
      clientId: VERIFIER2_CLIENT_ID,
    };

    this.saveJson('create-verifier2-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.verifier2}/resource-api/services/create`,
        request
      );
      this.saveJson('create-verifier2-response.json', response.data);
      console.log(`   ✓ Verifier2 created: ${this.ctx.tenantPath}.${RESOURCES.verifier2}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ Verifier2 already exists`);
      } else {
        throw error;
      }
    }
  }

  async createServices() {
    this.log('Create KMS, X509 Service, X509 Store');

    // Create KMS
    try {
      const kmsRequest = { type: 'kms' };
      this.saveJson('create-kms-request.json', kmsRequest);
      const kmsResponse = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.kms}/resource-api/services/create`,
        kmsRequest
      );
      this.saveJson('create-kms-response.json', kmsResponse.data);
      console.log(`   ✓ KMS: ${this.ctx.tenantPath}.${RESOURCES.kms}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ KMS already exists`);
      } else {
        throw error;
      }
    }

    // Create X509 Service
    try {
      const x509Request = { type: 'x509-service', dependencies: [] };
      this.saveJson('create-x509-service-request.json', x509Request);
      const x509Response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Service}/resource-api/services/create`,
        x509Request
      );
      this.saveJson('create-x509-service-response.json', x509Response.data);
      console.log(`   ✓ X509 Service: ${this.ctx.tenantPath}.${RESOURCES.x509Service}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ X509 Service already exists`);
      } else {
        throw error;
      }
    }

    // Create X509 Store
    try {
      const storeRequest = { type: 'x509-store' };
      this.saveJson('create-x509-store-request.json', storeRequest);
      const storeResponse = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}/resource-api/services/create`,
        storeRequest
      );
      this.saveJson('create-x509-store-response.json', storeResponse.data);
      console.log(`   ✓ X509 Store: ${this.ctx.tenantPath}.${RESOURCES.x509Store}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ X509 Store already exists`);
      } else {
        throw error;
      }
    }
  }

  async linkX509Dependencies() {
    this.log('Link X509 service dependencies');

    try {
      await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Service}/x509-service-api/dependencies/add`,
        `${this.ctx.tenantPath}.${RESOURCES.kms}`,
        'text/plain'
      );
      console.log('   ✓ Linked KMS');
    } catch (error: any) {
      if (error.message?.includes('already')) {
        console.log('   ✓ KMS already linked');
      } else {
        throw error;
      }
    }

    try {
      await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Service}/x509-service-api/dependencies/add`,
        `${this.ctx.tenantPath}.${RESOURCES.x509Store}`,
        'text/plain'
      );
      console.log('   ✓ Linked X509 Store');
    } catch (error: any) {
      if (error.message?.includes('already')) {
        console.log('   ✓ X509 Store already linked');
      } else {
        throw error;
      }
    }
  }

  async importKeys() {
    this.log('Import keys');

    const keyFiles = [
      { id: KEY_IDS.vicalIacaKey, file: 'iacakey.json', name: 'IACA key' },
      { id: KEY_IDS.issuerSigningKey, file: 'dskey.json', name: 'Issuer/Document Signer key' },
      { id: KEY_IDS.attesterSigningKey, file: 'attester-key.json', name: 'Attester key' },
      { id: KEY_IDS.vicalSigningKey, file: 'vical-signing-key.json', name: 'VICAL Signing key' },
    ];

    for (const { id, file, name } of keyFiles) {
      try {
        const keyPath = join(__dirname, 'keys', file);
        const keyData = JSON.parse(readFileSync(keyPath, 'utf-8'));
        
        await this.orgClient.post(
          `/v1/${this.ctx.tenantPath}.${RESOURCES.kms}.${id}/kms-service-api/keys/import/jwk`,
          keyData
        );
        console.log(`   ✓ ${name} imported`);
      } catch (error: any) {
        if (error.message?.includes('already exists')) {
          console.log(`   ✓ ${name} already exists`);
        } else {
          throw error;
        }
      }
    }
  }

  async createIacaCertificate() {
    this.log('Create IACA certificate');

    const request = {
      certificateData: {
        country: 'US',
        commonName: 'Journey Test IACA',
        issuerAlternativeNameConf: {
          uri: 'https://journey.example/iaca',
        },
      },
      iacaKeyDesc: {
        type: 'kms-hosted-key-descriptor',
        keyIdPath: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.vicalIacaKey}`,
      },
      vicalEntryComplementaryMetadata: {
        docType: [MDL_DOC_TYPE],
      },
    };

    this.saveJson('create-iaca-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Service}.${CERT_IDS.vicalIacaCert}/x509-service-api/iso/iacas`,
        request
      );
      this.saveJson('create-iaca-response.json', response.data);
      console.log(`   ✓ IACA certificate created`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ IACA certificate already exists`);
      } else {
        throw error;
      }
    }

    // Retrieve PEM
    const certResp = await this.orgClient.get(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
    );
    this.ctx.iacaPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
    console.log(`   ✓ IACA PEM retrieved`);
  }

  async createDocumentSignerCertificate() {
    this.log('Create document signer certificate');

    const request = {
      iacaSigner: {
        type: 'iaca-pem-cert-descriptor',
        iacaPemEncodedCertificate: this.ctx.iacaPem,
        iacaKeyDesc: {
          type: 'kms-hosted-key-descriptor',
          keyIdPath: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.vicalIacaKey}`,
        },
      },
      certificateData: {
        country: 'US',
        commonName: 'Journey Test Document Signer',
        crlDistributionPointUri: 'https://journey.example/crl',
      },
      dsKeyDescriptor: {
        type: 'kms-hosted-key-descriptor',
        keyIdPath: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
      },
    };

    this.saveJson('create-doc-signer-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Service}.${CERT_IDS.docSignerCert}/x509-service-api/iso/document-signers`,
        request
      );
      this.saveJson('create-doc-signer-response.json', response.data);
      console.log(`   ✓ Document signer certificate created`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ Document signer certificate already exists`);
      } else {
        throw error;
      }
    }

    // Retrieve PEM
    const certResp = await this.orgClient.get(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
    );
    this.ctx.docSignerPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
    console.log(`   ✓ Document signer PEM retrieved`);
  }

  async storeVicalSignerCertificate() {
    this.log('Store VICAL signer certificate');

    const certPath = join(__dirname, 'keys', 'vical-signer-cert.pem');
    const certPem = readFileSync(certPath, 'utf-8');

    // Use BASE request, not VICAL entry - VICAL entries are only for IACA certs
    const request = {
      type: 'base',
      certificatePem: certPem,
    };

    this.saveJson('store-vical-signer-cert-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalSignerCert}/x509-store-api/certificates`,
        request
      );
      this.saveJson('store-vical-signer-cert-response.json', response.data);
      console.log(`   ✓ VICAL signer certificate stored`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ VICAL signer certificate already exists`);
      } else {
        throw error;
      }
    }
  }

  async createVicalService() {
    this.log('Create VICAL service');

    const request = {
      type: 'vical-service',
      _id: `${this.ctx.tenantPath}.${RESOURCES.vical}`,
      signingKeyId: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.vicalSigningKey}`,
      signerCertificateId: `${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalSignerCert}`,
      dependencies: [
        `${this.ctx.tenantPath}.${RESOURCES.kms}`,
        `${this.ctx.tenantPath}.${RESOURCES.x509Store}`,
      ],
    };

    this.saveJson('create-vical-service-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.vical}/resource-api/services/create`,
        request
      );
      this.saveJson('create-vical-service-response.json', response.data);
      console.log(`   ✓ VICAL service created`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ VICAL service already exists`);
      } else {
        throw error;
      }
    }
  }

  async publishVical() {
    this.log('Publish VICAL');

    const request = {
      vicalProvider: 'Journey Test VICAL Provider',
    };

    this.saveJson('publish-vical-request.json', request);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.vical}/vical-service-api/publish`,
      request
    );
    this.saveJson('publish-vical-response.json', response.data);

    this.ctx.vicalVersionIdPath = response.data.versionIdPath?.path || response.data.versionIdPath || '';
    const entryCount = response.data.entryCount || 0;

    console.log(`   ✓ VICAL published (version: ${this.ctx.vicalVersionIdPath}, entries: ${entryCount})`);
  }

  async createClientAttester() {
    this.log('Create client attester service');

    const request = {
      type: 'client-attester-service',
      _id: `${this.ctx.tenantPath}.${RESOURCES.clientAttester}`,
      signingKeyId: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.attesterSigningKey}`,
    };

    this.saveJson('create-client-attester-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.clientAttester}/resource-api/services/create`,
        request
      );
      this.saveJson('create-client-attester-response.json', response.data);
      console.log(`   ✓ Client attester created`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ Client attester already exists`);
      } else {
        throw error;
      }
    }

    // Add KMS dependency
    try {
      // Send raw string body (no JSON encoding)
      await this.orgClient.request(
        'POST',
        `/v1/${this.ctx.tenantPath}.${RESOURCES.clientAttester}/client-attester-api/dependencies/add`,
        `${this.ctx.tenantPath}.${RESOURCES.kms}`, // Raw string, no quotes
        'application/json',
        true // skipStringify - send as-is
      );
      console.log(`   ✓ KMS dependency added to client attester`);
    } catch (error: any) {
      if (error.message?.includes('already') || error.message?.includes('not found')) {
        console.log(`   ⚠️  KMS dependency issue (may already be added), continuing...`);
      } else {
        throw error;
      }
    }
  }

  async createIssuer2() {
    this.log('Create issuer2 with client attestation enforcement');

    // Read attester public key
    const attesterKeyPath = join(__dirname, 'keys', 'attester-key.json');
    const attesterKey = JSON.parse(readFileSync(attesterKeyPath, 'utf-8'));
    const attesterPublicJwk = {
      kty: attesterKey.kty,
      crv: attesterKey.crv,
      x: attesterKey.x,
      y: attesterKey.y,
    };

    const request = {
      type: 'issuer2',
      _id: `${this.ctx.tenantPath}.${RESOURCES.issuer2}`,
      tokenKeyId: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
      kms: `${this.ctx.tenantPath}.${RESOURCES.kms}`,
      credentialConfigurations: {
        [MDL_DOC_TYPE]: {
          format: 'mso_mdoc',
          doctype: MDL_DOC_TYPE,
          scope: MDL_DOC_TYPE,
          credentialSigningAlgValuesSupported: [
            { coseValue: -7 },
            { coseValue: -9 },
          ],
          cryptographicBindingMethodsSupported: ['cose_key'],
          proofTypesSupported: {
            jwt: {
              proofSigningAlgValuesSupported: ['ES256'],
            },
          },
        },
      },
      clientAttestationConfig: {
        required: true,
        verificationMethod: {
          type: 'static-jwk',
          jwk: attesterPublicJwk,
        },
        clockSkewSeconds: 300,
        replayWindowSeconds: 300,
      },
    };

    this.saveJson('create-issuer2-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.issuer}/resource-api/services/create`,
        request
      );
      this.saveJson('create-issuer2-response.json', response.data);
      console.log(`   ✓ Issuer2 created with client attestation`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ Issuer2 already exists`);
      } else {
        throw error;
      }
    }

    // Get AS metadata
    const metadataResp = await this.orgClient.get(
      `/.well-known/oauth-authorization-server/v2/${this.ctx.tenantPath}.${RESOURCES.issuer}/issuer-service-api/openid4vci`
    );
    this.saveJson('get-as-metadata-response.json', metadataResp.data);
  }

  async createIssuerProfile() {
    this.log('Create issuer credential profile');

    const ISO_NAMESPACE = 'org.iso.18013.5.1';
    
    const request = {
      name: RESOURCES.issuerProfile,
      credentialConfigurationId: MDL_DOC_TYPE,
      issuerKeyId: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
      x5Chain: [
        {
          type: "pem-encoded-x509-certificate-descriptor",
          pemEncodedCertificate: this.ctx.docSignerPem,
        },
      ],
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
      mDocNameSpacesDataMappingConfig: {
        [ISO_NAMESPACE]: {
          mandatory: [
            'family_name',
            'given_name', 
            'birth_date',
            'issue_date',
            'expiry_date',
            'issuing_country',
            'issuing_authority',
            'document_number',
            'un_distinguishing_sign',
          ],
        },
      },
    };

    this.saveJson('create-issuer-profile-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v2/${this.ctx.tenantPath}.${RESOURCES.issuer}.${RESOURCES.issuerProfile}/issuer-service-api/credentials/profiles`,
        request
      );
      this.saveJson('create-issuer-profile-response.json', response.data);
      console.log(`   ✓ Issuer profile created`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   ✓ Issuer profile already exists`);
      } else {
        throw error;
      }
    }
  }

  async linkWalletToAttester() {
    this.log('Attach client attester dependency to wallet');

    try {
      await this.orgClient.request(
        'POST',
        `/v1/${this.ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/dependencies/add`,
        `${this.ctx.tenantPath}.${RESOURCES.clientAttester}`, // Raw string, no quotes
        'application/json',
        true // skipStringify - send as-is, don't JSON.stringify
      );
      console.log(`   ✓ Client attester linked to wallet`);
    } catch (error: any) {
      if (error.message?.includes('already')) {
        console.log(`   ✓ Client attester already linked`);
      } else {
        throw error;
      }
    }
  }

  async obtainWalletAttestation() {
    this.log('Wallet obtains client attestation');

    const request = {
      clientAttesterServiceRef: `${this.ctx.tenantPath}.${RESOURCES.clientAttester}`,
      instanceKeyReference: this.ctx.walletKeyRef,
    };

    this.saveJson('obtain-wallet-attestation-request.json', request);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/client-attestation/obtain`,
      request
    );
    this.saveJson('obtain-wallet-attestation-response.json', response.data);

    this.ctx.clientAttestationJwt = response.data.clientAttestationJwt;
    const expiresAt = response.data.expiresAt;

    if (!this.ctx.clientAttestationJwt) {
      throw new Error('Wallet did not return clientAttestationJwt');
    }

    console.log(`   ✓ Wallet attestation obtained (expires: ${expiresAt})`);
  }

  async createCredentialOffer() {
    this.log('Create credential offer');

    const request = {
      authMethod: 'PRE_AUTHORIZED',
    };

    this.saveJson('create-credential-offer-request.json', request);

    const response = await this.orgClient.post(
      `/v2/${this.ctx.tenantPath}.${RESOURCES.issuer}.${RESOURCES.issuerProfile}/issuer-service-api/credentials/offers`,
      request
    );
    this.saveJson('create-credential-offer-response.json', response.data);

    this.ctx.offerId = response.data.credentialOffer;

    if (!this.ctx.offerId) {
      throw new Error('Could not extract credentialOffer');
    }

    console.log(`   ✓ Credential offer created`);
  }

  async walletReceiveCredential() {
    this.log('Wallet receive credential via full pre-authorized flow');

    const request = {
      offerUrl: this.ctx.offerId,
      keyReference: this.ctx.walletKeyRef,
      runPolicies: false,
      useClientAttestation: true,
    };

    this.saveJson('wallet-receive-credential-request.json', request);

    const response = await this.orgClient.post(
      `/v2/${this.ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api2/credentials/receive/pre-authorized`,
      request
    );
    this.saveJson('wallet-receive-credential-response.json', response.data);

    const receivedCount = Array.isArray(response.data) ? response.data.length : 0;
    console.log(`   ✓ Credential received (count: ${receivedCount})`);
  }

  async createVerificationSession() {
    this.log('Create verifier2 session with VICAL policy');

    const vicalUrl = `${this.ctx.orgBaseUrl}/v1/${this.ctx.tenantPath}.${RESOURCES.vical}/vical-service-api/latest`;

    const request = {
      core: {
        dcqlQuery: {
          credentials: [
            {
              id: 'my_mdl',
              format: 'mso_mdoc',
              meta: {
                doctype_value: MDL_DOC_TYPE,
              },
              claims: [
                { path: ['org.iso.18013.5.1', 'family_name'] },
                { path: ['org.iso.18013.5.1', 'given_name'] },
                { path: ['org.iso.18013.5.1', 'birth_date'] },
              ],
            },
          ],
        },
        policies: {
          vc_policies: [
            {
              policy: 'VicalPolicy',
              args: {
                vicalUrl: vicalUrl,
                enableDocumentTypeValidation: true,
                enableTrustedChainRoot: true,
              },
            },
          ],
        },
      },
    };

    this.saveJson('create-verification-session-request.json', request);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.verifier2}/verifier2-service-api/verification-session/create`,
      request
    );
    this.saveJson('create-verification-session-response.json', response.data);

    this.ctx.sessionId = response.data.sessionId;
    this.ctx.requestUrl = response.data.bootstrapAuthorizationRequestUrl;

    if (!this.ctx.sessionId || !this.ctx.requestUrl) {
      throw new Error('Could not extract sessionId or bootstrapAuthorizationRequestUrl');
    }

    console.log(`   ✓ Verification session created (ID: ${this.ctx.sessionId})`);
  }

  async walletPresent() {
    this.log('Wallet presents credential');

    const request = {
      requestUrl: this.ctx.requestUrl,
      keyReference: this.ctx.walletKeyRef,
    };

    this.saveJson('wallet-present-request.json', request);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/credentials/present`,
      request
    );
    this.saveJson('wallet-present-response.json', response.data);

    console.log(`   ✓ Credential presented`);
  }

  async assertFinalStatus() {
    this.log('Check verifier2 final session status');

    const response = await this.orgClient.get(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.verifier2}.${this.ctx.sessionId}/verifier2-service-api/verification-session/info`
    );
    this.saveJson('final-session-info.json', response.data);

    const finalStatus = response.data.session?.status;

    if (finalStatus !== 'SUCCESSFUL') {
      throw new Error(`Expected SUCCESSFUL but got: ${finalStatus || '<empty>'}`);
    }

    console.log(`   ✓ Final status: ${finalStatus}`);
  }
}

// Main execution
const config: Config = {
  baseUrl: process.env.BASE_URL || 'http://enterprise.localhost',
  organization: process.env.ORGANIZATION || 'waltid',
  tenant: process.env.TENANT || 'wallet-mdoc-client-attestation',
  email: process.env.EMAIL || 'superadmin@walt.id',
  password: process.env.PASSWORD || 'super123456',
  port: parseInt(process.env.PORT || '3000'),
};

const journey = new CompleteJourney(config);
journey.run().catch((error) => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});
