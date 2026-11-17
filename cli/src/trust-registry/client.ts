import { CommandContext } from '../context.js';
import {
  LoadSourceRequest,
  RefreshResult,
  ResolveCertificateChainRequest,
  TrustDecision,
  TrustSource,
} from './types.js';

function servicePath(ctx: CommandContext): string {
  return `/v1/${ctx.tenantPath}.trust-registry/trust-registry-api`;
}

export async function loadTrustSource(
  ctx: CommandContext,
  request: LoadSourceRequest
): Promise<RefreshResult> {
  const response = await ctx.orgClient.post<RefreshResult>(
    `${servicePath(ctx)}/sources/load`,
    request
  );
  return response.data;
}

export function requireSuccessfulLoad(result: RefreshResult): RefreshResult {
  if (!result.success) {
    throw new Error(`Trust source '${result.sourceId}' failed to load: ${result.error || 'unknown error'}`);
  }
  return result;
}

export async function listTrustRegistrySources(ctx: CommandContext): Promise<TrustSource[]> {
  const response = await ctx.orgClient.get<TrustSource[]>(`${servicePath(ctx)}/sources`);
  return response.data;
}

export async function resolveTrustCertificateChain(
  ctx: CommandContext,
  request: ResolveCertificateChainRequest
): Promise<TrustDecision> {
  const response = await ctx.orgClient.post<TrustDecision>(
    `${servicePath(ctx)}/resolve/certificate-chain`,
    request
  );
  return response.data;
}
