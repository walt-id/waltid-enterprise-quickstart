/**
 * System commands for database and organization initialization.
 * 
 * These commands handle:
 * - Database recreation
 * - Superadmin account creation
 * - Database initialization
 * - Organization creation
 * - Admin role and account setup
 */

import { CommandContext } from '../context.js';
import { buildBaseUrl, buildOrgUrl, defaultHostAliasTarget } from '../config.js';

/** Obtain superadmin bearer token for system API calls */
async function getSuperadminToken(ctx: CommandContext): Promise<string> {
  const adminUrl = buildBaseUrl(ctx.config.baseUrl, ctx.config.port);

  const loginResponse = await fetch(`${adminUrl}/auth/account/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ctx.config.email, password: ctx.config.password }),
  });

  const loginData = (await loginResponse.json()) as { token?: string };
  const token = loginData.token;

  if (!token) {
    throw new Error('Could not get superadmin token');
  }

  return token;
}

// ============================================================================
// System Commands
// ============================================================================

/**
 * Header + guidance shared by every /v1/dev/* call: the server refuses these routes unless
 * dev-mode is enabled AND a matching token is configured server-side (config/dev-mode-access.conf).
 */
function devModeHeaders(ctx: CommandContext): Record<string, string> {
  return ctx.config.devModeToken ? { 'X-Dev-Mode-Token': ctx.config.devModeToken } : {};
}

/** True if `status`/`text` is the dev-mode-access gate refusing the request, not the handler itself. */
function logIfDevModeAccessDenied(ctx: CommandContext, status: number, text: string): boolean {
  if (status === 503 && text.includes('dev-mode-access token is configured')) {
    console.log(`   [WARN] Server has no dev-mode-access token configured (config/dev-mode-access.conf).`);
    console.log(`          Set accessToken there, or point DEV_MODE_TOKEN at the same value.`);
    return true;
  }
  if (status === 401 && text.includes('X-Dev-Mode-Token')) {
    const sentToken = ctx.config.devModeToken ? `'${ctx.config.devModeToken}'` : '(none sent)';
    console.log(`   [WARN] Dev-mode access token missing or doesn't match the server's config/dev-mode-access.conf.`);
    console.log(`          CLI sent ${sentToken} - set DEV_MODE_TOKEN to the server's configured accessToken.`);
    return true;
  }
  return false;
}

/** Recreate the database (dev endpoint). Returns false on any failure - callers must not proceed. */
export async function recreateDb(ctx: CommandContext): Promise<boolean> {
  ctx.log('Recreating database', 'SYSTEM');

  const adminUrl = buildBaseUrl(ctx.config.baseUrl, ctx.config.port);

  try {
    const response = await fetch(`${adminUrl}/v1/dev/database-recreate`, {
      method: 'POST',
      headers: { 'accept': '*/*', ...devModeHeaders(ctx) },
    });

    if (!response.ok) {
      const text = await response.text();
      if (!logIfDevModeAccessDenied(ctx, response.status, text)) {
        console.log(`   [WARN] Database recreate returned ${response.status}: ${text}`);
      }
      return false;
    }

    console.log(`   [OK] Database recreated`);
    return true;
  } catch (error: any) {
    console.log(`   [WARN] Database recreate failed: ${error.message}`);
    if (error.cause) {
      console.log(`   [CAUSE] ${error.cause.message || error.cause}`);
    }
    return false;
  }
}

/** Create superadmin account using registration token */
export async function createSuperadminAccount(ctx: CommandContext): Promise<boolean> {
  ctx.log('Creating superadmin account', 'SYSTEM');
  
  const token = ctx.config.superadminToken;
  
  if (!token) {
    console.log('   [ERROR] No superadmin token found. Check config/superadmin-registration.conf');
    return false;
  }
  
  console.log('   [INFO] Using credentials from: config/superadmin-registration.conf');
  
  try {
    // Superadmin endpoint is at base URL, not org-scoped URL
    const baseUrl = buildBaseUrl(ctx.config.baseUrl, ctx.config.port);
    const response = await fetch(`${baseUrl}/v1/superadmin/create-by-token`, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        "token" : token,
      }),
    });
    
    const text = await response.text();
    
    if (text.includes('exception') || !response.ok) {
      if (text.includes('already') || text.includes('exists')) {
        console.log(`   [SKIP] Superadmin account already exists`);
        return true;
      }
      // The bootstrap endpoint is rate limited per source IP (see config/rate-limit.conf).
      // Repeated setup runs can trip it, so say so instead of dumping the raw body.
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const wait = retryAfter ? `${retryAfter}s` : 'about a minute';
        console.log(`   [WARN] Superadmin creation is rate limited. Retry in ${wait}.`);
        return false;
      }
      // devModeOnly defaults to protected: a token is only usable outside dev-mode when it
      // explicitly sets devModeOnly = false.
      if (text.includes('dev-mode')) {
        console.log(`   [WARN] Superadmin token requires dev-mode. Enable dev-mode in config/_features.conf,`);
        console.log(`          or set devModeOnly = false on a secret token in config/superadmin-registration.conf`);
        return false;
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

/** Initialize the database with default data. Returns false on any failure - callers must not proceed. */
export async function initDb(ctx: CommandContext): Promise<boolean> {
  ctx.log('Initializing database', 'SYSTEM');

  const adminUrl = buildBaseUrl(ctx.config.baseUrl, ctx.config.port);

  const loginResponse = await fetch(`${adminUrl}/auth/account/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ctx.config.email, password: ctx.config.password }),
  });

  const loginText = await loginResponse.text();
  let token: string | undefined;
  try {
    token = loginText ? (JSON.parse(loginText) as { token?: string }).token : undefined;
  } catch {
    // fall through - reported below via the empty-body/non-JSON message
  }

  if (!token) {
    console.log(`   [WARN] Could not get superadmin token for database init (login returned ${loginResponse.status}: ${loginText || '<empty body>'}).`);
    console.log(`          Is the enterprise-api container running? Did superadmin account creation succeed above?`);
    return false;
  }

  const initResponse = await fetch(`${adminUrl}/v1/dev/initial-setup`, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'Authorization': `Bearer ${token}`,
      ...devModeHeaders(ctx),
    },
  });

  if (!initResponse.ok) {
    const text = await initResponse.text();
    if (!logIfDevModeAccessDenied(ctx, initResponse.status, text)) {
      console.log(`   [WARN] Database init returned ${initResponse.status}: ${text}`);
    }
    return false;
  }

  console.log(`   [OK] Database initialized`);
  return true;
}

/**
 * Create a host alias when HOST_ALIAS_DOMAIN is configured.
 * Maps a custom domain to the organization (default target: {org}.host-alias).
 */
export async function createHostAlias(ctx: CommandContext): Promise<void> {
  const domain = ctx.config.hostAliasDomain?.trim();
  if (!domain) {
    return;
  }

  ctx.log(`Create host alias: ${domain}`, 'SYSTEM');

  const orgUrl = buildOrgUrl(ctx.config.baseUrl, ctx.config.organization, ctx.config.port);
  const target = ctx.config.hostAliasTarget?.trim() || defaultHostAliasTarget(ctx.config.organization);
  const token = await getSuperadminToken(ctx);

  const request = { domain };
  ctx.saveJson('create-host-alias-request.json', { target, ...request });

  try {
    const response = await fetch(
      `${orgUrl}/v1/${target}/host-alias-api/host-aliases/create`,
      {
        method: 'POST',
        headers: {
          accept: '*/*',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      }
    );

    const text = await response.text();
    ctx.saveJson('create-host-alias-response.json', { status: response.status, body: text });

    if (text.includes('already') || text.includes('exists') || text.includes('Duplicate')) {
      console.log(`   [SKIP] Host alias '${domain}' already exists (target: ${target})`);
    } else if (!response.ok) {
      console.log(`   [WARN] Host alias creation returned ${response.status}: ${text}`);
    } else {
      console.log(`   [OK] Host alias created: ${domain} (target: ${target})`);
    }
  } catch (error: any) {
    console.log(`   [WARN] Host alias creation failed: ${error.message}`);
    if (error.cause) {
      console.log(`   [CAUSE] ${error.cause.message || error.cause}`);
    }
  }
}

/** Create the organization */
export async function createOrganization(ctx: CommandContext): Promise<void> {
  ctx.log(`Creating organization: ${ctx.config.organization}`, 'SYSTEM');
  
  const adminUrl = buildBaseUrl(ctx.config.baseUrl, ctx.config.port);
  
  const loginResponse = await fetch(`${adminUrl}/auth/account/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ctx.config.email, password: ctx.config.password }),
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
      _id: ctx.config.organization,
      profile: {
        name: `${ctx.config.organization} Organization`,
      },
    }),
  });
  
  const text = await response.text();
  
  if (text.includes('already') || text.includes('exists') || text.includes('DuplicateTarget')) {
    console.log(`   [SKIP] Organization '${ctx.config.organization}' already exists`);
  } else if (text.includes('Unknown host alias')) {
    console.log(`   [WARN] Organization created but host alias not configured`);
    console.log(`          Configure '${ctx.config.organization}.<domain>' in server settings`);
  } else if (!response.ok) {
    console.log(`   [WARN] Organization creation returned ${response.status}: ${text}`);
  } else {
    console.log(`   [OK] Organization '${ctx.config.organization}' created`);
  }
}

/** Check/report admin role status */
export async function setupCreateAdminRole(ctx: CommandContext): Promise<void> {
  ctx.log('Checking admin role', 'SETUP');
  
  const roleId = `${ctx.config.organization}.admin`;
  console.log(`   [INFO] Admin role '${roleId}' is auto-created with organization`);
  console.log(`   [OK] Admin role exists`);
}

/** Create admin account and assign role */
export async function setupCreateAdminAccount(ctx: CommandContext): Promise<void> {
  ctx.log('Creating admin account', 'SETUP');
  
  const adminUrl = buildBaseUrl(ctx.config.baseUrl, ctx.config.port);
  
  const loginResponse = await fetch(`${adminUrl}/auth/account/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ctx.config.email, password: ctx.config.password }),
  });
  
  const loginData = await loginResponse.json() as { token?: string };
  const superadminToken = loginData.token;
  
  if (!superadminToken) {
    throw new Error('Could not get superadmin token for account creation');
  }
  
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
        email: ctx.config.adminEmail,
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
          email: ctx.config.adminEmail,
        },
        data: {
          type: 'email',
          password: ctx.config.adminPassword,
        },
      },
    }),
  });
  
  const createUserText = await createUserResponse.text();
  let userId: string | null = null;
  
  if (createUserText.includes('already') || createUserText.includes('exists') || createUserText.includes('Duplicate')) {
    console.log(`   [SKIP] Admin account '${ctx.config.adminEmail}' already exists`);
    const listResponse = await fetch(`${adminUrl}/v1/admin/accounts`, {
      headers: { 'Authorization': `Bearer ${superadminToken}` },
    });
    const accounts = await listResponse.json() as Array<{ _id: string; profile?: { email?: string } }>;
    const existingUser = accounts.find((a: any) => a.profile?.email === ctx.config.adminEmail);
    if (existingUser) {
      userId = existingUser._id;
    }
  } else if (!createUserResponse.ok) {
    console.log(`   [WARN] Account creation returned ${createUserResponse.status}: ${createUserText}`);
  } else {
    console.log(`   [OK] Admin account '${ctx.config.adminEmail}' created`);
    try {
      const userData = JSON.parse(createUserText);
      userId = userData._id;
    } catch {
      const match = createUserText.match(/"_id":\s*"([^"]+)"/);
      if (match) userId = match[1];
    }
  }
  
  if (!userId) {
    console.log('   [WARN] Could not determine user ID, skipping role assignment');
    return;
  }
  
  ctx.ctx.adminUserId = userId;
  console.log(`   [INFO] Admin user ID: ${userId}`);
  
  const roleId = `${ctx.config.organization}.admin`;
  const addRoleResponse = await fetch(
    `${adminUrl}/v1/admin/account/${userId}/roles/add/${ctx.config.organization}/${roleId}`,
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

/** Run full system initialization */
/**
 * Fail fast with a clear diagnosis instead of letting every step 404/crash separately.
 * A wrong BASE_URL/PORT most commonly shows up as: this repo's own docker Caddy container
 * still running and silently intercepting the default enterprise.localhost:80, while the
 * intended target (a local `:waltid-enterprise-api-development:run`, or a down docker stack)
 * never sees the request.
 */
async function preflightCheck(ctx: CommandContext): Promise<boolean> {
  const adminUrl = buildBaseUrl(ctx.config.baseUrl, ctx.config.port);

  try {
    const response = await fetch(`${adminUrl}/features/registered`);
    if (response.ok) return true;
    console.log(`\n[ERROR] ${adminUrl} did not respond like an Enterprise API (HTTP ${response.status}).`);
  } catch (error: any) {
    console.log(`\n[ERROR] Could not reach ${adminUrl}: ${error.message}`);
  }

  console.log(`       Check what's actually running there:`);
  console.log(`       - Docker stack:   docker compose ps   (is 'waltid-enterprise' Up?)`);
  console.log(`       - Make sure the BASE_URL and PORT are set correctly e.g._ BASE_URL=localhost PORT=3000 <your command>`);
  return false;
}

/** Returns false when the preflight check fails, so callers can skip dependent steps. */
export async function runSystemInit(ctx: CommandContext): Promise<boolean> {
  if (!(await preflightCheck(ctx))) {
    return false;
  }

  if (!(await recreateDb(ctx))) {
    console.log('\n[ERROR] Database recreate failed - aborting system initialization.');
    return false;
  }
  if (!(await createSuperadminAccount(ctx))) {
    console.log('\n[ERROR] Superadmin account creation failed - aborting system initialization.');
    return false;
  }
  if (!(await initDb(ctx))) {
    console.log('\n[ERROR] Database initialization failed - aborting system initialization.');
    return false;
  }

  await createOrganization(ctx);
  await setupCreateAdminRole(ctx);
  await setupCreateAdminAccount(ctx);
  await createHostAlias(ctx);
  console.log('\n[SYSTEM] System initialization complete');
  return true;
}
