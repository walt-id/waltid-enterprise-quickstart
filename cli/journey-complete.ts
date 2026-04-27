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
 * 
 * System Init Commands (--init-system):
 * - recreate-db: Recreate all database collections
 * - superadmin-create-account: Create superadmin account from token
 * - init-db: Initialize database
 * - create-organization: Create root organization
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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
  trustRegistryUrl?: string;      // URL of external waltid-trust-registry-service
  useEtsiTrustList?: boolean;     // Enable ETSI Trust List policy in verification
  useEnterpriseTrustRegistry?: boolean;  // Use enterprise trust-registry service instead of external
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
  trustRegistrySourceId?: string;  // ID of the loaded trust source
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
  trustRegistry: 'trust-registry',  // Enterprise trust registry service
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
          console.log(`   [WARN] Resource already exists, continuing...`);
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

  async patch<T = any>(path: string, body?: any): Promise<HttpResponse<T>> {
    return this.request<T>('PATCH', path, body);
  }
}

// ============================================================================
// System Initialization Functions
// ============================================================================

interface SuperadminConfig {
  baseUrl: string;
  port: number;
  superadminToken?: string;
  organization: string;
  adminEmail: string;
  adminPassword: string;
  configDir?: string;
}

interface ParsedSuperadminConfig {
  token: string;
  email: string;
  password: string;
}

/**
 * Parse superadmin-registration.conf file to extract token, email, and password
 */
function parseSuperadminConfig(configPath: string): ParsedSuperadminConfig | null {
  try {
    if (!existsSync(configPath)) {
      return null;
    }
    
    const content = readFileSync(configPath, 'utf-8');
    
    // Extract token (first key in tokens = { "token": ... })
    const tokenMatch = content.match(/tokens\s*=\s*\{\s*"([^"]+)"/);
    const token = tokenMatch ? tokenMatch[1] : null;
    
    // Extract email
    const emailMatch = content.match(/email\s*=\s*"([^"]+)"/);
    const email = emailMatch ? emailMatch[1] : null;
    
    // Extract password
    const passwordMatch = content.match(/password\s*=\s*"([^"]+)"/);
    const password = passwordMatch ? passwordMatch[1] : null;
    
    if (token && email && password) {
      return { token, email, password };
    }
    return null;
  } catch (error) {
    return null;
  }
}

class SystemInit {
  private baseUrl: string;
  private superadminToken: string = '';
  private superadminEmail: string = '';
  private superadminPassword: string = '';
  private superadminAuthToken: string = '';
  private adminBaseUrl: string;  // For admin operations (no org prefix)

  constructor(private config: SuperadminConfig) {
    this.baseUrl = `http://${config.baseUrl}:${config.port}`;
    // Admin URL without organization prefix for /v1/admin/* endpoints
    this.adminBaseUrl = `http://enterprise.localhost:${config.port}`;
    
    // Try to read from superadmin-registration.conf first
    const configDir = config.configDir || join(__dirname, '..', 'config');
    const superadminConfigPath = join(configDir, 'superadmin-registration.conf');
    const parsedConfig = parseSuperadminConfig(superadminConfigPath);
    
    if (parsedConfig) {
      console.log(`   [INFO] Using credentials from: ${superadminConfigPath}`);
      // Use parsed config values, but allow env var overrides
      this.superadminToken = (config.superadminToken && config.superadminToken !== 'replace-me') 
        ? config.superadminToken 
        : parsedConfig.token;
      this.superadminEmail = config.adminEmail || parsedConfig.email;
      this.superadminPassword = config.adminPassword || parsedConfig.password;
    } else {
      // Fallback to provided or default values
      this.superadminToken = config.superadminToken || '1234567890-my-token';
      this.superadminEmail = config.adminEmail || 'superadmin@walt.id';
      this.superadminPassword = config.adminPassword || 'super123456';
    }
  }

  private log(msg: string) {
    console.log(`\n>> ${msg}`);
  }

  /**
   * Recreate all database collections (dev endpoint)
   * WARNING: This deletes all data!
   */
  async recreateDb(): Promise<void> {
    this.log('Recreating database collections');
    
    try {
      const response = await fetch(`${this.adminBaseUrl}/v1/dev/database-recreate`, {
        method: 'POST',
        headers: { 'accept': '*/*' },
      });
      
      if (!response.ok) {
        const text = await response.text();
        console.log(`   [WARN] Database recreate returned ${response.status}: ${text}`);
      } else {
        console.log('   [OK] Database collections recreated');
      }
    } catch (error: any) {
      console.log(`   [WARN] Database recreate failed (may not be in dev mode): ${error.message}`);
    }
  }

  /**
   * Create superadmin account using registration token
   * @returns true if account was created or already exists, false if token not registered
   */
  async createSuperadminAccount(): Promise<boolean> {
    this.log('Creating superadmin account');
    
    const response = await fetch(`${this.baseUrl}/v1/superadmin/create-by-token`, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'Content-Type': 'application/json',
      },
      body: this.superadminToken,  // Send raw token string, not JSON-encoded
    });
    
    const text = await response.text();
    
    if (text.includes('exception') || !response.ok) {
      // Check if account already exists or token already used (that's fine)
      if (text.includes('already') || text.includes('exists') || text.includes('already used')) {
        console.log('   [WARN] Superadmin account already exists');
        return true;
      }
      // Check if token not registered (server needs restart with config)
      if (text.includes('No such token')) {
        console.log('   [ERROR] Token not registered on server');
        return false;
      }
      console.log(`   [WARN] Superadmin account creation returned: ${text}`);
      return false;
    } else {
      console.log('   [OK] Superadmin account created');
      return true;
    }
  }

  /**
   * Login as superadmin to get auth token
   */
  /**
   * Login as superadmin to get auth token
   */
  /**
   * Login as superadmin to get auth token
   */
  async superadminLogin(): Promise<string> {
    const response = await fetch(`${this.adminBaseUrl}/auth/account/emailpass`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: this.superadminEmail,
        password: this.superadminPassword,
      }),
    });
    
    const text = await response.text();
    
    try {
      const data = text ? JSON.parse(text) : {};
      this.superadminAuthToken = data.token || data.accessToken || '';
    } catch {
      console.log(`   [WARN] Superadmin login response: ${text}`);
      this.superadminAuthToken = '';
    }
    
    if (!this.superadminAuthToken) {
      throw new Error(`Failed to get superadmin auth token. Response: ${text}`);
    }
    
    return this.superadminAuthToken;
  }

  /**
   * Initialize database (requires superadmin auth)
   */
  async initDb(): Promise<void> {
    this.log('Initializing database');
    
    if (!this.superadminAuthToken) {
      await this.superadminLogin();
    }
    
    const response = await fetch(`${this.adminBaseUrl}/v1/admin/initial-setup`, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'Authorization': `Bearer ${this.superadminAuthToken}`,
      },
    });
    
    const text = await response.text();
    
    if (text.includes('Unauthorized')) {
      throw new Error('Database initialization failed: Unauthorized');
    }
    
    console.log('   [OK] Database initialized');
  }

  /**
   * Create an organization (requires superadmin auth)
   */
  async createOrganization(orgId?: string): Promise<void> {
    const organization = orgId || this.config.organization;
    this.log(`Creating organization: ${organization}`);
    
    if (!this.superadminAuthToken) {
      await this.superadminLogin();
    }
    
    const response = await fetch(`${this.adminBaseUrl}/v1/admin/organizations`, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'Authorization': `Bearer ${this.superadminAuthToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        _id: organization,
        profile: {
          name: `${organization} Organization`,
        },
      }),
    });
    
    const text = await response.text();
    
    if (text.includes('already') || text.includes('exists') || text.includes('DuplicateTarget')) {
      console.log(`   [WARN] Organization '${organization}' already exists`);
    } else if (text.includes('Unknown host alias')) {
      console.log(`   [WARN] Organization created but host alias not configured`);
      console.log(`          Configure '${organization}.enterprise.localhost' in server settings`);
    } else if (!response.ok) {
      console.log(`   [WARN] Organization creation returned: ${text}`);
    } else {
      console.log(`   [OK] Organization '${organization}' created`);
    }
  }

  /**
   * Create an admin account in the organization
   */
  async createAdminAccount(): Promise<void> {
    this.log(`Creating admin account: ${this.config.adminEmail}`);
    
    if (!this.superadminAuthToken) {
      await this.superadminLogin();
    }
    
    const response = await fetch(`${this.adminBaseUrl}/v1/admin/accounts/create`, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'Authorization': `Bearer ${this.superadminAuthToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        organization: this.config.organization,
        email: this.config.adminEmail,
        password: this.config.adminPassword,
        role: 'admin',
      }),
    });
    
    const text = await response.text();
    
    if (text.includes('already') || text.includes('exists')) {
      console.log(`   [WARN] Admin account already exists`);
    } else if (!response.ok) {
      console.log(`   [WARN] Admin account creation returned: ${text}`);
    } else {
      console.log(`   [OK] Admin account created: ${this.config.adminEmail}`);
    }
  }

  /**
   * Run full system initialization sequence
   */
  async runFullInit(): Promise<void> {
    console.log('[START] System Initialization Started\n');
    console.log('=' .repeat(60));
    
    // Step 1: Recreate DB (optional, for clean slate)
    await this.recreateDb();
    
    // Step 2: Create superadmin account
    const accountCreated = await this.createSuperadminAccount();
    
    if (!accountCreated) {
      console.log('[WARN] Superadmin account could not be created.');
      console.log('   The registration token may not be registered on the server.');
      console.log('\n   To register the token, restart the server with the config file:');
      console.log('   config/superadmin-registration.conf');
      console.log('\n   Then run this command again.');
      console.log('=' .repeat(60));
      return;
    }
    
    // Step 3: Login as superadmin
    try {
      await this.superadminLogin();
      console.log('   [OK] Superadmin logged in');
    } catch (error: any) {
      console.log(`\n[WARN] Could not login as superadmin: ${error.message}`);
      console.log('   Make sure the server has the registration token configured.');
      return;
    }
    
    // Step 4: Initialize database
    await this.initDb();
    
    // Step 5: Create organization
    await this.createOrganization();
    
    // Note: Admin account is the superadmin that was just created
    // No separate admin account creation needed
    
    console.log('\n' + '=' .repeat(60));
    console.log('[SUCCESS] System initialization complete!\n');
  }
}

// ============================================================================
// Journey Runner
// ============================================================================
class CompleteJourney {
  private client: HttpClient;
  private orgClient: HttpClient;
  private trustRegistryClient: HttpClient | null = null;
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
      trustRegistrySourceId: '',
    };

    this.client = new HttpClient(`http://${config.baseUrl}:${config.port}`);
    this.orgClient = new HttpClient(this.ctx.orgBaseUrl!);
    
    // Initialize trust registry client if URL is configured
    if (config.trustRegistryUrl) {
      this.trustRegistryClient = new HttpClient(config.trustRegistryUrl);
    }
  }

  log(message: string) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`\n>> ${message}`);
  }

  saveJson(filename: string, data: any) {
    const path = join(this.ctx.workdir!, filename);
    writeFileSync(path, JSON.stringify(data, null, 2));
  }

  async run() {
    mkdirSync(this.ctx.workdir!, { recursive: true });

    console.log('[START] Complete Journey Test Started');
    console.log(`Working directory: ${this.ctx.workdir}`);
    console.log(`Base URL: ${this.config.baseUrl}:${this.config.port}`);
    console.log(`Organization: ${this.config.organization}`);
    console.log(`Tenant: ${this.config.tenant}`);
    if (this.config.useEtsiTrustList) {
      if (this.config.useEnterpriseTrustRegistry) {
        console.log(`ETSI Trust List: ENABLED (enterprise trust-registry-service)`);
      } else {
        console.log(`ETSI Trust List: ENABLED (external: ${this.config.trustRegistryUrl})`);
      }
    }
    console.log('');

    try {
      await this.login();
      await this.createTenant();
      await this.createWallet();
      
      // Create verifier2 early (without trust registry link) for non-enterprise mode
      // For enterprise mode, we create it later after trust registry is ready
      if (!this.config.useEnterpriseTrustRegistry) {
        await this.createVerifier2();
      }
      
      await this.createServices();
      await this.linkX509Dependencies();
      await this.importKeys();
      await this.createIacaCertificate();
      await this.createDocumentSignerCertificate();
      await this.storeVicalSignerCertificate();
      await this.createVicalService();
      await this.publishVical();
      
      // Setup ETSI Trust Registry if enabled (after IACA cert is created)
      if (this.config.useEtsiTrustList) {
        if (this.config.useEnterpriseTrustRegistry) {
          await this.createEnterpriseTrustRegistry();
          await this.loadTrustSourceIntoEnterpriseRegistry();
          // Now create verifier2 WITH trust registry link
          await this.createVerifier2WithTrustRegistry();
        } else {
          await this.setupEtsiTrustRegistry();
        }
      }
      
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

      console.log('\n[SUCCESS] Complete journey finished successfully!');
      console.log(`\nWorking directory: Results saved in: ${this.ctx.workdir}`);

      // Save HTTP log
      const httpLogPath = join(this.ctx.workdir!, 'http-log.json');
      const allLogs = this.client.getLog().concat(this.orgClient.getLog());
      if (this.trustRegistryClient) {
        allLogs.push(...this.trustRegistryClient.getLog());
      }
      writeFileSync(httpLogPath, JSON.stringify(allLogs, null, 2));
      console.log(`Log saved: HTTP log saved: ${httpLogPath}`);
    } catch (error: any) {
      console.error('\n[ERROR] Journey failed:', error.message);
      // Save HTTP log even on failure
      const httpLogPath = join(this.ctx.workdir!, 'http-log.json');
      const allLogs = this.client.getLog().concat(this.orgClient.getLog());
      if (this.trustRegistryClient) {
        allLogs.push(...this.trustRegistryClient.getLog());
      }
      writeFileSync(httpLogPath, JSON.stringify(allLogs, null, 2));
      console.log(`Log saved: HTTP log saved: ${httpLogPath}`);
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

    console.log('   [OK] Logged in successfully');
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
      console.log(`   [OK] Tenant created: ${this.ctx.tenantPath}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] Tenant already exists: ${this.ctx.tenantPath}`);
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
      console.log(`   [OK] Wallet initialized: ${this.ctx.tenantPath}.${RESOURCES.wallet}`);
    } catch (error: any) {
      if (error.message?.includes('already exists') || error.message?.includes('already initialized')) {
        this.ctx.walletKeyRef = `${this.ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;
        console.log(`   [OK] Wallet already initialized`);
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
      console.log(`   [OK] Verifier2 created: ${this.ctx.tenantPath}.${RESOURCES.verifier2}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] Verifier2 already exists`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Create Verifier2 with Trust Registry link
   * 
   * Creates the verifier2 service with a reference to the trust-registry service,
   * enabling direct service resolution for ETSI Trust List policy.
   */
  async createVerifier2WithTrustRegistry() {
    this.log('Create Verifier2 with Trust Registry link');
    const trustRegistryTarget = `${this.ctx.tenantPath}.${RESOURCES.trustRegistry}`;
    
    const request = {
      type: 'verifier2',
      baseUrl: this.ctx.orgBaseUrl,
      clientId: VERIFIER2_CLIENT_ID,
      trustRegistryService: trustRegistryTarget,
    };

    this.saveJson('create-verifier2-with-trust-registry-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.verifier2}/resource-api/services/create`,
        request
      );
      this.saveJson('create-verifier2-with-trust-registry-response.json', response.data);
      console.log(`   [OK] Verifier2 created with trust registry link: ${trustRegistryTarget}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [WARN] Verifier2 already exists (may not have trust registry link)`);
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
      console.log(`   [OK] KMS: ${this.ctx.tenantPath}.${RESOURCES.kms}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] KMS already exists`);
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
      console.log(`   [OK] X509 Service: ${this.ctx.tenantPath}.${RESOURCES.x509Service}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] X509 Service already exists`);
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
      console.log(`   [OK] X509 Store: ${this.ctx.tenantPath}.${RESOURCES.x509Store}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] X509 Store already exists`);
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
      console.log('   [OK] Linked KMS');
    } catch (error: any) {
      if (error.message?.includes('already')) {
        console.log('   [OK] KMS already linked');
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
      console.log('   [OK] Linked X509 Store');
    } catch (error: any) {
      if (error.message?.includes('already')) {
        console.log('   [OK] X509 Store already linked');
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
        console.log(`   [OK] ${name} imported`);
      } catch (error: any) {
        if (error.message?.includes('already exists')) {
          console.log(`   [OK] ${name} already exists`);
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
      console.log(`   [OK] IACA certificate created`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] IACA certificate already exists`);
      } else {
        throw error;
      }
    }

    // Retrieve PEM
    const certResp = await this.orgClient.get(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
    );
    this.ctx.iacaPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
    console.log(`   [OK] IACA PEM retrieved`);
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
      console.log(`   [OK] Document signer certificate created`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] Document signer certificate already exists`);
      } else {
        throw error;
      }
    }

    // Retrieve PEM
    const certResp = await this.orgClient.get(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
    );
    this.ctx.docSignerPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
    console.log(`   [OK] Document signer PEM retrieved`);
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
      console.log(`   [OK] VICAL signer certificate stored`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] VICAL signer certificate already exists`);
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
      console.log(`   [OK] VICAL service created`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] VICAL service already exists`);
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

    console.log(`   [OK] VICAL published (version: ${this.ctx.vicalVersionIdPath}, entries: ${entryCount})`);
  }

  /**
   * Setup ETSI Trust Registry with the IACA certificate
   * 
   * This creates a LoTE (List of Trusted Entities) source in the trust-registry-service
   * containing the IACA certificate used in this journey, allowing the etsi-trust-list
   * policy to validate the credential's issuer certificate chain.
   */
  async setupEtsiTrustRegistry() {
    this.log('Setup ETSI Trust Registry');

    if (!this.trustRegistryClient) {
      throw new Error('Trust registry client not configured. Set TRUST_REGISTRY_URL environment variable.');
    }

    if (!this.ctx.iacaPem) {
      throw new Error('IACA certificate not available. Run createIacaCertificate() first.');
    }

    // Compute SHA-256 fingerprint of the IACA certificate for the trust list
    // We'll use a simple approach - extract the base64 DER and compute hash
    const iacaDerBase64 = this.ctx.iacaPem!
      .replace('-----BEGIN CERTIFICATE-----', '')
      .replace('-----END CERTIFICATE-----', '')
      .replace(/\s/g, '');
    
    // For the hash, we'll just use a placeholder that the trust registry will compute
    // The trust registry accepts PEM and extracts the fingerprint internally
    const sourceId = `journey-test-${Date.now()}`;
    
    // Create a LoTE-format JSON source with the IACA certificate
    const loteSource = {
      listMetadata: {
        listId: sourceId,
        listType: 'mdl-issuers',
        territory: 'US',
        issueDate: new Date().toISOString(),
        nextUpdate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year
        sequenceNumber: '1',
      },
      trustedEntities: [
        {
          entityId: 'journey-test-iaca',
          entityType: 'PID_PROVIDER', // Using PID_PROVIDER as a general issuer type
          legalName: 'Journey Test IACA',
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
                  value: this.ctx.iacaPem,
                },
              ],
            },
          ],
        },
      ],
    };

    this.saveJson('etsi-trust-registry-lote-source.json', loteSource);

    // Load the source into the trust registry
    const loadRequest = {
      sourceId: sourceId,
      content: JSON.stringify(loteSource),
      sourceUrl: 'local://journey-test',
    };

    this.saveJson('etsi-trust-registry-load-request.json', loadRequest);

    try {
      const response = await this.trustRegistryClient.post(
        '/trust-registry/sources/load',
        loadRequest
      );
      this.saveJson('etsi-trust-registry-load-response.json', response.data);

      if (!response.data.success) {
        throw new Error(`Trust registry load failed: ${response.data.error || 'unknown error'}`);
      }

      this.ctx.trustRegistrySourceId = sourceId;
      console.log(`   [OK] Trust source loaded: ${sourceId}`);
      console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
      console.log(`        Services: ${response.data.servicesLoaded || 0}`);
      console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
    } catch (error: any) {
      console.error(`   [ERROR] Failed to load trust source: ${error.message}`);
      throw error;
    }

    // Verify the source was loaded by listing sources
    try {
      const sourcesResponse = await this.trustRegistryClient.get('/trust-registry/sources');
      this.saveJson('etsi-trust-registry-sources.json', sourcesResponse.data);
      console.log(`   [OK] Trust registry now has ${sourcesResponse.data.length || 0} source(s)`);
    } catch (error: any) {
      console.log(`   [WARN] Could not list sources: ${error.message}`);
    }
  }

  /**
   * Create Enterprise Trust Registry Service
   * 
   * Creates the trust-registry-service in the enterprise stack that will
   * hold trust lists and resolve certificate trust.
   */
  async createEnterpriseTrustRegistry() {
    this.log('Create Enterprise Trust Registry Service');

    const request = {
      type: 'trust-registry-service',
      _id: `${this.ctx.tenantPath}.${RESOURCES.trustRegistry}`,
      validateSignaturesByDefault: false,  // For testing, skip signature validation
      autoRefreshIntervalSeconds: 0,       // No auto-refresh for tests
    };

    this.saveJson('create-enterprise-trust-registry-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.trustRegistry}/resource-api/services/create`,
        request
      );
      this.saveJson('create-enterprise-trust-registry-response.json', response.data);
      console.log(`   [OK] Enterprise Trust Registry created: ${this.ctx.tenantPath}.${RESOURCES.trustRegistry}`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] Enterprise Trust Registry already exists`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Load trust source into Enterprise Trust Registry
   * 
   * Creates a LoTE (List of Trusted Entities) source containing the IACA
   * certificate used in this journey, allowing the etsi-trust-list policy
   * to validate the credential's issuer certificate chain.
   */
  async loadTrustSourceIntoEnterpriseRegistry() {
    this.log('Load trust source into Enterprise Trust Registry');

    if (!this.ctx.iacaPem) {
      throw new Error('IACA certificate not available. Run createIacaCertificate() first.');
    }

    const sourceId = `journey-test-${Date.now()}`;
    
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
          legalName: 'Journey Test IACA',
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
                  value: this.ctx.iacaPem,
                },
              ],
            },
          ],
        },
      ],
    };

    this.saveJson('enterprise-trust-registry-lote-source.json', loteSource);

    // Load via enterprise API
    const loadRequest = {
      sourceId: sourceId,
      content: JSON.stringify(loteSource),
      sourceUrl: 'local://journey-test',
      validateSignature: false,  // Demo source, no signature
    };

    this.saveJson('enterprise-trust-registry-load-request.json', loadRequest);

    try {
      const response = await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources/load`,
        loadRequest
      );
      this.saveJson('enterprise-trust-registry-load-response.json', response.data);

      if (!response.data.success) {
        throw new Error(`Enterprise trust registry load failed: ${response.data.error || 'unknown error'}`);
      }

      this.ctx.trustRegistrySourceId = sourceId;
      console.log(`   [OK] Trust source loaded into enterprise registry: ${sourceId}`);
      console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
      console.log(`        Services: ${response.data.servicesLoaded || 0}`);
      console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
    } catch (error: any) {
      console.error(`   [ERROR] Failed to load trust source: ${error.message}`);
      throw error;
    }

    // Verify by listing sources
    try {
      const sourcesResponse = await this.orgClient.get(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources`
      );
      this.saveJson('enterprise-trust-registry-sources.json', sourcesResponse.data);
      console.log(`   [OK] Enterprise trust registry now has ${sourcesResponse.data?.length || 0} source(s)`);
    } catch (error: any) {
      console.log(`   [WARN] Could not list enterprise sources: ${error.message}`);
    }
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
      console.log(`   [OK] Client attester created`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] Client attester already exists`);
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
      console.log(`   [OK] KMS dependency added to client attester`);
    } catch (error: any) {
      if (error.message?.includes('already') || error.message?.includes('not found')) {
        console.log(`   [WARN] KMS dependency issue (may already be added), continuing...`);
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
      _id: `${this.ctx.tenantPath}.${RESOURCES.issuer}`,
      tokenKeyId: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
      kms: `${this.ctx.tenantPath}.${RESOURCES.kms}`,
      credentialConfigurations: {
        [MDL_DOC_TYPE]: {
          format: 'mso_mdoc',
          doctype: MDL_DOC_TYPE,
          scope: MDL_DOC_TYPE,
          credential_signing_alg_values_supported: [
            -7,
            -9
          ],
          cryptographic_binding_methods_supported: ['cose_key'],
          proof_types_supported: {
            jwt: {
              proof_signing_alg_values_supported: ["ES256"]
            }
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
      console.log(`   [OK] Issuer2 created with client attestation`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] Issuer2 already exists`);
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
    
    // Build the full x5c chain: [Document Signer (leaf), IACA (root)]
    // This allows verifiers to validate the chain and check trust anchors
    const x5Chain = [
      {
        type: "pem-encoded-x509-certificate-descriptor",
        pemEncodedCertificate: this.ctx.docSignerPem,
      },
    ];
    
    // Add IACA cert if available (makes the chain complete for trust list verification)
    if (this.ctx.iacaPem) {
      x5Chain.push({
        type: "pem-encoded-x509-certificate-descriptor",
        pemEncodedCertificate: this.ctx.iacaPem,
      });
    }
    
    const request = {
      name: RESOURCES.issuerProfile,
      credentialConfigurationId: MDL_DOC_TYPE,
      issuerKeyId: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
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
      // mDocNameSpacesDataMappingConfig is optional - omit for now
    };

    this.saveJson('create-issuer-profile-request.json', request);

    try {
      const response = await this.orgClient.post(
        `/v2/${this.ctx.tenantPath}.${RESOURCES.issuer}.${RESOURCES.issuerProfile}/issuer-service-api/credentials/profiles`,
        request
      );
      this.saveJson('create-issuer-profile-response.json', response.data);
      console.log(`   [OK] Issuer profile created`);
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log(`   [OK] Issuer profile already exists`);
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
      console.log(`   [OK] Client attester linked to wallet`);
    } catch (error: any) {
      if (error.message?.includes('already')) {
        console.log(`   [OK] Client attester already linked`);
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

    console.log(`   [OK] Wallet attestation obtained (expires: ${expiresAt})`);
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

    console.log(`   [OK] Credential offer created`);
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
    console.log(`   [OK] Credential received (count: ${receivedCount})`);
  }

  async createVerificationSession() {
    let policiesDescription = 'VICAL policy';
    if (this.config.useEtsiTrustList) {
      policiesDescription = this.config.useEnterpriseTrustRegistry 
        ? 'VICAL + ETSI Trust List (Enterprise Registry)' 
        : 'VICAL + ETSI Trust List policies';
    }
    this.log(`Create verifier2 session with ${policiesDescription}`);

    const vicalUrl = `${this.ctx.orgBaseUrl}/v1/${this.ctx.tenantPath}.${RESOURCES.vical}/vical-service-api/latest`;

    // Build the policies array
    const vcPolicies: any[] = [
      {
        "policy": "signature"
      },
      {
        "policy": "vical",
        "vicalUrl": vicalUrl,
        "enableDocumentTypeValidation": true,
        "enableTrustedChainRoot": true
      },
    ];

    // Add ETSI Trust List policy if enabled
    if (this.config.useEtsiTrustList) {
      if (this.config.useEnterpriseTrustRegistry) {
        // Enterprise mode: no trustRegistryUrl needed!
        // The verifier2 service is linked to the trust-registry service,
        // and the ETSITrustListPolicy will use the enterprise resolver.
        vcPolicies.push({
          "policy": "etsi-trust-list",
          // No trustRegistryUrl - uses enterprise service via internal resolution
          "expectedEntityType": "PID_PROVIDER",
          "allowStaleSource": true,
          "requireAuthenticated": false
        });
        console.log(`   [INFO] ETSI Trust List policy added (enterprise service via internal resolution)`);
      } else if (this.config.trustRegistryUrl) {
        // External service mode
        vcPolicies.push({
          "policy": "etsi-trust-list",
          "trustRegistryUrl": this.config.trustRegistryUrl,
          "expectedEntityType": "PID_PROVIDER",
          "allowStaleSource": true,
          "requireAuthenticated": false
        });
        console.log(`   [INFO] ETSI Trust List policy added (external registry: ${this.config.trustRegistryUrl})`);
      }
    }

    const request = {
      flow_type: "cross_device",
      core_flow: {
        dcql_query: {
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
          vc_policies: vcPolicies,
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

    console.log(`   [OK] Verification session created (ID: ${this.ctx.sessionId})`);
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

    console.log(`   [OK] Credential presented`);
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

    console.log(`   [OK] Final status: ${finalStatus}`);
  }
}

/**
 * Import a trust list file into the Enterprise Trust Registry.
 * 
 * This standalone function allows importing trust lists (TSL XML, LoTE JSON, PILOT)
 * into an existing trust-registry service in the enterprise stack.
 * 
 * @param config - Configuration with baseUrl, organization, tenant, etc.
 * @param filePath - Path to the trust list file
 */
async function importTrustListFromFile(config: Config, filePath: string): Promise<void> {
  console.log('\n=== Import Trust List into Enterprise Trust Registry ===\n');
  
  // Check if file exists
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }
  
  // Read file content
  const content = readFileSync(filePath, 'utf-8');
  const fileName = filePath.split('/').pop() || 'unknown';
  const isXml = content.trim().startsWith('<') || fileName.endsWith('.xml');
  const isJson = content.trim().startsWith('{') || content.trim().startsWith('[') || fileName.endsWith('.json');
  
  console.log(`File: ${filePath}`);
  console.log(`Format: ${isXml ? 'XML (TSL/PILOT)' : isJson ? 'JSON (LoTE)' : 'Unknown'}`);
  console.log(`Size: ${content.length} bytes`);
  
  // Create HTTP client
  const baseUrl = `http://${config.organization}.${config.baseUrl}:${config.port}`;
  const tenantPath = `${config.organization}.${config.tenant}`;
  
  console.log(`\nTarget: ${baseUrl}`);
  console.log(`Tenant: ${tenantPath}`);
  console.log(`Service: ${RESOURCES.trustRegistry}`);
  
  // Login first
  console.log('\n>> Authenticating...');
  
  const loginResponse = await fetch(`${baseUrl}/auth/account/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  
  if (!loginResponse.ok) {
    console.error(`Authentication failed: ${loginResponse.status} ${loginResponse.statusText}`);
    process.exit(1);
  }
  
  const loginData = await loginResponse.json() as { token?: string; accessToken?: string; data?: { token?: string } };
  const token = loginData.token || loginData.accessToken || loginData.data?.token;
  
  if (!token) {
    console.error('No token received from login');
    process.exit(1);
  }
  
  console.log('   [OK] Authenticated');
  
  // Generate source ID from filename
  const sourceId = fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9-_]/g, '-');
  
  // Determine if we should load from URL or content
  // For local files, we load via content
  const loadRequest: {
    sourceId: string;
    content?: string;
    url?: string;
    validateSignature: boolean;
  } = {
    sourceId: sourceId,
    content: content,
    validateSignature: false,  // Local files typically aren't signed
  };
  
  console.log(`\n>> Loading trust source: ${sourceId}`);
  
  const loadResponse = await fetch(
    `${baseUrl}/v1/${tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources/load`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(loadRequest),
    }
  );
  
  if (!loadResponse.ok) {
    const errorText = await loadResponse.text();
    console.error(`\n[ERROR] Failed to load trust source: ${loadResponse.status}`);
    console.error(errorText);
    process.exit(1);
  }
  
  const loadData = await loadResponse.json() as {
    success?: boolean;
    sourceId?: string;
    entitiesLoaded?: number;
    servicesLoaded?: number;
    identitiesLoaded?: number;
    error?: string;
  };
  
  if (!loadData.success) {
    console.error(`\n[ERROR] Trust source load failed: ${loadData.error || 'unknown error'}`);
    process.exit(1);
  }
  
  console.log(`   [OK] Trust source loaded successfully!`);
  console.log(`\n   Source ID: ${loadData.sourceId || sourceId}`);
  console.log(`   Entities:  ${loadData.entitiesLoaded || 0}`);
  console.log(`   Services:  ${loadData.servicesLoaded || 0}`);
  console.log(`   Identities: ${loadData.identitiesLoaded || 0}`);
  
  // List all sources to confirm
  console.log('\n>> Verifying loaded sources...');
  
  const sourcesResponse = await fetch(
    `${baseUrl}/v1/${tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources`,
    {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }
  );
  
  if (sourcesResponse.ok) {
    const sources = await sourcesResponse.json() as Array<{ sourceId: string; displayName?: string; entitiesCount?: number }>;
    console.log(`   [OK] Trust registry now has ${sources.length} source(s):`);
    for (const src of sources) {
      console.log(`        - ${src.sourceId}${src.displayName ? ` (${src.displayName})` : ''}`);
    }
  }
  
  console.log('\n[SUCCESS] Trust list imported successfully!\n');
}

// Main execution
const config: Config = {
  baseUrl: process.env.BASE_URL || 'enterprise.localhost',
  organization: process.env.ORGANIZATION || 'waltid',
  tenant: process.env.TENANT || 'wallet-mdoc-client-attestation',
  email: process.env.EMAIL || 'superadmin@walt.id',
  password: process.env.PASSWORD || 'super123456',
  port: parseInt(process.env.PORT || '3000'),
  trustRegistryUrl: process.env.TRUST_REGISTRY_URL || 'http://127.0.0.1:7005',
  useEtsiTrustList: false,           // Set via --etsi-trust-lists flag
  useEnterpriseTrustRegistry: false, // Set via --enterprise-trust-registry flag
};

const systemConfig: SuperadminConfig = {
  baseUrl: `${config.organization}.enterprise.localhost`,
  port: config.port,
  superadminToken: process.env.SUPERADMIN_TOKEN || 'replace-me',
  organization: config.organization,
  adminEmail: config.email,
  adminPassword: config.password,
};

// Parse command line arguments
const args = process.argv.slice(2);

async function main() {
  // Handle system init commands
  if (args.includes('--recreate-db')) {
    const init = new SystemInit(systemConfig);
    await init.recreateDb();
    console.log('\n[SUCCESS] Database recreated');
    return;
  }
  
  if (args.includes('--init-db')) {
    const init = new SystemInit(systemConfig);
    await init.createSuperadminAccount();
    await init.initDb();
    return;
  }
  
  if (args.includes('--create-superadmin')) {
    const init = new SystemInit(systemConfig);
    await init.createSuperadminAccount();
    return;
  }
  
  if (args.includes('--create-organization')) {
    const init = new SystemInit(systemConfig);
    await init.createSuperadminAccount();
    await init.createOrganization();
    return;
  }
  
  if (args.includes('--init-system') || args.includes('--full-init')) {
    const init = new SystemInit(systemConfig);
    await init.runFullInit();
    return;
  }
  
  // Handle --import-trust-list command
  const importTrustListIndex = args.findIndex(arg => arg === '--import-trust-list');
  if (importTrustListIndex !== -1) {
    const filePath = args[importTrustListIndex + 1];
    if (!filePath) {
      console.error('Error: --import-trust-list requires a file path argument');
      console.error('Usage: npx tsx journey-complete.ts --import-trust-list <path-to-trust-list-file>');
      process.exit(1);
    }
    
    await importTrustListFromFile(config, filePath);
    return;
  }
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: npx tsx journey-complete.ts [options]

System Init Options:
  --recreate-db         Recreate all database collections (WARNING: deletes all data!)
  --create-superadmin   Create superadmin account from token
  --init-db             Initialize database (runs initial-setup)
  --create-organization Create the configured organization
  --init-system         Run full system initialization sequence:
                        recreate-db -> create-superadmin -> init-db -> create-organization
  --full-init           Alias for --init-system

Trust Registry Commands:
  --import-trust-list <file>
                        Import a trust list file into the Enterprise Trust Registry.
                        Supports TSL XML, LoTE JSON, and PILOT formats.
                        The trust-registry service must already exist in the tenant.
                        Example: --import-trust-list /path/to/trust_list.xml

Journey Test Options:
  (no options)          Run the complete mDoc + Client Attestation + VICAL journey
  --etsi-trust-lists    Enable ETSI Trust List verification policy using external service:
                        1. Loads IACA certificate into waltid-trust-registry-service
                        2. Adds etsi-trust-list policy to verification session
                        Requires TRUST_REGISTRY_URL to be set or default (http://127.0.0.1:7005)
  --enterprise-trust-registry
                        Use Enterprise Trust Registry Service instead of external:
                        1. Creates trust-registry-service in the enterprise stack
                        2. Loads IACA certificate into enterprise service
                        3. Adds etsi-trust-list policy pointing to enterprise service
                        (Implies --etsi-trust-lists, no external service needed)

Environment Variables:
  BASE_URL              Enterprise stack base URL (default: enterprise.localhost)
  PORT                  Port number (default: 3000)
  ORGANIZATION          Organization ID (default: waltid)
  TENANT                Tenant ID (default: wallet-mdoc-client-attestation)
  EMAIL                 Admin email (default: superadmin@walt.id)
  PASSWORD              Admin password (default: super123456)
  SUPERADMIN_TOKEN      Superadmin registration token
  TRUST_REGISTRY_URL    URL of external waltid-trust-registry-service (default: http://127.0.0.1:7005)

Examples:
  # Full system init (clean slate)
  npx tsx journey-complete.ts --init-system

  # Just recreate the database
  npx tsx journey-complete.ts --recreate-db

  # Run the journey test (basic - VICAL only)
  npx tsx journey-complete.ts

  # Run with ETSI Trust List verification (external service)
  npx tsx journey-complete.ts --etsi-trust-lists

  # Run with ETSI Trust List verification (enterprise service - no external deps)
  npx tsx journey-complete.ts --enterprise-trust-registry

  # Import a trust list file into enterprise trust registry
  npx tsx journey-complete.ts --import-trust-list ./samples/trust_list.xml

  # Run with custom external trust registry URL
  TRUST_REGISTRY_URL=http://localhost:8080 npx tsx journey-complete.ts --etsi-trust-lists

  # Run with custom organization
  ORGANIZATION=myorg npx tsx journey-complete.ts --init-system
`);
    return;
  }
  
  // Check for Enterprise Trust Registry flag (implies ETSI Trust List)
  if (args.includes('--enterprise-trust-registry')) {
    config.useEtsiTrustList = true;
    config.useEnterpriseTrustRegistry = true;
    console.log('[CONFIG] ETSI Trust List verification ENABLED (Enterprise Registry)');
    console.log('         Using enterprise trust-registry-service (no external service needed)');
  }
  // Check for ETSI Trust List flag (external service)
  else if (args.includes('--etsi-trust-lists')) {
    config.useEtsiTrustList = true;
    console.log('[CONFIG] ETSI Trust List verification ENABLED (External Service)');
    console.log(`         Trust Registry URL: ${config.trustRegistryUrl}`);
  }
  
  // Default: run the journey test
  const journey = new CompleteJourney(config);
  await journey.run();
}

main().catch((error) => {
  console.error('\nFatal error: Fatal error:', error);
  process.exit(1);
});
