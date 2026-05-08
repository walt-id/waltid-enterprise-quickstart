/**
 * Authentication setup commands.
 * 
 * Handles login operations for different user types.
 */

import { CommandContext } from '../../context.js';

/**
 * Login to the enterprise stack.
 * Defaults to admin credentials if available, otherwise superadmin.
 */
export async function setupLogin(
  ctx: CommandContext,
  email?: string,
  password?: string
): Promise<void> {
  const step = ctx.nextStep();
  const loginEmail = email || ctx.config.adminEmail || ctx.config.email;
  const loginPassword = password || ctx.config.adminPassword || ctx.config.password;
  
  ctx.log(`Login as: ${loginEmail}`, 'SETUP');
  
  const request = {
    email: loginEmail,
    password: loginPassword,
  };
  
  ctx.saveRequest('login-request.json', 'POST', '/auth/account/emailpass', request, step);

  const response = await ctx.client.post('/auth/account/emailpass', request);
  
  ctx.saveResponse('login-response.json', response.status, response.data, step);

  const token = response.data.token || response.data.accessToken || response.data.data?.token;
  if (!token) {
    throw new Error('Could not extract bearer token from login response');
  }

  // Store admin token if logging in as admin user
  if (loginEmail === ctx.config.adminEmail) {
    ctx.setAdminToken(token);
  }
  ctx.setToken(token);

  console.log(`   [OK] Logged in as ${loginEmail}`);
}

/**
 * Login as superadmin user.
 */
export async function setupLoginSuperadmin(ctx: CommandContext): Promise<void> {
  await setupLogin(ctx, ctx.config.email, ctx.config.password);
}

/**
 * Login as admin user.
 */
export async function setupLoginAdmin(ctx: CommandContext): Promise<void> {
  await setupLogin(ctx, ctx.config.adminEmail, ctx.config.adminPassword);
}
