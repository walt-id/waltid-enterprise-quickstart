/**
 * Command context providing shared state and utilities for all commands.
 * 
 * The CommandContext is the primary interface that commands use to:
 * - Access HTTP clients (authenticated for different scopes)
 * - Read/write runtime context (tokens, IDs, certificates)
 * - Log operations and save request/response data
 * - Load key files and other resources
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { HttpClient, HttpLogEntry } from './http/index.js';
import {
  Config,
  WaltContext,
  buildBaseUrl,
  buildOrgUrl,
  createInitialContext,
  RESOURCES,
} from './config.js';

// ============================================================================
// Command Context
// ============================================================================

/**
 * Shared context for command execution.
 * 
 * Provides:
 * - HTTP clients for different API scopes
 * - Runtime state management
 * - Logging and file I/O utilities
 * - Key file loading
 * 
 * @example
 * ```typescript
 * const ctx = new CommandContext(config, cliDir);
 * await ctx.setupLogin();
 * await ctx.runCreateCredentialOffer();
 * ctx.saveHttpLog();
 * ```
 */
export class CommandContext {
  readonly config: Config;
  readonly ctx: WaltContext;
  readonly cliDir: string;
  
  /** HTTP client for base URL (no org prefix) */
  readonly client: HttpClient;
  /** HTTP client for organization-scoped requests */
  readonly orgClient: HttpClient;
  /** HTTP client for system operations */
  readonly systemClient: HttpClient;
  /** HTTP client for admin operations */
  readonly adminClient: HttpClient;

  constructor(config: Config, cliDir: string) {
    this.config = config;
    this.cliDir = cliDir;
    
    const clientUrl = buildBaseUrl(config.baseUrl, config.port);
    const orgUrl = buildOrgUrl(config.baseUrl, config.organization, config.port);
    
    // Generate workdir name with date, time, and count
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    const logDir = join(cliDir, 'logs');
    const existingDirs = existsSync(logDir) 
      ? readdirSync(logDir).filter(d => d.startsWith(`walt-log-${date}-${time}`))
      : [];
    const count = existingDirs.length + 1;
    
    this.ctx = createInitialContext(
      config,
      join(logDir, `walt-log-${date}-${time}-${String(count).padStart(3, '0')}`),
      orgUrl
    );

    this.client = new HttpClient(clientUrl);
    this.orgClient = new HttpClient(orgUrl);
    this.systemClient = new HttpClient(orgUrl);
    this.adminClient = new HttpClient(clientUrl);
    
    console.log(`\n[CONFIG] Base URL: ${clientUrl}`);
    console.log(`[CONFIG] Org URL: ${orgUrl}`);
    console.log(`[CONFIG] Organization: ${config.organization}`);
    console.log(`[CONFIG] Tenant: ${config.tenant}`);
  }

  // --------------------------------------------------------------------------
  // Logging Utilities
  // --------------------------------------------------------------------------

  /** Log a message with optional prefix */
  log(message: string, prefix?: string): void {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const prefixStr = prefix ? `[${prefix}] ` : '';
    console.log(`\n${prefixStr}>> ${message}`);
  }

  /** Increment and return the next step number */
  nextStep(): string {
    this.ctx.stepCounter++;
    return String(this.ctx.stepCounter).padStart(3, '0');
  }

  /** Save JSON data to a file in the workdir */
  saveJson(filename: string, data: any, stepNum?: string): void {
    mkdirSync(this.ctx.workdir, { recursive: true });
    const prefix = stepNum || String(this.ctx.stepCounter).padStart(3, '0');
    const path = join(this.ctx.workdir, `${prefix}-${filename}`);
    writeFileSync(path, JSON.stringify(data, null, 2));
  }

  /** Save request details to a file */
  saveRequest(filename: string, method: string, endpoint: string, body: any, stepNum?: string): void {
    mkdirSync(this.ctx.workdir, { recursive: true });
    const prefix = stepNum || String(this.ctx.stepCounter).padStart(3, '0');
    const path = join(this.ctx.workdir, `${prefix}-${filename}`);
    
    const requestData = {
      timestamp: new Date().toISOString(),
      method,
      endpoint,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer [REDACTED]',
      },
      body,
    };
    
    writeFileSync(path, JSON.stringify(requestData, null, 2));
  }

  /** Save response details to a file */
  saveResponse(filename: string, status: number, data: any, stepNum?: string): void {
    mkdirSync(this.ctx.workdir, { recursive: true });
    const prefix = stepNum || String(this.ctx.stepCounter).padStart(3, '0');
    const path = join(this.ctx.workdir, `${prefix}-${filename}`);
    
    const responseData = {
      timestamp: new Date().toISOString(),
      status,
      statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : status === 204 ? 'No Content' : 'Unknown',
      body: data,
    };
    
    writeFileSync(path, JSON.stringify(responseData, null, 2));
  }

  /** Save combined HTTP log from all clients */
  saveHttpLog(): void {
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

  // --------------------------------------------------------------------------
  // Resource Loading
  // --------------------------------------------------------------------------

  /** Load a key file from the keys directory */
  loadKeyFile(filename: string): any {
    const keyPath = join(this.cliDir, 'keys', filename);
    return JSON.parse(readFileSync(keyPath, 'utf-8'));
  }

  /** Load a PEM file from the keys directory */
  loadPemFile(filename: string): string {
    const keyPath = join(this.cliDir, 'keys', filename);
    return readFileSync(keyPath, 'utf-8');
  }

  // --------------------------------------------------------------------------
  // Tolerant Operations
  // --------------------------------------------------------------------------

  /**
   * Execute a create operation that may fail if resource already exists.
   * Returns { created: true } if created, { created: false } if already exists.
   */
  async tolerantCreate<T>(
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
  // Token Management
  // --------------------------------------------------------------------------

  /** Set authentication token on all clients */
  setToken(token: string): void {
    this.ctx.token = token;
    this.client.setToken(token);
    this.orgClient.setToken(token);
  }

  /** Set admin token */
  setAdminToken(token: string): void {
    this.ctx.adminToken = token;
  }

  // --------------------------------------------------------------------------
  // Context Accessors
  // --------------------------------------------------------------------------

  /** Get the tenant path (org.tenant) */
  get tenantPath(): string {
    return this.ctx.tenantPath;
  }

  /** Get the organization base URL */
  get orgBaseUrl(): string {
    return this.ctx.orgBaseUrl;
  }

  /** Get the working directory */
  get workdir(): string {
    return this.ctx.workdir;
  }

  /** Ensure workdir exists */
  ensureWorkdir(): void {
    mkdirSync(this.ctx.workdir, { recursive: true });
  }
}
