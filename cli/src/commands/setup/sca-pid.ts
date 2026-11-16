import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import { CommandContext, assertConfigurationSubset } from '../../context.js';
import { ScaPidConfig, SIGNER_ROLES, SignerRole, SCA_PROFILE_IDS, scaProfile, scaTypeMetadata, PID } from '../../sca-pid-config.js';
import { certificateValidityWindow, createGeneratedCertificate, extractCertificatePem, certificatePemToDerBase64, x509HashClientId, proveSigningKey, publicKeyOfStoredKey } from './keys.js';
import { importCertificate, parseCertificates, readSigningMaterial, validateCertificateChain } from './certificates.js';
import { buildCertificateAnchorLote } from '../../trust-registry/lote.js';
import { loadTrustSource, listTrustRegistrySources, resolveTrustCertificateChain } from '../../trust-registry/client.js';

export const ROLE_KEY = { sca: 'sca', pid: 'issuer', verifier: 'verifier', provider: 'provider' } as const;
const FIXTURE_TYPES = {
  sca: ['EUPubEAAProvidersList', 'ATTESTATION_PROVIDER', 'http://uri.etsi.org/TrstSvc/Svctype/EAA'],
  pid: ['EUPIDProvidersList', 'PID_PROVIDER', 'urn:waltid:trust-service:pid-issuer'],
  verifier: ['EUWRPRCProvidersList', 'RELYING_PARTY_PROVIDER', 'urn:waltid:trust-service:relying-party'],
  provider: ['EUWalletProvidersList', 'WALLET_PROVIDER', 'urn:waltid:trust-service:wallet-provider'],
} as const;
export function trustPolicy(config: ScaPidConfig, role: SignerRole) {
  const trust = config.trust[role];
  return { policy: 'etsi-trust-list', expectedEntityType: trust.kind === 'registered' ? trust.entityType : FIXTURE_TYPES[role][1],
    expectedServiceType: trust.kind === 'registered' ? trust.serviceType : FIXTURE_TYPES[role][2], requireAuthenticated: true, allowStaleSource: false };
}
const chainDescriptors = (chain: string[]) => chain.map(pemEncodedCertificate => ({ type: 'pem-encoded-x509-certificate-descriptor', pemEncodedCertificate }));

export async function setupScaPid(ctx: CommandContext, config: ScaPidConfig): Promise<void> {
  const { tenantPath: target, orgClient: api } = ctx;
  const material: Partial<Record<SignerRole, Awaited<ReturnType<typeof readSigningMaterial>>>> = {};
  const sources: Partial<Record<SignerRole, { content: string; anchors: string[] }>> = {};
  // Read and validate every supplied item before the first API mutation.
  for (const role of SIGNER_ROLES) {
    const trust = config.trust[role];
    if (trust.kind !== 'registered') continue;
    material[role] = await readSigningMaterial(trust, role);
    sources[role] = { content: await readFile(trust.sourceFile, 'utf8'), anchors: parseCertificates(await readFile(trust.sourceSignerFile, 'utf8')).map(c => c.toString()) };
    assert(sources[role]!.content.trim(), 'Trust source is empty');
  }
  const orgPath = `/v1/admin/organizations/${config.organization}`;
  const org = await ctx.client.get(orgPath, { allow: [404] });
  const existingTenant = org.status !== 404 && (await ctx.listResources(config.organization)).some(n => n._id === target);
  for (const value of Object.values(material)) if (!existingTenant) assert(value.jwk, 'A new registered signer requires its private key input');
  const suppliedKeys = Object.values(material).map(value => value.chain[0].publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
  assert.equal(new Set(suppliedKeys).size, suppliedKeys.length, 'Signing roles must use distinct keys');
  const ensureResource = (parent: string, id: string, body: Record<string, unknown>, kind = 'services') => ctx.ensureResource(parent, id, body, kind, !existingTenant);
  const fixtureRoot = SIGNER_ROLES.some(role => config.trust[role].kind === 'fixture');
  const keyRef = (role: SignerRole) => `${target}.kms.${ROLE_KEY[role]}`;
  const certPath = (id: string) => `/v1/${target}.x509-store.${id}/x509-store-api/certificates`;
  const chains = {} as Record<SignerRole, string[]>;
  let rootPem = '';

  if (existingTenant) {
    const existingCertificates: Record<string, X509Certificate> = {};
    // An incomplete existing installation needs explicit repair, not silent key replacement.
    for (const id of [...(fixtureRoot ? ['iaca'] : []), ...SIGNER_ROLES.map(role => ROLE_KEY[role])]) {
      const key = await api.get(`/v1/${target}.kms.${id}/kms-service-api/keys/view`);
      const certificate = new X509Certificate(extractCertificatePem((await api.get(certPath(id))).data) ?? '');
      assert(certificate.publicKey.equals(publicKeyOfStoredKey(key.data)), 'Existing key and certificate differ');
      assert(Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now() + 86_400_000, 'Existing certificate requires renewal');
      await proveSigningKey(api, `${target}.kms.${id}`, certificate.publicKey);
      existingCertificates[id] = certificate;
      if (id === 'iaca') rootPem = certificate.toString();
    }
    const roleKeys = SIGNER_ROLES.map(role => existingCertificates[ROLE_KEY[role]].publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
    assert.equal(new Set(roleKeys).size, roleKeys.length, 'Existing signing roles share a key');
    for (const role of SIGNER_ROLES) {
      const supplied = material[role];
      const current = existingCertificates[ROLE_KEY[role]];
      if (supplied) assert.equal(current.fingerprint256, supplied.chain[0].fingerprint256, 'Changing a registered certificate requires explicit renewal');
      else await validateCertificateChain([current, existingCertificates.iaca], [existingCertificates.iaca], role);
    }
  }
  if (org.status === 404) await ctx.client.post('/v1/admin/organizations', { _id: config.organization, profile: { name: config.branding.name } });
  await ensureResource(config.organization, config.tenant, { name: 'SCA and PID evaluation' }, 'tenants');
  for (const [id, type] of [['kms', 'kms'], ['wallet-kms', 'kms'], ['credentials', 'credential-store'], ['x509-store', 'x509-store']]) {
    await ensureResource(target, id, { type });
  }
  await ensureResource(target, 'x509', { type: 'x509-service', dependencies: [`${target}.kms`, `${target}.x509-store`] });

  async function ensureKey(id: string, jwk?: object) {
    const path = `/v1/${target}.kms.${id}/kms-service-api/keys`;
    const existing = await api.get(`${path}/view`, { allow: [404] });
    if (existing.status === 404) {
      assert(!existingTenant, 'Existing installation is missing a signing key');
      if (jwk) await api.post(`${path}/import/jwk`, jwk);
      else await api.post(`${path}/generate`, { backend: 'jwk', keyType: 'secp256r1' });
    }
  }
  async function generatedCertificate(id: string, request: Parameters<typeof createGeneratedCertificate>[2]) {
    const existing = await api.get(certPath(id), { allow: [404] });
    if (existing.status === 200) return extractCertificatePem(existing.data)!;
    assert(!existingTenant, 'Existing installation is missing a certificate');
    return createGeneratedCertificate(ctx, id, { storeRef: `${target}.x509-store`, ...request }, id, undefined, { serviceReference: `${target}.x509`, createOnly: true });
  }
  if (fixtureRoot) {
    await ensureKey('iaca');
    rootPem = await generatedCertificate('iaca', { selfSigned: true, certificateProfile: 'iso-iaca-root',
      subjectKeyRef: `${target}.kms.iaca`, subjectDn: 'C=AT,CN=Example evaluation root', ...certificateValidityWindow(365),
      issuerAlternativeNames: [{ type: 'uri', name: 'https://example.invalid/evaluation-ca' }], metadata: { vicalDocType: [PID] } });
  }
  for (const role of SIGNER_ROLES) {
    const supplied = material[role];
    const id = ROLE_KEY[role];
    if (supplied) {
      const existing = await api.get(`/v1/${keyRef(role)}/kms-service-api/keys/view`, { allow: [404] });
      if (existing.status === 404) assert(supplied.jwk, 'A new registered signer requires its private key input');
      await ensureKey(id, supplied.jwk);
      await importCertificate(api, `${target}.x509-store.${id}`, keyRef(role), supplied.chain[0]);
      chains[role] = supplied.chain.map(c => c.toString());
    } else {
      await ensureKey(id);
      const leaf = await generatedCertificate(id, {
        ...(role === 'pid' ? { certificateProfile: 'iso-document-signer' } : { basicConstraintsCa: false, keyUsage: ['digitalSignature'], extendedKeyUsageOids: ['1.3.6.1.5.5.7.3.2'] }),
        issuerCertificateRef: `${target}.x509-store.iaca`, issuerKeyRef: `${target}.kms.iaca`, subjectKeyRef: keyRef(role),
        subjectDn: `C=AT,CN=Example ${role} signer`, ...certificateValidityWindow(180),
        issuerAlternativeNames: [{ type: 'uri', name: 'https://example.invalid/evaluation-ca' }], crlDistributionPointUri: 'https://example.invalid/evaluation.crl',
      });
      chains[role] = [leaf, rootPem];
      await validateCertificateChain(chains[role].map(p => new X509Certificate(p)), [new X509Certificate(rootPem)], role);
    }
    await proveSigningKey(api, keyRef(role), new X509Certificate(chains[role][0]).publicKey);
  }
  assert.equal(new Set(SIGNER_ROLES.map(role => new X509Certificate(chains[role][0]).publicKey.export({ format: 'der', type: 'spki' }).toString('base64'))).size, SIGNER_ROLES.length, 'Signing roles must use distinct keys');

  const registry = `${target}.trust`;
  const sourceAnchors = [...new Set([...Object.values(sources).flatMap(s => s.anchors), ...(fixtureRoot ? [rootPem] : [])])];
  await ensureResource(target, 'trust', { type: 'trust-registry', validateSignaturesByDefault: true,
    sourceAcceptancePolicy: 'REQUIRE_AUTHENTICATED', trustedSourceSignerCertificates: sourceAnchors });
  for (const role of SIGNER_ROLES) {
    const trust = config.trust[role];
    const sourceId = `sca-pid-${role}`;
    const existing = (await listTrustRegistrySources(ctx, registry)).find(s => s.sourceId === sourceId);
    let content = sources[role]?.content;
    let sourceUrl: string;
    if (trust.kind === 'registered') sourceUrl = `${trust.sourceUrl}#sha256=${createHash('sha256').update(content!).digest('hex')}`;
    else {
      sourceUrl = `urn:waltid:quickstart:${role}:${new X509Certificate(chains[role][0]).fingerprint256}`;
      if (!existing) {
        const lote = buildCertificateAnchorLote(sourceId, 'AT', [{ id: role, legalName: `Example ${role}`, country: 'AT', serviceName: `Example ${role} service`,
          serviceType: FIXTURE_TYPES[role][2], certificatePem: chains[role][0] }], `http://uri.etsi.org/19602/LoTEType/${FIXTURE_TYPES[role][0]}`);
        content = (await api.post<{ jwt: string }>(`/v1/${target}.kms.iaca/kms-service-api/keys/sign`, {
          format: 'jwt', plaintext: lote, headers: { x5c: [certificatePemToDerBase64(rootPem)] },
        })).data.jwt;
      }
    }
    if (existing) assertConfigurationSubset(existing, { sourceUrl, assurance: { accepted: true, authenticityState: 'AUTHENTICATED' } });
    else {
      assert(!existingTenant, 'Existing installation is missing a trust source');
      const result = await loadTrustSource(ctx, { sourceId, sourceUrl, content, acceptancePolicy: 'REQUIRE_AUTHENTICATED', trustedSignerCertificates: sources[role]?.anchors ?? [rootPem] }, registry);
      assert(result.success && result.assurance?.accepted && result.assurance.authenticityState === 'AUTHENTICATED', 'Trust source was not authenticated');
    }
    const policy = trustPolicy(config, role);
    const decision = await resolveTrustCertificateChain(ctx, { certificateChainPemOrDer: chains[role], expectedEntityType: policy.expectedEntityType, expectedServiceType: policy.expectedServiceType }, registry);
    assert(decision.decision === 'TRUSTED' && decision.sourceFreshness === 'FRESH' && decision.sourceAssurance.authenticityState === 'AUTHENTICATED', 'Registration must be authenticated, fresh and trusted');
  }

  await ensureResource(target, 'status', { type: 'credential-status', config: { registry: { type: 'database' } }, dependencies: [`${target}.kms`] });
  for (const [role, format] of [['sca', 'JWT'], ['pid', 'CWT']] as const) {
    const ref = `${target}.status.${role}-list`;
    const body = { keyReference: keyRef(role), x5c: chains[role], config: { type: 'TokenStatusList', format, ttl: 2 } };
    const existing = (await ctx.listResources(`${target}.status`)).find(n => n._id === ref);
    if (existing) assertConfigurationSubset(existing.config?.data, body);
    else {
      assert(!existingTenant, 'Existing installation is missing a status list');
      await api.post(`/v1/${ref}/credential-status-service-api/status-credential/create`, body);
    }
  }
  await ensureResource(target, 'provider', { type: 'wallet-provider', signingKeyId: keyRef('provider'), profile: 'openid4vci', composition: 'wia_ka',
    wia: { ttlSeconds: 3600, walletName: config.branding.name }, ka: { ttlSeconds: 3600, keyStorage: ['software'] }, activationTrust: 'unverified-demo',
    dependencies: [`${target}.kms`], x5Chain: chainDescriptors(chains.provider) });
  await ensureResource(target, 'wallet', { type: 'wallet2', dependencies: [`${target}.wallet-kms`, `${target}.credentials`, `${target}.provider`, registry],
    configuration: { requestObjectX509Trust: { x509TrustAnchorsPem: material.verifier?.anchors.map(c => c.toString()) ?? [rootPem] } } });
  await ensureResource(target, 'verifier', { type: 'verifier2', baseUrl: ctx.orgBaseUrl, clientId: x509HashClientId(chains.verifier[0]),
    dependencies: [`${target}.kms`, registry], x5c: chains.verifier.map(certificatePemToDerBase64) });
  const providerAnchors = material.provider?.anchors.map(c => c.toString()) ?? [rootPem];
  const attestation = { verificationMethod: { type: 'x509-chain', trustedRootCertificatesPem: providerAnchors, expectedEntityType: 'WALLET_PROVIDER' } };
  const proof = { jwt: { proof_signing_alg_values_supported: ['ES256'], key_attestations_required: { key_storage: ['software'] } } };
  const configurations: Record<string, unknown> = {};
  for (const id of [...SCA_PROFILE_IDS, ...SCA_PROFILE_IDS.map(id => id + '-base'), ...(!config.typeParents ? ['sca-payment-base'] : [])]) {
    configurations[id] = { format: 'dc+sd-jwt', vct: `{vctBaseURL}/${id}`, scope: id,
      cryptographic_binding_methods_supported: ['jwk'], credential_signing_alg_values_supported: ['ES256'], proof_types_supported: proof };
  }
  configurations.pid = { format: 'mso_mdoc', doctype: PID, scope: 'pid', credential_signing_alg_values_supported: [-7], cryptographic_binding_methods_supported: ['cose_key'], proof_types_supported: proof };
  await ensureResource(target, 'issuer', { type: 'issuer2', baseUrl: ctx.orgBaseUrl, kms: `${target}.kms`, tokenKeyId: keyRef('sca'),
    dependencies: [`${target}.kms`, `${target}.status`, registry],
    issuerDisplayConfiguration: [{ name: config.branding.name, locale: 'en', ...(config.branding.logo && { logo: { uri: config.branding.logo, alt_text: config.branding.name } }) }],
    clientAuthenticationConfig: { supportedMethods: [{ type: 'client-attestation', config: attestation }] }, keyAttestationConfig: attestation,
    credentialConfigurations: configurations, sdJwtVcTypeMetadataConfiguration: scaTypeMetadata(config.branding, config.typeParents) });
  for (const id of [...SCA_PROFILE_IDS, 'pid'] as const) {
    const role = id === 'pid' ? 'pid' : 'sca';
    const path = `/v2/${target}.issuer.${id}/issuer-service-api/credentials/profiles`;
    const body = { name: id === 'pid' ? 'Example PID' : scaProfile(id, config.branding).name, credentialConfigurationId: id,
      issuerKeyId: keyRef(role), x5Chain: chainDescriptors(chains[role]), credentialStatus: { statusCredentialConfig: `${target}.status.${role}-list`, initialStatus: '0x0' },
      ...(id === 'pid' ? { credentialData: { [PID]: { family_name: 'Example', given_name: 'Alice', birth_date: '1990-01-01', issuing_country: 'AT', issuing_authority: config.branding.name } } } : scaProfile(id, config.branding).issuance) };
    const existing = await api.get(path, { allow: [404] });
    if (existing.status === 404) {
      assert(!existingTenant, 'Existing installation is missing an issuance profile');
      await api.post(path, body);
    }
    else assertConfigurationSubset(existing.data, body);
  }
  await ensureScaPidRole(ctx, !existingTenant);
}

export async function ensureScaPidRole(ctx: CommandContext, createIfMissing = true): Promise<void> {
  const grants = {
    issuer: ['issuer-credential-issue', 'issuer-session-view'],
    wallet: ['receive-credentials-full', 'isolated-present-credentials'],
    verifier: ['create-verifier-session-2', 'verifier-credentials-sessions-view'],
    status: ['credential-status.update'], 'wallet-kms': ['generate-key'], provider: ['read-wallet-unit'],
  };
  const permissions = Object.entries(grants).flatMap(([service, actions]) => actions.map(action => ({ target: `${ctx.tenantPath}.${service}`, action, operation: 'ADD' })));
  const path = `/v1/${ctx.tenantPath}.journey-operator/roles-api/roles`;
  const existing = await ctx.orgClient.get(`${path}/view`, { allow: [404] });
  if (existing.status === 404) {
    assert(createIfMissing, 'Existing installation is missing its scoped role');
    await ctx.orgClient.post(`${path}/create`, { name: 'SCA/PID flow operator', permissions });
  }
  else assertConfigurationSubset(existing.data, { permissions });
}
