# AGENTS.md - walt.id Enterprise CLI Extension Guide

This document provides guidance for AI coding agents extending the walt.id Enterprise CLI tool.

## Project Overview

The CLI is a TypeScript tool for interacting with the walt.id Enterprise Stack. It supports:
- **Setup commands**: Create and configure services (tenant, wallet, issuer, verifier, etc.)
- **Run commands**: Execute credential issuance and verification flows
- **Flows**: Multi-step use cases (ETSI trust lists, credential revocation)

## Architecture

```
cli/
├── walt.ts                 # Entry point (thin wrapper)
├── src/
│   ├── index.ts           # CLI argument parsing and dispatch
│   ├── config.ts          # Configuration, constants, types
│   ├── context.ts         # CommandContext - shared state and utilities
│   ├── http/
│   │   ├── client.ts      # HttpClient with auth and logging
│   │   └── index.ts       # HTTP module exports
│   ├── commands/
│   │   ├── index.ts       # Command registry and orchestration
│   │   ├── system.ts      # System init commands (recreate DB, create org)
│   │   ├── run.ts         # Run commands (issue, verify, revoke)
│   │   └── setup/
│   │       ├── index.ts   # Setup exports
│   │       ├── auth.ts    # Login commands
│   │       ├── tenant.ts  # Tenant/service creation
│   │       ├── keys.ts    # Key/certificate management
│   │       ├── issuer.ts  # Issuer/VICAL/attestation setup
│   │       ├── status.ts  # Credential status service
│   │       └── trust.ts   # Trust registry setup
│   └── flows/
│       ├── index.ts       # Flow exports
│       ├── etsi.ts        # ETSI trust lists flow
│       └── revocation.ts  # Credential revocation flow
├── keys/                   # Cryptographic key files (JWK, PEM)
└── logs/                   # Runtime logs (gitignored)
```

## Key Concepts

### CommandContext

The `CommandContext` class (`src/context.ts`) is the central object passed to all commands:

```typescript
class CommandContext {
  readonly config: Config;      // Environment configuration
  readonly ctx: WaltContext;    // Runtime state (tokens, IDs, certs)
  readonly cliDir: string;      // CLI directory path
  
  // HTTP clients for different scopes
  readonly client: HttpClient;      // Base URL (no org prefix)
  readonly orgClient: HttpClient;   // Organization-scoped requests
  readonly systemClient: HttpClient;
  readonly adminClient: HttpClient;
  
  // Utilities
  log(message: string, prefix?: string): void;
  nextStep(): string;
  saveJson(filename: string, data: any, stepNum?: string): void;
  loadKeyFile(filename: string): any;
  tolerantCreate<T>(operation: string, createFn: () => Promise<T>): Promise<{created: boolean}>;
}
```

### Resource Constants

All service names and IDs are defined in `src/config.ts`:

```typescript
export const RESOURCES = {
  wallet: 'wallet',
  issuer: 'issuer2',
  verifier2: 'verifier2',
  kms: 'kms',
  // ... etc
};

export const KEY_IDS = {
  issuerSigningKey: 'issuer-signing-key',
  // ... etc
};
```

## Adding New Commands

### 1. Setup Command

Create a new file or add to existing file in `src/commands/setup/`:

```typescript
// src/commands/setup/myfeature.ts
import { CommandContext } from '../../context.js';
import { RESOURCES } from '../../config.js';

export async function setupMyFeature(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Setting up my feature', 'SETUP');

  const { created } = await ctx.tolerantCreate(
    'My feature',
    async () => {
      const request = { /* ... */ };
      ctx.saveJson('my-feature-request.json', request, step);
      
      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.myservice/api/endpoint`,
        request
      );
      ctx.saveJson('my-feature-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log('   [OK] My feature created');
  }
}
```

### 2. Export from setup/index.ts

```typescript
export { setupMyFeature } from './myfeature.js';
```

### 3. Add to CLI

In `src/index.ts`:

1. Import the command:
```typescript
import { setupMyFeature } from './commands/setup/index.js';
```

2. Add to `knownArgs`:
```typescript
const knownArgs = [
  // ...existing args
  '--setup-my-feature',
];
```

3. Add to `setupCommands` map:
```typescript
const setupCommands: Record<string, () => Promise<void>> = {
  // ...existing commands
  '--setup-my-feature': () => setupMyFeature(ctx),
};
```

4. Update help text in `printHelp()`.

### 4. Run Command

Add to `src/commands/run.ts`:

```typescript
export async function runMyAction(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Running my action', 'RUN');
  
  // Implementation
}
```

### 5. Register it with the runAllSetup command

Add to `src/commands/index.ts`"

```typescript
export async function runAllSetup(ctx: CommandContext): Promise<void> {
  console.log('\n=== Running All Setup Commands ===\n');

  await setupLogin(ctx);
  await setupCreateTenant(ctx);
  await setupCreateWallet(ctx);
  // ... existing commands ...
  await setupMyFeature(ctx);
  // ... existing commands ...
}
```

## Adding New Flows

Flows are multi-step use cases. Create in `src/flows/`:

```typescript
// src/flows/myflow.ts
import { mkdirSync } from 'fs';
import { CommandContext } from '../context.js';
import { setupLogin } from '../commands/setup/index.js';
import { runCreateCredentialOffer, runWalletReceiveCredential } from '../commands/run.js';

export async function flowMyFlow(ctx: CommandContext): Promise<void> {
  console.log('\n=== Flow: My Flow ===\n');
  
  mkdirSync(ctx.workdir, { recursive: true });
  
  try {
    await setupLogin(ctx);
    
    // Step 1
    console.log('\n--- Step 1: Do something ---');
    await runCreateCredentialOffer(ctx);
    
    // Step 2
    console.log('\n--- Step 2: Do something else ---');
    await runWalletReceiveCredential(ctx);
    
    console.log('\n=== Flow Complete ===\n');
  } finally {
    ctx.saveHttpLog();
    console.log(`Logs saved to: ${ctx.workdir}`);
  }
}
```

Export from `src/flows/index.ts` and add to `src/index.ts`.

## API Patterns

### Tenant-scoped API calls

Most API calls use the tenant path:

```typescript
const response = await ctx.orgClient.post(
  `/v1/${ctx.tenantPath}.${RESOURCES.issuer}/issuer-service-api/endpoint`,
  request
);
```

### Service dependencies

Link services using the dependency API:

```typescript
await ctx.orgClient.post(
  `/v1/${ctx.tenantPath}.${RESOURCES.verifier2}/verifier2-service-api/dependencies/add`,
  `${ctx.tenantPath}.${RESOURCES.trustRegistry}`,
  'text/plain'
);
```

### Tolerant creation

Use `tolerantCreate` for idempotent operations:

```typescript
const { created } = await ctx.tolerantCreate(
  'Resource name',
  async () => {
    // Create operation
    return response;
  }
);
```

## Testing Changes

```bash
# Type check
npm run typecheck

# Run full flow
npx tsx walt.ts

# Run specific command
npx tsx walt.ts --setup-my-feature

# Run with verbose logging
VERBOSE=true npx tsx walt.ts
```

## Common Patterns

### Retrieving certificates

```typescript
if (!ctx.ctx.docSignerPem) {
  const certResponse = await ctx.orgClient.get(
    `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
  );
  ctx.ctx.docSignerPem = certResponse.data.data?.pem || certResponse.data.certificatePem;
}
```

### Verification policies

```typescript
const vcPolicies = [
  { policy: 'signature' },
  { policy: 'vical', vicalUrl: '...', enableDocumentTypeValidation: true },
  { policy: 'credential-status', argument: { discriminator: 'ietf', value: 0 } },
  { policy: 'etsi-trust-list', expectedEntityType: 'PID_PROVIDER' },
];
```

### Credential status updates

```typescript
await ctx.orgClient.put(
  `/v1/${ctx.tenantPath}.${RESOURCES.credentialStatus}.${STATUS_CONFIG_IDS.tokenStatusListCwt}/credential-status-service-api/status-credential/status/update`,
  { session: ctx.ctx.issuerSessionIdWithStatus, status: '0x1' }
);
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `enterprise.localhost` | Enterprise stack base URL |
| `PORT` | `7500` | Port (auto-omitted for HTTPS) |
| `ORGANIZATION` | `waltid` | Organization ID |
| `TENANT` | `<org>-tenant01` | Tenant ID |
| `EMAIL` | From config file | Superadmin email |
| `PASSWORD` | From config file | Superadmin password |
| `ADMIN_EMAIL` | `admin@walt.id` | Admin user email |
| `ADMIN_PASSWORD` | `admin123456` | Admin user password |

## File Naming Conventions

- Commands: `src/commands/setup/<feature>.ts` or `src/commands/run.ts`
- Flows: `src/flows/<flowname>.ts`
- Log files: `<step>-<operation>-request.json`, `<step>-<operation>-response.json`

## Error Handling

Commands should:
1. Use `tolerantCreate` for idempotent operations
2. Log warnings with `[WARN]` prefix for non-fatal issues
3. Throw errors for fatal issues (will be caught by main)
4. Save HTTP logs even on failure (in finally block)
