#!/usr/bin/env node
/**
 * walt.ts - walt.id Enterprise Stack CLI Tool
 * 
 * A comprehensive CLI for setting up and running use cases against the walt.id Enterprise stack.
 * 
 * Usage:
 *   npx tsx walt.ts                    # Full setup + primary use case
 *   npx tsx walt.ts --recreate         # Recreate DB and setup from scratch
 *   npx tsx walt.ts --setup-all        # Run all setup commands
 *   npx tsx walt.ts --run-all          # Run primary use case (issue + verify)
 *   npx tsx walt.ts --setup-<command>  # Run specific setup command
 *   npx tsx walt.ts --run-<command>    # Run specific run command
 *   npx tsx walt.ts --flow-<name>      # Run a specific flow
 * 
 * Environment Variables:
 *   BASE_URL              Enterprise stack base URL (default: enterprise.localhost)
 *   PORT                  Port number (default: 3000)
 *   ORGANIZATION          Organization ID (default: waltid)
 *   TENANT                Tenant ID (default: <organization>-tenant01)
 *   EMAIL                 Superadmin email (from config/superadmin-registration.conf)
 *   PASSWORD              Superadmin password (from config/superadmin-registration.conf)
 *   ADMIN_EMAIL           Admin user email (default: admin@walt.id)
 *   ADMIN_PASSWORD        Admin user password (default: admin123456)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Superadmin Config Reader
// ============================================================================

interface SuperadminCredentials {
  token: string;
  email: string;
  password: string;
}

function readSuperadminConfig(): SuperadminCredentials {
  const configPath = join(__dirname, '..', 'config', 'superadmin-registration.conf');
  
  const defaults: SuperadminCredentials = {
    token: '',
    email: '',
    password: '',
  };
  
  if (!existsSync(configPath)) {
    return defaults;
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    
    // Extract token (first key in tokens = { "token": ... })
    const tokenMatch = content.match(/tokens\s*=\s*\{\s*"([^"]+)"/);
    if (tokenMatch) defaults.token = tokenMatch[1];
    
    // Extract email
    const emailMatch = content.match(/email\s*=\s*"([^"]+)"/);
    if (emailMatch) defaults.email = emailMatch[1];
    
    // Extract password
    const passwordMatch = content.match(/password\s*=\s*"([^"]+)"/);
    if (passwordMatch) defaults.password = passwordMatch[1];
    
    return defaults;
  } catch {
    return defaults;
  }
}

// Read superadmin config early (before config object is created)
const superadminCreds = readSuperadminConfig();

// ============================================================================
// Configuration
// ============================================================================

interface Config {
  baseUrl: string;
  organization: string;
  tenant: string;
  email: string;
  password: string;
  port: number;
  superadminToken: string;
  // Admin user (non-superadmin)
  adminEmail: string;
  adminPassword: string;
}

interface WaltContext {
  token: string;
  workdir: string;
  tenantPath: string;
  orgBaseUrl: string;
  stepCounter: number;
  
  // Admin user state
  adminUserId: string;
  adminToken: string;
  
  // Service state
  walletKeyRef: string;
  iacaPem: string;
  docSignerPem: string;
  clientAttestationJwt: string;
  vicalVersionIdPath: string;
  
  // Run state
  offerId: string;
  sessionId: string;
  requestUrl: string;
  trustRegistrySourceId: string;
}

// Resource names
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
  trustRegistry: 'trust-registry',
  credentialStore: 'credentialstore',
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
const VERIFIER2_CLIENT_ID = 'walt-cli-verifier';

// ============================================================================
// HTTP Client
// ============================================================================

interface HttpResponse<T = any> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

class HttpClient {
  private baseUrl: string;
  private token: string | null = null;
  private httpLog: Array<{ request: any; response: any; timestamp: string }> = [];

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setToken(token: string) {
    this.token = token;
  }

  getHttpLog() {
    return this.httpLog;
  }

  private async request<T>(method: string, path: string, body?: any, contentType: string = 'application/json', skipStringify: boolean = false): Promise<HttpResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const requestLog = {
      method,
      url,
      headers: { ...headers, Authorization: headers.Authorization ? '[REDACTED]' : undefined },
      body,
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body) {
      if (skipStringify) {
        options.body = body;
      } else if (contentType === 'application/json') {
        options.body = JSON.stringify(body);
      } else {
        options.body = body;
      }
    }

    const response = await fetch(url, options);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let data: T;
    const responseContentType = response.headers.get('content-type');
    if (responseContentType?.includes('application/json')) {
      data = await response.json() as T;
    } else {
      data = await response.text() as unknown as T;
    }

    const responseLog = {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data,
    };

    this.httpLog.push({
      request: requestLog,
      response: responseLog,
      timestamp: new Date().toISOString(),
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${response.statusText}`) as any;
      error.status = response.status;
      error.response = { data, headers: responseHeaders };
      throw error;
    }

    return {
      status: response.status,
      data,
      headers: responseHeaders,
    };
  }

  async get<T = any>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path);
  }

  async post<T = any>(path: string, body?: any, contentType: string = 'application/json'): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, contentType);
  }

  async postRaw<T = any>(path: string, body: string, contentType: string = 'application/json'): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, contentType, true);
  }

  async patch<T = any>(path: string, body?: any): Promise<HttpResponse<T>> {
    return this.request<T>('PATCH', path, body);
  }

  async put<T = any>(path: string, body?: any): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', path, body);
  }

  async delete<T = any>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', path);
  }
}

// ============================================================================
// Setup Commands (create resources)
// ============================================================================

const SETUP_COMMANDS = [
  'login',
  'create-tenant',
  'create-wallet',
  'create-verifier2',
  'create-services',
  'link-x509-dependencies',
  'import-keys',
  'create-iaca-certificate',
  'create-document-signer-certificate',
  'store-vical-signer-certificate',
  'create-vical-service',
  'publish-vical',
  'create-client-attester',
  'create-issuer2',
  'create-issuer-profile',
  'link-wallet-to-attester',
  'obtain-wallet-attestation',
] as const;

// ============================================================================
// Run Commands (execute use cases)
// ============================================================================

const RUN_COMMANDS = [
  'create-credential-offer',
  'wallet-receive-credential',
  'create-verification-session',
  'wallet-present',
  'assert-final-status',
] as const;

// ============================================================================
// Additional Commands (not in main flow)
// ============================================================================

const ADDITIONAL_SETUP_COMMANDS = [
  'create-trust-registry',
  'import-trust-list',
] as const;

// ============================================================================
// Flows (special use case flows)
// ============================================================================

const FLOWS = [
  'etsi-trust-lists',
  'credential-revocation',
] as const;

type SetupCommand = typeof SETUP_COMMANDS[number];
type RunCommand = typeof RUN_COMMANDS[number];
type AdditionalSetupCommand = typeof ADDITIONAL_SETUP_COMMANDS[number];
type Flow = typeof FLOWS[number];

// ============================================================================
// Walt CLI Class
// ============================================================================

class WaltCLI {
  private config: Config;
  private ctx: WaltContext;
  private client: HttpClient;
  private orgClient: HttpClient;
  private systemClient: HttpClient;
  private adminClient: HttpClient;

  constructor(config: Config) {
    this.config = config;
    
    // Build URLs properly (handle https, no port, etc.)
    const clientUrl = buildBaseUrl(config.baseUrl, config.port);
    const orgUrl = buildOrgUrl(config.baseUrl, config.organization, config.port);
    
    // Generate workdir name with date and count
    const date = new Date().toISOString().split('T')[0];
    const existingDirs = existsSync(process.cwd()) 
      ? readdirSync(process.cwd()).filter(d => d.startsWith(`walt-log-${date}`))
      : [];
    const count = existingDirs.length + 1;
    
    this.ctx = {
      workdir: join(process.cwd(), `walt-log-${date}-${String(count).padStart(3, '0')}`),
      tenantPath: `${config.organization}.${config.tenant}`,
      orgBaseUrl: orgUrl,
      token: '',
      stepCounter: 0,
      adminUserId: '',
      adminToken: '',
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

    this.client = new HttpClient(clientUrl);
    this.orgClient = new HttpClient(orgUrl);
    this.systemClient = new HttpClient(orgUrl);
    // Admin client - for remote deployments, use the base URL without org prefix
    this.adminClient = new HttpClient(clientUrl);
    
    // Log configuration for debugging
    console.log(`\n[CONFIG] Base URL: ${clientUrl}`);
    console.log(`[CONFIG] Org URL: ${orgUrl}`);
    console.log(`[CONFIG] Organization: ${config.organization}`);
    console.log(`[CONFIG] Tenant: ${config.tenant}`);
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  private log(message: string, prefix?: string) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const prefixStr = prefix ? `[${prefix}] ` : '';
    console.log(`\n${prefixStr}>> ${message}`);
  }

  private nextStep(): string {
    this.ctx.stepCounter++;
    return String(this.ctx.stepCounter).padStart(3, '0');
  }

  private saveJson(filename: string, data: any, stepNum?: string) {
    mkdirSync(this.ctx.workdir, { recursive: true });
    const prefix = stepNum || String(this.ctx.stepCounter).padStart(3, '0');
    const path = join(this.ctx.workdir, `${prefix}-${filename}`);
    writeFileSync(path, JSON.stringify(data, null, 2));
  }

  private saveHttpLog() {
    mkdirSync(this.ctx.workdir, { recursive: true });
    const combinedLog = [
      ...this.client.getHttpLog(),
      ...this.orgClient.getHttpLog(),
      ...this.systemClient.getHttpLog(),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    
    writeFileSync(
      join(this.ctx.workdir, 'walt-http-log.json'),
      JSON.stringify(combinedLog, null, 2)
    );
  }

  private loadKeyFile(filename: string): any {
    const keyPath = join(__dirname, 'keys', filename);
    return JSON.parse(readFileSync(keyPath, 'utf-8'));
  }

  private async tolerantCreate<T>(
    operation: string,
    createFn: () => Promise<T>,
    checkFn?: () => Promise<boolean>
  ): Promise<{ created: boolean; result?: T }> {
    try {
      if (checkFn) {
        const exists = await checkFn().catch(() => false);
        if (exists) {
          console.log(`   [SKIP] ${operation} already exists`);
          return { created: false };
        }
      }
      const result = await createFn();
      return { created: true, result };
    } catch (error: any) {
      if (error.status === 409 || error.message?.includes('already exists') || 
          error.response?.data?.message?.includes('already exists')) {
        console.log(`   [SKIP] ${operation} already exists`);
        return { created: false };
      }
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // System Init Commands
  // --------------------------------------------------------------------------

  async recreateDb(): Promise<void> {
    this.log('Recreating database', 'SYSTEM');
    
    // Use adminClient's base URL for dev endpoints
    const adminUrl = buildBaseUrl(this.config.baseUrl, this.config.port);
    
    try {
      const response = await fetch(`${adminUrl}/v1/dev/database-recreate`, {
        method: 'POST',
        headers: { 'accept': '*/*' },
      });
      
      if (!response.ok) {
        const text = await response.text();
        console.log(`   [WARN] Database recreate returned ${response.status}: ${text}`);
      } else {
        console.log(`   [OK] Database recreated`);
      }
    } catch (error: any) {
      console.log(`   [WARN] Database recreate failed: ${error.message}`);
      if (error.cause) {
        console.log(`   [CAUSE] ${error.cause.message || error.cause}`);
      }
    }
  }

  async createSuperadminAccount(): Promise<boolean> {
    this.log('Creating superadmin account', 'SYSTEM');
    
    // Credentials are read from config/superadmin-registration.conf at startup
    const token = this.config.superadminToken;
    
    if (!token) {
      console.log('   [ERROR] No superadmin token found. Check config/superadmin-registration.conf');
      return false;
    }
    
    console.log('   [INFO] Using credentials from: config/superadmin-registration.conf');
    
    try {
      const orgUrl = buildOrgUrl(this.config.baseUrl, this.config.organization, this.config.port);
      const response = await fetch(`${orgUrl}/v1/superadmin/create-by-token`, {
        method: 'POST',
        headers: {
          'accept': '*/*',
          'Content-Type': 'application/json',
        },
        body: token,  // Send raw token string
      });
      
      const text = await response.text();
      
      if (text.includes('exception') || !response.ok) {
        if (text.includes('already') || text.includes('exists')) {
          console.log(`   [SKIP] Superadmin account already exists`);
          return true;
        }
        console.log(`   [WARN] Superadmin account creation returned: ${text}`);
        return false;
      }
      
      console.log(`   [OK] Superadmin account created`);
      return true;
    } catch (error: any) {
      console.log(`   [WARN] Superadmin account creation failed: ${error.message}`);
      if (error.cause) {
        console.log(`   [CAUSE] ${error.cause.message || error.cause}`);
      }
      return false;
    }
  }

  async initDb(): Promise<void> {
    this.log('Initializing database', 'SYSTEM');
    
    const adminUrl = buildBaseUrl(this.config.baseUrl, this.config.port);
    
    // Login as superadmin first
    const loginResponse = await fetch(`${adminUrl}/auth/account/emailpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });
    
    const loginData = await loginResponse.json() as { token?: string };
    const token = loginData.token;
    
    if (!token) {
      throw new Error('Could not get superadmin token for database init');
    }
    
    const initResponse = await fetch(`${adminUrl}/v1/admin/initial-setup`, {
      method: 'POST',
      headers: { 
        'accept': '*/*',
        'Authorization': `Bearer ${token}`,
      },
    });
    
    if (!initResponse.ok) {
      const text = await initResponse.text();
      console.log(`   [WARN] Database init returned ${initResponse.status}: ${text}`);
    } else {
      console.log(`   [OK] Database initialized`);
    }
  }

  async createOrganization(): Promise<void> {
    this.log(`Creating organization: ${this.config.organization}`, 'SYSTEM');
    
    const adminUrl = buildBaseUrl(this.config.baseUrl, this.config.port);
    
    // Login as superadmin first
    const loginResponse = await fetch(`${adminUrl}/auth/account/emailpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });
    
    const loginData = await loginResponse.json() as { token?: string };
    const token = loginData.token;
    
    if (!token) {
      throw new Error('Could not get superadmin token for organization creation');
    }
    
    const response = await fetch(`${adminUrl}/v1/admin/organizations`, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        _id: this.config.organization,
        profile: {
          name: `${this.config.organization} Organization`,
        },
      }),
    });
    
    const text = await response.text();
    
    if (text.includes('already') || text.includes('exists') || text.includes('DuplicateTarget')) {
      console.log(`   [SKIP] Organization '${this.config.organization}' already exists`);
    } else if (text.includes('Unknown host alias')) {
      console.log(`   [WARN] Organization created but host alias not configured`);
      console.log(`          Configure '${this.config.organization}.<domain>' in server settings`);
    } else if (!response.ok) {
      console.log(`   [WARN] Organization creation returned ${response.status}: ${text}`);
    } else {
      console.log(`   [OK] Organization '${this.config.organization}' created`);
    }
  }

  async setupCreateAdminRole(): Promise<void> {
    // Note: The admin role is auto-created when the organization is created.
    // This method checks if it exists and reports status.
    this.log('Checking admin role', 'SETUP');
    
    const roleId = `${this.config.organization}.admin`;
    console.log(`   [INFO] Admin role '${roleId}' is auto-created with organization`);
    console.log(`   [OK] Admin role exists`);
  }

  async setupCreateAdminAccount(): Promise<void> {
    this.log('Creating admin account', 'SETUP');
    
    const adminUrl = buildBaseUrl(this.config.baseUrl, this.config.port);
    
    // Login as superadmin first
    const loginResponse = await fetch(`${adminUrl}/auth/account/emailpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.config.email, password: this.config.password }),
    });
    
    const loginData = await loginResponse.json() as { token?: string };
    const superadminToken = loginData.token;
    
    if (!superadminToken) {
      throw new Error('Could not get superadmin token for account creation');
    }
    
    // Create the admin user account
    const createUserResponse = await fetch(`${adminUrl}/v1/admin/account/register`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'Authorization': `Bearer ${superadminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profile: {
          name: 'Admin User',
          email: this.config.adminEmail,
          addressCountry: 'AT',
          address: 'Vienna, Austria',
        },
        preferences: {
          timeZone: 'UTC',
          languagePreference: 'EN',
        },
        initialAuth: {
          type: 'email',
          identifier: {
            type: 'email',
            email: this.config.adminEmail,
          },
          data: {
            type: 'email',
            password: this.config.adminPassword,
          },
        },
      }),
    });
    
    const createUserText = await createUserResponse.text();
    let userId: string | null = null;
    
    if (createUserText.includes('already') || createUserText.includes('exists') || createUserText.includes('Duplicate')) {
      console.log(`   [SKIP] Admin account '${this.config.adminEmail}' already exists`);
      // Try to get the user ID from existing accounts
      const listResponse = await fetch(`${adminUrl}/v1/admin/accounts`, {
        headers: { 'Authorization': `Bearer ${superadminToken}` },
      });
      const accounts = await listResponse.json() as Array<{ _id: string; profile?: { email?: string } }>;
      const existingUser = accounts.find((a: any) => a.profile?.email === this.config.adminEmail);
      if (existingUser) {
        userId = existingUser._id;
      }
    } else if (!createUserResponse.ok) {
      console.log(`   [WARN] Account creation returned ${createUserResponse.status}: ${createUserText}`);
    } else {
      console.log(`   [OK] Admin account '${this.config.adminEmail}' created`);
      try {
        const userData = JSON.parse(createUserText);
        userId = userData._id;
      } catch {
        // Try regex extraction
        const match = createUserText.match(/"_id":\s*"([^"]+)"/);
        if (match) userId = match[1];
      }
    }
    
    if (!userId) {
      console.log('   [WARN] Could not determine user ID, skipping role assignment');
      return;
    }
    
    this.ctx.adminUserId = userId;
    console.log(`   [INFO] Admin user ID: ${userId}`);
    
    // Now add the admin role to the user
    const roleId = `${this.config.organization}.admin`;
    const addRoleResponse = await fetch(
      `${adminUrl}/v1/admin/account/${userId}/roles/add/${this.config.organization}/${roleId}`,
      {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${superadminToken}`,
        },
      }
    );
    
    const addRoleText = await addRoleResponse.text();
    
    if (addRoleText.includes('already') || addRoleText === '{}') {
      console.log(`   [SKIP] Role '${roleId}' already assigned to user`);
    } else if (!addRoleResponse.ok) {
      console.log(`   [WARN] Role assignment returned ${addRoleResponse.status}: ${addRoleText}`);
    } else {
      console.log(`   [OK] Role '${roleId}' assigned to admin user`);
    }
  }

  async setupLoginAs(email?: string, password?: string): Promise<void> {
    const step = this.nextStep();
    const loginEmail = email || this.config.email;
    const loginPassword = password || this.config.password;
    
    this.log(`Login as: ${loginEmail}`, 'SETUP');
    
    const request = {
      email: loginEmail,
      password: loginPassword,
    };
    this.saveJson('login-request.json', request, step);

    const response = await this.client.post('/auth/account/emailpass', request);
    this.saveJson('login-response.json', response.data, step);

    const token = response.data.token || response.data.accessToken || response.data.data?.token;
    if (!token) {
      throw new Error('Could not extract bearer token from login response');
    }

    // Store admin token if logging in as admin user
    if (loginEmail === this.config.adminEmail) {
      this.ctx.adminToken = token;
    }
    this.ctx.token = token;

    this.client.setToken(token);
    this.orgClient.setToken(token);

    console.log(`   [OK] Logged in as ${loginEmail}`);
  }

  async setupLoginAsAdmin(): Promise<void> {
    await this.setupLoginAs(this.config.adminEmail, this.config.adminPassword);
  }

  async runSystemInit(): Promise<void> {
    await this.recreateDb();
    await this.createSuperadminAccount();
    await this.initDb();
    await this.createOrganization();
    await this.setupCreateAdminRole();
    await this.setupCreateAdminAccount();
    console.log('\n[SYSTEM] System initialization complete');
  }

  // --------------------------------------------------------------------------
  // Setup Commands
  // --------------------------------------------------------------------------

  async setupLogin(email?: string, password?: string): Promise<void> {
    const step = this.nextStep();
    // Default to admin credentials if available, otherwise superadmin
    const loginEmail = email || this.config.adminEmail || this.config.email;
    const loginPassword = password || this.config.adminPassword || this.config.password;
    
    this.log(`Login as: ${loginEmail}`, 'SETUP');
    
    const request = {
      email: loginEmail,
      password: loginPassword,
    };
    this.saveJson('login-request.json', request, step);

    const response = await this.client.post('/auth/account/emailpass', request);
    this.saveJson('login-response.json', response.data, step);

    this.ctx.token = response.data.token || response.data.accessToken || response.data.data?.token;
    if (!this.ctx.token) {
      throw new Error('Could not extract bearer token from login response');
    }

    this.client.setToken(this.ctx.token);
    this.orgClient.setToken(this.ctx.token);

    console.log(`   [OK] Logged in as ${loginEmail}`);
  }

  async setupCreateTenant(): Promise<void> {
    const step = this.nextStep();
    this.log(`Create tenant: ${this.config.tenant}`, 'SETUP');
    
    const { created } = await this.tolerantCreate(
      `Tenant ${this.config.tenant}`,
      async () => {
        const request = { name: `Tenant ${this.config.tenant}` };
        this.saveJson('create-tenant-request.json', request, step);
        
        const response = await this.orgClient.post(
          `/v1/${this.ctx.tenantPath}/resource-api/tenants/create`,
          request
        );
        this.saveJson('create-tenant-response.json', response.data, step);
        return response;
      }
    );
    
    if (created) {
      console.log(`   [OK] Tenant created: ${this.config.tenant}`);
    }
  }

  async setupCreateWallet(): Promise<void> {
    const step = this.nextStep();
    this.log('Initialize wallet', 'SETUP');
    
    const { created } = await this.tolerantCreate(
      'Wallet',
      async () => {
        const request = {
          createKeyInKms: {
            keyType: 'secp256r1',
          },
        };
        this.saveJson('init-wallet-request.json', request, step);

        const response = await this.orgClient.post(
          `/v1/${this.ctx.tenantPath}/wallet-service-api/init-wallet`,
          request
        );
        this.saveJson('init-wallet-response.json', response.data, step);
        return response;
      }
    );

    // Set wallet key reference
    this.ctx.walletKeyRef = `${this.ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;

    if (created) {
      console.log(`   [OK] Wallet initialized`);
    }
  }

  async setupCreateVerifier2(): Promise<void> {
    const step = this.nextStep();
    this.log('Create verifier2 service', 'SETUP');
    
    const { created } = await this.tolerantCreate(
      'Verifier2 service',
      async () => {
        const request = {
          type: 'verifier2',
          baseUrl: this.ctx.orgBaseUrl,
          clientId: 'verifier2-client',
        };
        this.saveJson('create-verifier2-request.json', request, step);

        const response = await this.orgClient.post(
          `/v1/${this.ctx.tenantPath}.${RESOURCES.verifier2}/resource-api/services/create`,
          request
        );
        this.saveJson('create-verifier2-response.json', response.data, step);
        return response;
      }
    );

    if (created) {
      console.log(`   [OK] Verifier2 created`);
    }
  }

  async setupCreateServices(): Promise<void> {
    const step = this.nextStep();
    this.log('Create KMS, X509 Service, X509 Store', 'SETUP');

    const services = [
      { name: RESOURCES.kms, type: 'kms' },
      { name: RESOURCES.x509Service, type: 'x509-service' },
      { name: RESOURCES.x509Store, type: 'x509-store' },
    ];

    for (const svc of services) {
      const { created } = await this.tolerantCreate(
        `${svc.name} service`,
        async () => {
          const request = { type: svc.type };
          const response = await this.orgClient.post(
            `/v1/${this.ctx.tenantPath}.${svc.name}/resource-api/services/create`,
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

  async setupLinkX509Dependencies(): Promise<void> {
    const step = this.nextStep();
    this.log('Link X509 dependencies', 'SETUP');

    // Link KMS to x509-service
    try {
      await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Service}/x509-service-api/dependencies/add`,
        `${this.ctx.tenantPath}.${RESOURCES.kms}`,
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
      await this.orgClient.post(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Service}/x509-service-api/dependencies/add`,
        `${this.ctx.tenantPath}.${RESOURCES.x509Store}`,
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

  async setupImportKeys(): Promise<void> {
    const step = this.nextStep();
    this.log('Import keys', 'SETUP');

    const keys = [
      { id: KEY_IDS.vicalIacaKey, file: 'iacakey.json', name: 'IACA key' },
      { id: KEY_IDS.issuerSigningKey, file: 'dskey.json', name: 'Issuer/Document Signer key' },
      { id: KEY_IDS.attesterSigningKey, file: 'attester-key.json', name: 'Attester key' },
      { id: KEY_IDS.vicalSigningKey, file: 'vical-signing-key.json', name: 'VICAL Signing key' },
    ];

    for (const key of keys) {
      const { created } = await this.tolerantCreate(
        `Key ${key.name}`,
        async () => {
          const jwk = this.loadKeyFile(key.file);
          
          const response = await this.orgClient.post(
            `/v1/${this.ctx.tenantPath}.${RESOURCES.kms}.${key.id}/kms-service-api/keys/import/jwk`,
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

  async setupCreateIacaCertificate(): Promise<void> {
    const step = this.nextStep();
    this.log('Create IACA certificate', 'SETUP');

    // Check if certificate already exists
    try {
      const existing = await this.orgClient.get(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
      );
      if (existing.data) {
        this.ctx.iacaPem = existing.data.data?.pem || existing.data.certificatePem || existing.data.pem;
        console.log(`   [SKIP] IACA certificate already exists`);
        return;
      }
    } catch (e) {
      // Certificate doesn't exist, create it
    }

    const request = {
      certificateData: {
        country: 'US',
        commonName: 'Walt CLI Test IACA',
        issuerAlternativeNameConf: {
          uri: 'https://walt-cli.example/iaca',
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
    this.saveJson('create-iaca-cert-request.json', request, step);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Service}.${CERT_IDS.vicalIacaCert}/x509-service-api/iso/iacas`,
      request
    );
    this.saveJson('create-iaca-cert-response.json', response.data, step);

    // Retrieve PEM
    const certResp = await this.orgClient.get(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
    );
    this.ctx.iacaPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
    
    console.log(`   [OK] IACA certificate created`);
  }

  async setupCreateDocumentSignerCertificate(): Promise<void> {
    const step = this.nextStep();
    this.log('Create document signer certificate', 'SETUP');

    // Check if certificate already exists
    try {
      const existing = await this.orgClient.get(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
      );
      if (existing.data) {
        this.ctx.docSignerPem = existing.data.data?.pem || existing.data.certificatePem || existing.data.pem;
        console.log(`   [SKIP] Document signer certificate already exists`);
        return;
      }
    } catch (e) {
      // Certificate doesn't exist, create it
    }

    // Ensure we have IACA PEM
    if (!this.ctx.iacaPem) {
      try {
        const certResponse = await this.orgClient.get(
          `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
        );
        this.ctx.iacaPem = certResponse.data.data?.pem || certResponse.data.certificatePem || certResponse.data.pem;
      } catch (e) {
        throw new Error('IACA certificate not found. Run setup-create-iaca-certificate first.');
      }
    }

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
        commonName: 'Walt CLI Document Signer',
        crlDistributionPointUri: 'https://walt-cli.example/crl',
      },
      dsKeyDescriptor: {
        type: 'kms-hosted-key-descriptor',
        keyIdPath: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
      },
    };
    this.saveJson('create-doc-signer-cert-request.json', request, step);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Service}.${CERT_IDS.docSignerCert}/x509-service-api/iso/document-signers`,
      request
    );
    this.saveJson('create-doc-signer-cert-response.json', response.data, step);

    // Retrieve PEM
    const certResp = await this.orgClient.get(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
    );
    this.ctx.docSignerPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
    
    console.log(`   [OK] Document signer certificate created`);
  }

  async setupStoreVicalSignerCertificate(): Promise<void> {
    const step = this.nextStep();
    this.log('Store VICAL signer certificate', 'SETUP');

    const { created } = await this.tolerantCreate(
      'VICAL signer certificate',
      async () => {
        const certPem = readFileSync(join(__dirname, 'keys', 'vical-signer-cert.pem'), 'utf-8');
        const request = {
          type: 'base',
          certificatePem: certPem,
        };
        this.saveJson('store-vical-signer-cert-request.json', request, step);

        const response = await this.orgClient.post(
          `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalSignerCert}/x509-store-api/certificates`,
          request
        );
        this.saveJson('store-vical-signer-cert-response.json', response.data, step);
        return response;
      }
    );

    if (created) {
      console.log(`   [OK] VICAL signer certificate stored`);
    }
  }

  async setupCreateVicalService(): Promise<void> {
    const step = this.nextStep();
    this.log('Create VICAL service', 'SETUP');

    const { created } = await this.tolerantCreate(
      'VICAL service',
      async () => {
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
        this.saveJson('create-vical-service-request.json', request, step);

        const response = await this.orgClient.post(
          `/v1/${this.ctx.tenantPath}.${RESOURCES.vical}/resource-api/services/create`,
          request
        );
        this.saveJson('create-vical-service-response.json', response.data, step);
        return response;
      }
    );

    if (created) {
      console.log(`   [OK] VICAL service created`);
    }
  }

  async setupPublishVical(): Promise<void> {
    const step = this.nextStep();
    this.log('Publish VICAL', 'SETUP');

    const request = {
      vicalProvider: 'Walt CLI VICAL Provider',
    };
    this.saveJson('publish-vical-request.json', request, step);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.vical}/vical-service-api/publish`,
      request
    );
    this.saveJson('publish-vical-response.json', response.data, step);

    this.ctx.vicalVersionIdPath = response.data.versionIdPath?.path || response.data.versionIdPath || '';
    const entryCount = response.data.entryCount || 0;
    
    console.log(`   [OK] VICAL published (version: ${this.ctx.vicalVersionIdPath}, entries: ${entryCount})`);
  }

  async setupCreateClientAttester(): Promise<void> {
    const step = this.nextStep();
    this.log('Create client attester service', 'SETUP');

    const { created } = await this.tolerantCreate(
      'Client attester service',
      async () => {
        const request = {
          type: 'client-attester',
          _id: `${this.ctx.tenantPath}.${RESOURCES.clientAttester}`,
          signingKeyId: `${this.ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.attesterSigningKey}`,
        };
        this.saveJson('create-client-attester-request.json', request, step);

        const response = await this.orgClient.post(
          `/v1/${this.ctx.tenantPath}.${RESOURCES.clientAttester}/resource-api/services/create`,
          request
        );
        this.saveJson('create-client-attester-response.json', response.data, step);
        return response;
      }
    );

    if (created) {
      console.log(`   [OK] Client attester created`);
    }

    // Add KMS dependency
    try {
      await this.orgClient.postRaw(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.clientAttester}/client-attester-api/dependencies/add`,
        `${this.ctx.tenantPath}.${RESOURCES.kms}`
      );
      console.log(`   [OK] KMS dependency added to client attester`);
    } catch (error: any) {
      if (error.status !== 409 && !error.message?.includes('already')) {
        console.log(`   [WARN] KMS dependency issue, continuing...`);
      }
    }
  }

  async setupCreateIssuer2(): Promise<void> {
    const step = this.nextStep();
    this.log('Create issuer2 with client attestation enforcement', 'SETUP');

    const { created } = await this.tolerantCreate(
      'Issuer2 service',
      async () => {
        // Read attester public key
        const attesterKey = this.loadKeyFile('attester-key.json');
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
              credential_signing_alg_values_supported: [-7, -9],
              cryptographic_binding_methods_supported: ['cose_key'],
              proof_types_supported: {
                jwt: {
                  proof_signing_alg_values_supported: ['ES256'],
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
        this.saveJson('create-issuer2-request.json', request, step);

        const response = await this.orgClient.post(
          `/v1/${this.ctx.tenantPath}.${RESOURCES.issuer}/resource-api/services/create`,
          request
        );
        this.saveJson('create-issuer2-response.json', response.data, step);
        return response;
      }
    );

    if (created) {
      console.log(`   [OK] Issuer2 created with client attestation`);
    }
  }

  async setupCreateIssuerProfile(): Promise<void> {
    const step = this.nextStep();
    this.log('Create issuer credential profile', 'SETUP');

    const { created } = await this.tolerantCreate(
      'Issuer profile',
      async () => {
        const ISO_NAMESPACE = 'org.iso.18013.5.1';
        
        // Ensure we have certificates
        if (!this.ctx.docSignerPem) {
          try {
            const certResponse = await this.orgClient.get(
              `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
            );
            this.ctx.docSignerPem = certResponse.data.data?.pem || certResponse.data.certificatePem || certResponse.data.pem;
          } catch (e) {
            throw new Error('Document signer certificate not found. Run setup-create-document-signer-certificate first.');
          }
        }
        
        if (!this.ctx.iacaPem) {
          try {
            const certResponse = await this.orgClient.get(
              `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
            );
            this.ctx.iacaPem = certResponse.data.data?.pem || certResponse.data.certificatePem || certResponse.data.pem;
          } catch (e) {
            // IACA cert is optional for the chain
          }
        }

        // Build the full x5c chain: [Document Signer (leaf), IACA (root)]
        const x5Chain: Array<{ type: string; pemEncodedCertificate: string }> = [
          {
            type: 'pem-encoded-x509-certificate-descriptor',
            pemEncodedCertificate: this.ctx.docSignerPem,
          },
        ];
        
        if (this.ctx.iacaPem) {
          x5Chain.push({
            type: 'pem-encoded-x509-certificate-descriptor',
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
        };
        this.saveJson('create-issuer-profile-request.json', request, step);

        const response = await this.orgClient.post(
          `/v2/${this.ctx.tenantPath}.${RESOURCES.issuer}.${RESOURCES.issuerProfile}/issuer-service-api/credentials/profiles`,
          request
        );
        this.saveJson('create-issuer-profile-response.json', response.data, step);
        return response;
      }
    );

    if (created) {
      console.log(`   [OK] Issuer profile created`);
    }
  }

  async setupLinkWalletToAttester(): Promise<void> {
    const step = this.nextStep();
    this.log('Attach client attester dependency to wallet', 'SETUP');

    try {
      await this.orgClient.postRaw(
        `/v1/${this.ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/dependencies/add`,
        `${this.ctx.tenantPath}.${RESOURCES.clientAttester}`
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

  async setupObtainWalletAttestation(): Promise<void> {
    const step = this.nextStep();
    this.log('Wallet obtains client attestation', 'SETUP');

    const request = {
      clientAttesterServiceRef: `${this.ctx.tenantPath}.${RESOURCES.clientAttester}`,
      instanceKeyReference: this.ctx.walletKeyRef,
    };
    this.saveJson('obtain-attestation-request.json', request, step);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/client-attestation/obtain`,
      request
    );
    this.saveJson('obtain-attestation-response.json', response.data, step);

    this.ctx.clientAttestationJwt = response.data.clientAttestationJwt;
    if (!this.ctx.clientAttestationJwt) {
      throw new Error('Wallet did not return clientAttestationJwt');
    }
    
    console.log(`   [OK] Wallet attestation obtained (expires: ${response.data.expiresAt || 'unknown'})`);
  }

  // --------------------------------------------------------------------------
  // Run Commands (use case execution)
  // --------------------------------------------------------------------------

  async runCreateCredentialOffer(): Promise<void> {
    const step = this.nextStep();
    this.log('Create credential offer', 'RUN');

    const request = {
      authMethod: 'PRE_AUTHORIZED',
    };
    this.saveJson('create-offer-request.json', request, step);

    const response = await this.orgClient.post(
      `/v2/${this.ctx.tenantPath}.${RESOURCES.issuer}.${RESOURCES.issuerProfile}/issuer-service-api/credentials/offers`,
      request
    );
    this.saveJson('create-offer-response.json', response.data, step);

    this.ctx.offerId = response.data.credentialOffer;
    if (!this.ctx.offerId) {
      throw new Error('Could not extract credentialOffer');
    }
    
    console.log(`   [OK] Credential offer created`);
  }

  async runWalletReceiveCredential(): Promise<void> {
    const step = this.nextStep();
    this.log('Wallet receive credential via full pre-authorized flow', 'RUN');

    const request = {
      offerUrl: this.ctx.offerId,
      keyReference: this.ctx.walletKeyRef,
      runPolicies: false,
      useClientAttestation: true,
    };
    this.saveJson('wallet-receive-request.json', request, step);

    const response = await this.orgClient.post(
      `/v2/${this.ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api2/credentials/receive/pre-authorized`,
      request
    );
    this.saveJson('wallet-receive-response.json', response.data, step);

    const receivedCount = Array.isArray(response.data) ? response.data.length : 0;
    console.log(`   [OK] Credential received (count: ${receivedCount})`);
  }

  async runCreateVerificationSession(): Promise<void> {
    const step = this.nextStep();
    this.log('Create verifier2 session', 'RUN');

    const vicalUrl = `${this.ctx.orgBaseUrl}/v1/${this.ctx.tenantPath}.${RESOURCES.vical}/vical-service-api/latest`;

    const vcPolicies = [
      { policy: 'signature' },
      {
        policy: 'vical',
        vicalUrl: vicalUrl,
        enableDocumentTypeValidation: true,
        enableTrustedChainRoot: true,
      },
    ];

    const request = {
      flow_type: 'cross_device',
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
    this.saveJson('create-verification-session-request.json', request, step);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.verifier2}/verifier2-service-api/verification-session/create`,
      request
    );
    this.saveJson('create-verification-session-response.json', response.data, step);

    this.ctx.sessionId = response.data.sessionId;
    this.ctx.requestUrl = response.data.bootstrapAuthorizationRequestUrl;

    if (!this.ctx.sessionId || !this.ctx.requestUrl) {
      throw new Error('Could not extract sessionId or bootstrapAuthorizationRequestUrl');
    }

    console.log(`   [OK] Verification session created (ID: ${this.ctx.sessionId})`);
  }

  async runWalletPresent(): Promise<void> {
    const step = this.nextStep();
    this.log('Wallet presents credential', 'RUN');

    const request = {
      requestUrl: this.ctx.requestUrl,
      keyReference: this.ctx.walletKeyRef,
    };
    this.saveJson('wallet-present-request.json', request, step);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/credentials/present`,
      request
    );
    this.saveJson('wallet-present-response.json', response.data, step);

    console.log(`   [OK] Credential presented`);
  }

  async runAssertFinalStatus(): Promise<void> {
    const step = this.nextStep();
    this.log('Check verifier2 final session status', 'RUN');

    const response = await this.orgClient.get(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.verifier2}.${this.ctx.sessionId}/verifier2-service-api/verification-session/info`
    );
    this.saveJson('final-session-info.json', response.data, step);

    const finalStatus = response.data.session?.status;

    if (finalStatus !== 'SUCCESSFUL') {
      throw new Error(`Expected SUCCESSFUL but got: ${finalStatus || '<empty>'}`);
    }

    console.log(`   [OK] Final status: ${finalStatus}`);
  }

  // --------------------------------------------------------------------------
  // Additional Setup Commands
  // --------------------------------------------------------------------------

  async setupCreateTrustRegistry(): Promise<void> {
    const step = this.nextStep();
    this.log('Create trust registry service', 'SETUP');

    const { created } = await this.tolerantCreate(
      'Trust registry service',
      async () => {
        const request = {
          type: 'trust-registry'
        };
        this.saveJson('create-trust-registry-request.json', request, step);

        const response = await this.orgClient.post(
          `/v1/${this.ctx.tenantPath}.${RESOURCES.trustRegistry}/resource-api/services/create`,
          request
        );
        this.saveJson('create-trust-registry-response.json', response.data, step);
        return response;
      }
    );

    if (created) {
      console.log(`   [OK] Trust registry created`);
    }
  }

  async setupImportTrustList(filePath: string): Promise<void> {
    const step = this.nextStep();
    this.log(`Import trust list: ${basename(filePath)}`, 'SETUP');

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
    this.saveJson('import-trust-list-request.json', request, step);

    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources/load`,
      request
    );
    this.saveJson('import-trust-list-response.json', response.data, step);

    this.ctx.trustRegistrySourceId = sourceId;
    console.log(`   [OK] Trust list imported: ${sourceId}`);
    console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
    console.log(`        Services: ${response.data.servicesLoaded || 0}`);
    console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
  }

  // --------------------------------------------------------------------------
  // Flows (special use case flows)
  // --------------------------------------------------------------------------

  /**
   * Flow: ETSI Trust Lists
   * 
   * Demonstrates trust list verification using the Enterprise Trust Registry Service.
   * This flow assumes the primary setup has been run (tenant, wallet, credentials exist).
   * 
   * Steps:
   * 1. Create trust registry service (if not exists)
   * 2. Import public trust lists from URLs (TSL XML, LoTE JSON, PILOT formats)
   * 3. Create a local trust source with our IACA certificate
   * 4. Create verification session with etsi-trust-list policy
   * 5. Present credential and verify against trust registry
   */
  async flowEtsiTrustLists(): Promise<void> {
    console.log('\n========================================');
    console.log('  Flow: ETSI Trust Lists');
    console.log('========================================\n');
    console.log(`Organization: ${this.config.organization}`);
    console.log(`Tenant: ${this.config.tenant}`);
    console.log(`Working directory: ${this.ctx.workdir}`);
    
    mkdirSync(this.ctx.workdir, { recursive: true });
    
    try {
      // Login first
      await this.setupLogin();
      
      // Set wallet key reference if not already set
      if (!this.ctx.walletKeyRef) {
        this.ctx.walletKeyRef = `${this.ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;
      }
      
      // Step 1: Create trust registry service
      console.log('\n--- Step 1: Create Trust Registry Service ---');
      await this.setupCreateTrustRegistry();
      
      // Step 2: Link Verifier2 to Trust Registry
      console.log('\n--- Step 2: Link Verifier2 to Trust Registry ---');
      await this.flowLinkVerifier2ToTrustRegistry();
      
      // Step 3: Import public trust lists from URLs
      console.log('\n--- Step 3: Import Public Trust Lists ---');
      await this.flowImportPublicTrustLists();
      
      // Step 4: Load our IACA certificate into trust registry
      console.log('\n--- Step 4: Load Local IACA Certificate ---');
      await this.flowLoadIacaIntoTrustRegistry();
      
      // Step 5: List loaded trust sources
      console.log('\n--- Step 5: List Trust Sources ---');
      await this.flowListTrustSources();
      
      // Step 6: Create verification session with etsi-trust-list policy
      console.log('\n--- Step 6: Create Verification Session with ETSI Trust List Policy ---');
      await this.flowCreateEtsiVerificationSession();
      
      // Step 7: Wallet presents credential
      console.log('\n--- Step 7: Present Credential ---');
      await this.runWalletPresent();
      
      // Step 8: Assert success
      console.log('\n--- Step 8: Verify Result ---');
      await this.runAssertFinalStatus();
      
      console.log('\n========================================');
      console.log('  SUCCESS - ETSI Trust Lists Flow Complete');
      console.log('========================================\n');
    } finally {
      this.saveHttpLog();
      console.log(`Logs saved to: ${this.ctx.workdir}`);
    }
  }

  /**
   * Link the Verifier2 service to the Trust Registry service.
   * This allows the etsi-trust-list policy to resolve certificates against the enterprise registry.
   */
  async flowLinkVerifier2ToTrustRegistry(): Promise<void> {
    const step = this.nextStep();
    this.log('Link Verifier2 to Trust Registry', 'FLOW');
    
    const trustRegistryTarget = `${this.ctx.tenantPath}.${RESOURCES.trustRegistry}`;
    const verifier2Target = `${this.ctx.tenantPath}.${RESOURCES.verifier2}`;
    
    // First, get current verifier2 configuration
    const currentConfig = await this.orgClient.get(
      `/v1/${verifier2Target}/verifier2-service-api/configuration/view`
    );
    this.saveJson('verifier2-config-before.json', currentConfig.data, step);
    
    // Check if already linked
    if (currentConfig.data.trustRegistryService === trustRegistryTarget) {
      console.log(`   [SKIP] Verifier2 already linked to trust registry`);
      return;
    }
    
    // Update configuration with trust registry link
    const updatedConfig = {
      ...currentConfig.data,
      trustRegistryService: trustRegistryTarget,
    };
    this.saveJson('verifier2-config-update-request.json', updatedConfig, step);
    
    try {
      await this.orgClient.put(
        `/v1/${verifier2Target}/verifier2-service-api/configuration/update`,
        updatedConfig
      );
      console.log(`   [OK] Verifier2 linked to trust registry: ${trustRegistryTarget}`);
    } catch (error: any) {
      console.log(`   [WARN] Failed to update verifier2 config: ${error.message}`);
      throw error;
    }
    
    // Verify the update
    const verifyConfig = await this.orgClient.get(
      `/v1/${verifier2Target}/verifier2-service-api/configuration/view`
    );
    this.saveJson('verifier2-config-after.json', verifyConfig.data, step);
    
    if (verifyConfig.data.trustRegistryService !== trustRegistryTarget) {
      throw new Error('Trust registry link was not persisted');
    }
    console.log(`   [OK] Link verified`);
  }

  /**
   * Import public trust lists from well-known URLs.
   * Demonstrates loading different trust list formats:
   * - TSL XML (ETSI TS 119 612) - Austrian TSL (with signature validation for authenticated demo)
   * - LoTE JSON (ETSI TS 119 602) - EWC Pilot format  
   * - EU LoTL (List of Trusted Lists) - Contains pointers
   */
  async flowImportPublicTrustLists(): Promise<void> {
    const publicTrustLists = [
      {
        sourceId: 'ewc-pilot',
        url: 'https://ewc-consortium.github.io/ewc-trust-list/EWC-TL',
        description: 'EWC Pilot Trust List (JSON/LoTE format, unauthenticated)',
        validateSignature: false, // EWC pilot list is not signed
      },
      {
        sourceId: 'at-tsl-authenticated', 
        url: 'https://www.signatur.rtr.at/currenttl.xml',
        description: 'Austrian TSL (XML format, XMLDSig VALIDATED)',
        validateSignature: true, // Enable signature validation → AuthenticityState.VALIDATED
      },
      // Note: EU LoTL contains pointers to member state TSLs, not actual entities
      // Uncomment to test pointer-only loading:
      // {
      //   sourceId: 'eu-lotl',
      //   url: 'https://ec.europa.eu/tools/lotl/eu-lotl.xml',
      //   description: 'EU List of Trusted Lists (XML/TSL format)',
      //   validateSignature: false,
      // },
    ];
    
    for (const trustList of publicTrustLists) {
      const step = this.nextStep();
      this.log(`Import: ${trustList.description}`, 'FLOW');
      
      const request = {
        sourceId: trustList.sourceId,
        url: trustList.url,
        validateSignature: trustList.validateSignature,
      };
      this.saveJson(`import-${trustList.sourceId}-request.json`, request, step);
      
      try {
        const response = await this.orgClient.post(
          `/v1/${this.ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources/load`,
          request
        );
        this.saveJson(`import-${trustList.sourceId}-response.json`, response.data, step);
        
        if (response.data.success) {
          console.log(`   [OK] ${trustList.sourceId} loaded`);
          console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
          console.log(`        Services: ${response.data.servicesLoaded || 0}`);
          console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
        } else {
          console.log(`   [WARN] ${trustList.sourceId} load failed: ${response.data.error}`);
        }
      } catch (error: any) {
        console.log(`   [WARN] Failed to import ${trustList.sourceId}: ${error.message}`);
        // Continue with other sources
      }
    }
  }

  /**
   * Create a LoTE-format trust source containing our local IACA certificate.
   * This allows verifying credentials issued in the journey against the trust registry.
   */
  async flowLoadIacaIntoTrustRegistry(): Promise<void> {
    const step = this.nextStep();
    this.log('Load local IACA certificate into trust registry', 'FLOW');
    
    // First, retrieve the IACA certificate PEM
    let iacaPem = this.ctx.iacaPem;
    if (!iacaPem) {
      this.log('Retrieving IACA certificate...', 'FLOW');
      try {
        const certResp = await this.orgClient.get(
          `/v1/${this.ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
        );
        iacaPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
        this.ctx.iacaPem = iacaPem;
      } catch (error: any) {
        throw new Error(`IACA certificate not found. Run full setup first: ${error.message}`);
      }
    }
    
    if (!iacaPem) {
      throw new Error('IACA certificate PEM is empty');
    }
    
    const sourceId = `journey-iaca-${Date.now()}`;
    
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
    
    this.saveJson('journey-iaca-lote-source.json', loteSource, step);
    
    const request = {
      sourceId: sourceId,
      content: JSON.stringify(loteSource),
      sourceUrl: 'local://journey-test',
      validateSignature: false, // Local test source, no signature
    };
    this.saveJson('load-journey-iaca-request.json', request, step);
    
    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources/load`,
      request
    );
    this.saveJson('load-journey-iaca-response.json', response.data, step);
    
    if (!response.data.success) {
      throw new Error(`Failed to load IACA trust source: ${response.data.error}`);
    }
    
    this.ctx.trustRegistrySourceId = sourceId;
    console.log(`   [OK] Journey IACA trust source loaded: ${sourceId}`);
    console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
    console.log(`        Services: ${response.data.servicesLoaded || 0}`);
    console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
  }

  /**
   * List all loaded trust sources in the trust registry.
   * Shows authenticity state to demonstrate authenticated vs unauthenticated sources.
   */
  async flowListTrustSources(): Promise<void> {
    const step = this.nextStep();
    this.log('List trust sources', 'FLOW');
    
    const response = await this.orgClient.get(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources`
    );
    this.saveJson('list-trust-sources-response.json', response.data, step);
    
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
    
    // Explain the authenticity states
    console.log('');
    console.log('   [y] VALIDATED = XMLDSig signature verified (requireAuthenticated: true will pass)');
    console.log('   [n]️  SKIPPED_DEMO = No signature validation (requireAuthenticated: true will fail)');
  }

  /**
   * Create verification session with ETSI Trust List policy.
   * The policy will resolve the credential's issuer certificate against the trust registry.
   */
  async flowCreateEtsiVerificationSession(): Promise<void> {
    const step = this.nextStep();
    this.log('Create verification session with ETSI Trust List policy', 'FLOW');
    
    const vicalUrl = `${this.ctx.orgBaseUrl}/v1/${this.ctx.tenantPath}.${RESOURCES.vical}/vical-service-api/latest`;
    
    const vcPolicies = [
      { policy: 'signature' },
      {
        policy: 'vical',
        vicalUrl: vicalUrl,
        enableDocumentTypeValidation: true,
        enableTrustedChainRoot: true,
      },
      {
        // ETSI Trust List policy - uses enterprise trust registry service
        // No trustRegistryUrl needed when verifier2 is linked to trust-registry service
        policy: 'etsi-trust-list',
        expectedEntityType: 'PID_PROVIDER',
        allowStaleSource: true,
        requireAuthenticated: false, // not required for demo
      },
    ];
    
    const request = {
      flow_type: 'cross_device',
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
    this.saveJson('create-etsi-verification-session-request.json', request, step);
    
    const response = await this.orgClient.post(
      `/v1/${this.ctx.tenantPath}.${RESOURCES.verifier2}/verifier2-service-api/verification-session/create`,
      request
    );
    this.saveJson('create-etsi-verification-session-response.json', response.data, step);
    
    this.ctx.sessionId = response.data.sessionId;
    this.ctx.requestUrl = response.data.bootstrapAuthorizationRequestUrl;
    
    if (!this.ctx.sessionId || !this.ctx.requestUrl) {
      throw new Error('Could not extract sessionId or bootstrapAuthorizationRequestUrl');
    }
    
    console.log(`   [OK] Verification session created (ID: ${this.ctx.sessionId})`);
    console.log(`        Policies: signature, vical, etsi-trust-list`);
  }

  async flowCredentialRevocation(): Promise<void> {
    console.log('\n=== Flow: Credential Revocation ===\n');
    console.log('[PLACEHOLDER] This flow will:');
    console.log('  1. Issue a credential');
    console.log('  2. Verify it successfully');
    console.log('  3. Revoke the credential');
    console.log('  4. Verify it fails with revocation status');
    console.log('\nNot yet implemented.');
  }

  // --------------------------------------------------------------------------
  // Main Execution Methods
  // --------------------------------------------------------------------------

  async runAllSetup(): Promise<void> {
    console.log('\n=== Running All Setup Commands ===\n');
    
    await this.setupLogin();
    await this.setupCreateTenant();
    await this.setupCreateWallet();
    await this.setupCreateVerifier2();
    await this.setupCreateServices();
    await this.setupLinkX509Dependencies();
    await this.setupImportKeys();
    await this.setupCreateIacaCertificate();
    await this.setupCreateDocumentSignerCertificate();
    await this.setupStoreVicalSignerCertificate();
    await this.setupCreateVicalService();
    await this.setupPublishVical();
    await this.setupCreateClientAttester();
    await this.setupCreateIssuer2();
    await this.setupCreateIssuerProfile();
    await this.setupLinkWalletToAttester();
    await this.setupObtainWalletAttestation();
    
    console.log('\n[SETUP] All setup commands completed');
  }

  async runAllRun(): Promise<void> {
    console.log('\n=== Running Primary Use Case ===\n');
    
    // Need to login first if not already
    if (!this.ctx.token) {
      await this.setupLogin();
    }
    
    // Set wallet key reference if not already set
    if (!this.ctx.walletKeyRef) {
      this.ctx.walletKeyRef = `${this.ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;
    }
    
    await this.runCreateCredentialOffer();
    await this.runWalletReceiveCredential();
    await this.runCreateVerificationSession();
    await this.runWalletPresent();
    await this.runAssertFinalStatus();
    
    console.log('\n[RUN] Primary use case completed successfully');
  }

  async runFull(): Promise<void> {
    console.log('\n========================================');
    console.log('  walt.id Enterprise Stack CLI Tool');
    console.log('========================================\n');
    console.log(`Organization: ${this.config.organization}`);
    console.log(`Tenant: ${this.config.tenant}`);
    console.log(`Working directory: ${this.ctx.workdir}`);
    
    mkdirSync(this.ctx.workdir, { recursive: true });
    
    try {
      await this.runAllSetup();
      await this.runAllRun();
      
      console.log('\n========================================');
      console.log('  SUCCESS - All operations completed');
      console.log('========================================\n');
    } finally {
      this.saveHttpLog();
      console.log(`Logs saved to: ${this.ctx.workdir}`);
    }
  }
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

// Helper to build URLs properly
function buildBaseUrl(baseUrl: string, port: number | undefined): string {
  // If BASE_URL already has protocol, use it as-is (possibly with port)
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    // If port is specified and not 0, append it
    if (port && port > 0) {
      const url = new URL(baseUrl);
      url.port = String(port);
      return url.origin;
    }
    return new URL(baseUrl).origin;
  }
  // Otherwise, construct with http:// and port
  const portStr = port && port > 0 ? `:${port}` : ':3000';
  return `http://${baseUrl}${portStr}`;
}

function buildOrgUrl(baseUrl: string, organization: string, port: number | undefined): string {
  // If BASE_URL already has protocol
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    const url = new URL(baseUrl);
    // Insert org before the hostname
    url.hostname = `${organization}.${url.hostname}`;
    if (port && port > 0) {
      url.port = String(port);
    }
    return url.origin;
  }
  // Otherwise, construct with http:// and port
  const portStr = port && port > 0 ? `:${port}` : ':3000';
  return `http://${organization}.${baseUrl}${portStr}`;
}

const config: Config = {
  baseUrl: process.env.BASE_URL || 'enterprise.localhost',
  organization: process.env.ORGANIZATION || 'waltid',
  tenant: process.env.TENANT || `${process.env.ORGANIZATION || 'waltid'}-tenant01`,
  // Superadmin credentials from config file or env
  email: process.env.EMAIL || superadminCreds.email || '',
  password: process.env.PASSWORD || superadminCreds.password || '',
  // PORT: if not set and BASE_URL has https, don't add port; otherwise default to 3000
  port: process.env.PORT !== undefined && process.env.PORT !== '' 
    ? parseInt(process.env.PORT) 
    : ((process.env.BASE_URL?.startsWith('https://')) ? 0 : 3000),
  superadminToken: process.env.SUPERADMIN_TOKEN || superadminCreds.token || '',
  // Admin user (non-superadmin) - used for regular operations
  adminEmail: process.env.ADMIN_EMAIL || 'admin@walt.id',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123456',
};

const args = process.argv.slice(2);

function printHelp(): void {
  console.log(`
walt.ts - walt.id Enterprise Stack CLI Tool

Usage: npx tsx walt.ts [options]

Default behavior (no options):
  Runs full setup + primary use case (issue and verify mDL credential)

System Commands:
  --recreate              Recreate database and run full setup from scratch
  --init-system           Run system initialization only (no use case)
  --setup-recreate        Recreate database only (alias for --init-system)
  --setup-create-superadmin  Create superadmin account
  --setup-create-organization  Create organization
  --setup-create-admin-role  Create organization admin role
  --setup-create-admin-account  Create admin user account and assign role

Setup Commands (create resources):
  --setup-all             Run all setup commands
  --setup-login           Login to the enterprise stack (uses admin credentials by default)
  --setup-login-superadmin  Login as superadmin
  --setup-create-tenant   Create tenant
  --setup-create-wallet   Create wallet service
  --setup-create-verifier2  Create verifier2 service
  --setup-create-services Create KMS, X509, credential store services
  --setup-link-x509-dependencies  Link X509 service dependencies
  --setup-import-keys     Import cryptographic keys
  --setup-create-iaca-certificate  Create IACA certificate
  --setup-create-document-signer-certificate  Create document signer certificate
  --setup-store-vical-signer-certificate  Store VICAL signer certificate
  --setup-create-vical-service  Create VICAL service
  --setup-publish-vical   Publish VICAL
  --setup-create-client-attester  Create client attester service
  --setup-create-issuer2  Create issuer2 service
  --setup-create-issuer-profile  Create issuer credential profile
  --setup-link-wallet-to-attester  Link wallet to client attester
  --setup-obtain-wallet-attestation  Obtain wallet attestation

Additional Setup Commands:
  --setup-create-trust-registry  Create trust registry service
  --setup-import-trust-list <file>  Import trust list from file

Run Commands (execute use cases):
  --run-all               Run primary use case (issue + verify)
  --run-create-credential-offer  Create credential offer
  --run-wallet-receive-credential  Wallet receives credential
  --run-create-verification-session  Create verification session
  --run-wallet-present    Wallet presents credential
  --run-assert-final-status  Assert final verification status

Flows (special use cases):
  --flow-etsi-trust-lists  Run ETSI trust lists verification flow:
                          1. Create trust-registry service
                          2. Import public trust lists (Austrian TSL, EWC Pilot)
                          3. Load local IACA certificate into registry
                          4. Verify credential using etsi-trust-list policy
                          (Requires primary setup to be run first)
  --flow-credential-revocation  Run credential revocation flow

Other Options:
  --help, -h              Show this help message

Environment Variables:
  BASE_URL                Enterprise stack base URL (default: enterprise.localhost)
  PORT                    Port number (default: 3000, auto-omitted for HTTPS)
  ORGANIZATION            Organization ID (default: waltid)
  TENANT                  Tenant ID (default: <organization>-tenant01)
  EMAIL                   Superadmin email (from config/superadmin-registration.conf)
  PASSWORD                Superadmin password (from config/superadmin-registration.conf)
  ADMIN_EMAIL             Admin user email (default: admin@walt.id)
  ADMIN_PASSWORD          Admin user password (default: admin123456)
  SUPERADMIN_TOKEN        Superadmin registration token (from config/superadmin-registration.conf)

Examples:
  # Full setup and run (default)
  npx tsx walt.ts

  # Recreate database and start fresh
  npx tsx walt.ts --recreate

  # Just run setup commands
  npx tsx walt.ts --setup-all

  # Just run the use case (assumes setup already done)
  npx tsx walt.ts --run-all

  # Run specific setup command
  npx tsx walt.ts --setup-create-wallet

  # Import a trust list
  npx tsx walt.ts --setup-import-trust-list /path/to/trust_list.xml

  # Run ETSI Trust Lists flow (requires primary setup first)
  npx tsx walt.ts                    # First: run full setup
  npx tsx walt.ts --flow-etsi-trust-lists  # Then: run ETSI flow

  # Run with different organization/tenant
  ORGANIZATION=myorg TENANT=myorg-prod npx tsx walt.ts
`);
}

async function main(): Promise<void> {
  // Help
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  // Check for unknown commands
  const knownArgs = [
    '--help', '-h',
    '--recreate', '--init-system',
    '--setup-all', '--setup-recreate',
    '--setup-login', '--setup-login-superadmin', '--setup-create-tenant', '--setup-create-wallet',
    '--setup-create-verifier2', '--setup-create-services',
    '--setup-link-x509-dependencies', '--setup-import-keys',
    '--setup-create-iaca-certificate', '--setup-create-document-signer-certificate',
    '--setup-store-vical-signer-certificate', '--setup-create-vical-service',
    '--setup-publish-vical', '--setup-create-client-attester',
    '--setup-create-issuer2', '--setup-create-issuer-profile',
    '--setup-link-wallet-to-attester', '--setup-obtain-wallet-attestation',
    '--setup-create-trust-registry', '--setup-import-trust-list',
    '--setup-create-superadmin', '--setup-create-organization',
    '--setup-create-admin-role', '--setup-create-admin-account',
    '--run-all', '--run-create-credential-offer', '--run-wallet-receive-credential',
    '--run-create-verification-session', '--run-wallet-present', '--run-assert-final-status',
    '--flow-etsi-trust-lists', '--flow-credential-revocation',
  ];
  
  for (const arg of args) {
    // Skip file paths (arguments to other flags)
    if (!arg.startsWith('--') && !arg.startsWith('-')) continue;
    if (!knownArgs.includes(arg)) {
      console.error(`\n[ERROR] Unknown command: ${arg}`);
      console.error('Run "npx tsx walt.ts --help" to see available commands.\n');
      process.exit(1);
    }
  }

  const walt = new WaltCLI(config);

  try {
    // System commands
    if (args.includes('--recreate')) {
      await walt.runSystemInit();
      await walt.runFull();
      return;
    }

    if (args.includes('--init-system')) {
      await walt.runSystemInit();
      return;
    }

    // Setup recreate (just system init, no setup/run)
    if (args.includes('--setup-recreate')) {
      await walt.runSystemInit();
      return;
    }

    // Setup create superadmin
    if (args.includes('--setup-create-superadmin')) {
      await walt.createSuperadminAccount();
      return;
    }

    // Setup create organization
    if (args.includes('--setup-create-organization')) {
      await walt.createOrganization();
      return;
    }

    // Setup create admin role
    if (args.includes('--setup-create-admin-role')) {
      await walt.setupCreateAdminRole();
      return;
    }

    // Setup create admin account
    if (args.includes('--setup-create-admin-account')) {
      await walt.setupCreateAdminAccount();
      return;
    }

    // Setup commands
    if (args.includes('--setup-all')) {
      mkdirSync(walt['ctx'].workdir, { recursive: true });
      await walt.runAllSetup();
      walt['saveHttpLog']();
      return;
    }

    // Individual setup commands
    const setupCommands: Record<string, () => Promise<void>> = {
      '--setup-login': () => walt.setupLogin(),
      '--setup-login-superadmin': () => walt.setupLogin(walt['config'].email, walt['config'].password),
      '--setup-create-tenant': () => walt.setupCreateTenant(),
      '--setup-create-wallet': () => walt.setupCreateWallet(),
      '--setup-create-verifier2': () => walt.setupCreateVerifier2(),
      '--setup-create-services': () => walt.setupCreateServices(),
      '--setup-link-x509-dependencies': () => walt.setupLinkX509Dependencies(),
      '--setup-import-keys': () => walt.setupImportKeys(),
      '--setup-create-iaca-certificate': () => walt.setupCreateIacaCertificate(),
      '--setup-create-document-signer-certificate': () => walt.setupCreateDocumentSignerCertificate(),
      '--setup-store-vical-signer-certificate': () => walt.setupStoreVicalSignerCertificate(),
      '--setup-create-vical-service': () => walt.setupCreateVicalService(),
      '--setup-publish-vical': () => walt.setupPublishVical(),
      '--setup-create-client-attester': () => walt.setupCreateClientAttester(),
      '--setup-create-issuer2': () => walt.setupCreateIssuer2(),
      '--setup-create-issuer-profile': () => walt.setupCreateIssuerProfile(),
      '--setup-link-wallet-to-attester': () => walt.setupLinkWalletToAttester(),
      '--setup-obtain-wallet-attestation': () => walt.setupObtainWalletAttestation(),
      '--setup-create-trust-registry': () => walt.setupCreateTrustRegistry(),
    };

    for (const [flag, fn] of Object.entries(setupCommands)) {
      if (args.includes(flag)) {
        mkdirSync(walt['ctx'].workdir, { recursive: true });
        await walt.setupLogin();
        await fn();
        walt['saveHttpLog']();
        return;
      }
    }

    // Import trust list (special case with parameter)
    const importTrustListIndex = args.findIndex(a => a === '--setup-import-trust-list');
    if (importTrustListIndex !== -1) {
      const filePath = args[importTrustListIndex + 1];
      if (!filePath) {
        console.error('Error: --setup-import-trust-list requires a file path');
        process.exit(1);
      }
      mkdirSync(walt['ctx'].workdir, { recursive: true });
      await walt.setupLogin();
      await walt.setupImportTrustList(filePath);
      walt['saveHttpLog']();
      return;
    }

    // Run commands
    if (args.includes('--run-all')) {
      mkdirSync(walt['ctx'].workdir, { recursive: true });
      await walt.runAllRun();
      walt['saveHttpLog']();
      return;
    }

    const runCommands: Record<string, () => Promise<void>> = {
      '--run-create-credential-offer': () => walt.runCreateCredentialOffer(),
      '--run-wallet-receive-credential': () => walt.runWalletReceiveCredential(),
      '--run-create-verification-session': () => walt.runCreateVerificationSession(),
      '--run-wallet-present': () => walt.runWalletPresent(),
      '--run-assert-final-status': () => walt.runAssertFinalStatus(),
    };

    for (const [flag, fn] of Object.entries(runCommands)) {
      if (args.includes(flag)) {
        mkdirSync(walt['ctx'].workdir, { recursive: true });
        await walt.setupLogin();
        await fn();
        walt['saveHttpLog']();
        return;
      }
    }

    // Flows
    if (args.includes('--flow-etsi-trust-lists')) {
      await walt.flowEtsiTrustLists();
      return;
    }

    if (args.includes('--flow-credential-revocation')) {
      await walt.flowCredentialRevocation();
      return;
    }

    // Default: run full setup + use case
    await walt.runFull();

  } catch (error: any) {
    console.error('\n[ERROR] Operation failed:', error.message);
    
    // Show cause if available (e.g., network errors)
    if (error.cause) {
      console.error('Cause:', error.cause.message || error.cause);
      if (error.cause.code) {
        console.error('Error code:', error.cause.code);
      }
    }
    
    // Show response data if available
    if (error.response?.data) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    
    // Show stack trace in verbose mode
    if (process.env.VERBOSE === 'true') {
      console.error('\nStack trace:', error.stack);
    }
    
    // Try to save HTTP log even on error
    try {
      walt['saveHttpLog']();
      console.error(`\nHTTP log saved to: ${walt['ctx'].workdir}/walt-http-log.json`);
    } catch (e) {
      // Ignore if we can't save
    }
    
    process.exit(1);
  }
}

main();
