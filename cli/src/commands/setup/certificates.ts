import assert from 'node:assert/strict';
import { X509Certificate, createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type JsonWebKey } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient } from '../../http/client.js';
import { extractCertificatePem, proveSigningKey } from './keys.js';
import { TrustConfiguration } from '../../sca-pid-config.js';

const exec = promisify(execFile);
export function parseCertificates(pem: string): X509Certificate[] {
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const blocks = pem.match(pattern);
  assert(blocks?.length && !pem.replace(pattern, '').trim(), 'Expected certificates only');
  const certificates = blocks.map(block => new X509Certificate(block));
  assert.equal(new Set(certificates.map(c => c.fingerprint256)).size, certificates.length, 'Duplicate certificate');
  return certificates;
}

export async function validateCertificateChain(chain: X509Certificate[], anchors: X509Certificate[], purpose: 'sca' | 'pid' | 'verifier' | 'provider'): Promise<void> {
  const leaf = chain[0];
  assert(leaf && !leaf.ca && anchors.length > 0, 'A signing leaf and independent anchors are required');
  for (const certificate of [...chain, ...anchors]) {
    assert(Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now() + 86_400_000, 'Certificate needs renewal');
  }
  assert(anchors.every(c => c.ca && c.verify(c.publicKey)), 'Expected independent self-signed CA anchors');
  for (let i = 1; i < chain.length; i++) {
    assert(chain[i].ca && chain[i - 1].checkIssued(chain[i]) && chain[i - 1].verify(chain[i].publicKey), 'Invalid certificate chain order');
  }
  if (purpose === 'pid') assert(leaf.keyUsage?.includes('1.0.18013.5.1.2'), 'PID certificate requires document-signer EKU');
  if (purpose === 'provider' || purpose === 'verifier') assert(leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.2'), 'Certificate requires client-authentication EKU');
  const key = leaf.publicKey;
  assert((key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') ||
    (purpose === 'verifier' && key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048), 'Unsupported signing key');
  const directory = await mkdtemp(join(tmpdir(), 'cli-certificate-'));
  try {
    await Promise.all([
      writeFile(join(directory, 'leaf.pem'), leaf.toString(), { mode: 0o600 }),
      writeFile(join(directory, 'chain.pem'), chain.slice(1).map(c => c.toString()).join('\n'), { mode: 0o600 }),
      writeFile(join(directory, 'anchors.pem'), anchors.map(c => c.toString()).join('\n'), { mode: 0o600 }),
    ]);
    const usage = (await exec('openssl', ['x509', '-in', join(directory, 'leaf.pem'), '-noout', '-ext', 'keyUsage'])).stdout;
    assert(usage.includes('Digital Signature') && !usage.includes('Certificate Sign'), 'Invalid signing key usage');
    try {
      await exec('openssl', ['verify', '-x509_strict', '-auth_level', '2', '-no-CApath', '-no-CAstore', '-CAfile', join(directory, 'anchors.pem'),
        ...(chain.length > 1 ? ['-untrusted', join(directory, 'chain.pem')] : []), join(directory, 'leaf.pem')], { timeout: 10_000 });
    } catch { throw new Error('Certificate chain failed independent-anchor validation'); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function assertPrivateKeyMatches(jwk: JsonWebKey, certificate: X509Certificate): void {
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
  assert(certificate.publicKey.equals(createPublicKey(privateKey)), 'Private key and certificate differ');
  const challenge = Buffer.from(randomUUID());
  assert(verify('sha256', challenge, certificate.publicKey, sign('sha256', challenge, privateKey)), 'Private key cannot sign for the certificate');
}

/** Validate all material before the caller begins resource writes. */
export async function readSigningMaterial(config: Extract<TrustConfiguration, { kind: 'registered' }>, purpose: 'sca' | 'pid' | 'verifier' | 'provider') {
  const chain = parseCertificates(await readFile(config.chainFile, 'utf8'));
  const anchors = parseCertificates(await readFile(config.anchorsFile, 'utf8'));
  await validateCertificateChain(chain, anchors, purpose);
  const key = chain[0].publicKey;
  assert.equal(createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex'), config.publicKeySha256, 'Certificate does not use the approved public key');
  if (config.certificateProfile === 'wrpac') {
    assert(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails?.modulusLength === 2048, 'WRPAC requires the approved RSA-2048 key');
    assert(chain[0].checkHost(config.dnsName!, { subject: 'never', wildcards: false }), 'Certificate does not contain the approved DNS SAN');
  }
  if (config.keyFile) {
    const info = await lstat(config.keyFile);
    assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'Private key input must be a private regular file');
  }
  const jwk: JsonWebKey | undefined = config.keyFile ? JSON.parse(await readFile(config.keyFile, 'utf8')) : undefined;
  if (jwk) assertPrivateKeyMatches(jwk, chain[0]);
  return { chain, anchors, jwk };
}

/** POST preserves an existing binding, including when another creator races us. */
export async function importCertificate(client: HttpClient, certificateReference: string, keyReference: string, certificate: X509Certificate): Promise<void> {
  await proveSigningKey(client, keyReference, certificate.publicKey);
  const path = `/v1/${certificateReference}/x509-store-api/certificates`;
  const existing = await client.get(path, { allow: [404] });
  if (existing.status === 404) await client.post(path, { certificatePem: certificate.toString() });
  else assert.equal(new X509Certificate(extractCertificatePem(existing.data) ?? '').fingerprint256, certificate.fingerprint256, 'Certificate replacement requires an explicit operation');
  const stored = await client.get(path);
  assert.equal(new X509Certificate(extractCertificatePem(stored.data) ?? '').fingerprint256, certificate.fingerprint256, 'Certificate readback differs');
}
