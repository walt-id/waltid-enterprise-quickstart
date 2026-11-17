import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const fingerprint = (key: import('node:crypto').KeyObject) => createHash('sha256').update(key.export({format: 'der', type: 'spki'})).digest('hex');
const exec = promisify(execFile);

// OpenSSL independently issues the test chain; production validation never mints it.
export async function certificateFixture(directory: string, profile: 'wrpac' | 'pid' = 'wrpac') {
  const root = join(directory, 'root.pem'), rootKey = join(directory, 'root.key');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', rootKey, '-out', root, '-days', '3', '-subj', '/CN=Synthetic Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  const pair = profile === 'wrpac' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await writeFile(join(directory, 'leaf.key'), pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await exec('openssl', ['req', '-new', '-key', join(directory, 'leaf.key'), '-out', join(directory, 'leaf.csr'), '-subj', '/CN=verifier.example.invalid']);
  await writeFile(join(directory, 'extensions'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:verifier.example.invalid\nextendedKeyUsage=' + (profile === 'pid' ? '1.0.18013.5.1.2' : 'clientAuth') + '\n');
  await exec('openssl', ['x509', '-req', '-in', join(directory, 'leaf.csr'), '-CA', root, '-CAkey', rootKey, '-set_serial', '2', '-days', '2', '-extfile', join(directory, 'extensions'), '-out', join(directory, 'leaf.pem')]);
  const anchorsPem = await readFile(root, 'utf8'), leafPem = await readFile(join(directory, 'leaf.pem'), 'utf8');
  return { pair, leafPem, options: { chainPem: leafPem + anchorsPem, anchorsPem,
    expectedPublicKeySha256: fingerprint(pair.publicKey) } };
}
