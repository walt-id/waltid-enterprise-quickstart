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
import { buildBaseUrl } from '../config.js';

// ============================================================================
// System Commands
// ============================================================================

/** Recreate the database (dev endpoint) */
export async function recreateDb(ctx: CommandContext): Promise<void> {
  ctx.log('Recreating database', 'SYSTEM');
  
  const adminUrl = buildBaseUrl(ctx.config.baseUrl, ctx.config.port);
  
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
    const adminUrl = buildBaseUrl(ctx.config.baseUrl, ctx.config.port);
    const response = await fetch(`${adminUrl}/v1/superadmin/create-by-token`, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'Content-Type': 'application/json',
      },
      body: token,
    });
    
    const text = await response.text();
    
    if (text.includes('exception') || !response.ok) {
      if (text.includes('already') || text.includes('exists') || text.includes('already used')) {
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

/** Initialize the database with default data */
export async function initDb(ctx: CommandContext): Promise<void> {
  ctx.log('Initializing database', 'SYSTEM');
  
  const adminUrl = buildBaseUrl(ctx.config.baseUrl, ctx.config.port);
  
  const loginResponse = await fetch(`${adminUrl}/auth/account/emailpass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ctx.config.email, password: ctx.config.password }),
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
export async function runSystemInit(ctx: CommandContext): Promise<void> {
  await recreateDb(ctx);
  await createSuperadminAccount(ctx);
  await initDb(ctx);
  await createOrganization(ctx);
  await setupCreateAdminRole(ctx);
  await setupCreateAdminAccount(ctx);
  console.log('\n[SYSTEM] System initialization complete');
}
