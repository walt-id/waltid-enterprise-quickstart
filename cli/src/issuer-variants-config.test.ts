import assert from 'node:assert/strict';
import test from 'node:test';
import { CERT_IDS, KEY_IDS, STATUS_CONFIG_IDS } from './config.js';
import {
  ISSUER_VARIANT_IDS,
  buildIssuerVariantCredentialConfigurations,
  buildIssuerVariantSdJwtTypeMetadata,
  parseIssuerVariants,
  variantCredentialConfigurationId,
  variantDocSignerCertId,
  variantIssuerService,
  variantIssuerTarget,
  variantSigningKeyId,
  variantStatusConfigId,
} from './issuer-variants-config.js';

test('variants that share a service each get their own credential configuration', () => {
  const variants = parseIssuerVariants('mdoc, mdoc+status, sdjwt, sdjwt+status, w3c, w3c+status');
  // All six share issuer2-software, and an issuer binds each configuration to one profile only.
  assert.equal(new Set(variants.map(variantIssuerService)).size, 1);
  const ids = variants.map(variantCredentialConfigurationId);
  assert.equal(new Set(ids).size, ids.length);
  const configurations = buildIssuerVariantCredentialConfigurations();
  for (const id of ids) assert.ok(configurations[id], `missing configuration ${id}`);
});

test('SD-JWT vct is served by the issuer, and type metadata covers both SD-JWT configurations', () => {
  const configurations = buildIssuerVariantCredentialConfigurations() as Record<string, { vct?: string }>;
  for (const status of [false, true]) {
    const id = variantCredentialConfigurationId({ format: 'sdjwt', status });
    // The issuer fetches the vct when creating an offer, so it must be a URL the issuer answers.
    assert.match(configurations[id].vct ?? '', /^\{vctBaseURL\}\//);
    assert.ok(buildIssuerVariantSdJwtTypeMetadata()[id]);
  }
});

test('W3C configurations accept the did:jwk the default wallet holds', () => {
  const configurations = buildIssuerVariantCredentialConfigurations() as Record<
    string,
    { cryptographic_binding_methods_supported?: string[] }
  >;
  const w3c = configurations[variantCredentialConfigurationId({ format: 'w3c', status: false })];
  assert.ok(w3c.cryptographic_binding_methods_supported?.includes('did:jwk'));
});

test('parseIssuerVariants canonicalises toggle order and drops duplicates', () => {
  const variants = parseIssuerVariants(' mdoc , sdjwt+kms+status, SDJWT+status+kms ,w3c+signed');
  assert.deepEqual(variants.map((v) => v.name), ['mdoc', 'sdjwt+status+kms', 'w3c+signed']);
  assert.deepEqual(variants[1], {
    name: 'sdjwt+status+kms',
    format: 'sdjwt',
    status: true,
    kms: true,
    signedMetadata: false,
  });
});

test('parseIssuerVariants rejects unknown formats, toggles and empty input', () => {
  assert.throws(() => parseIssuerVariants('pid'), /Unknown issuer variant format 'pid'/);
  assert.throws(() => parseIssuerVariants('mdoc+hsm'), /Unknown issuer variant toggle 'hsm'/);
  assert.throws(() => parseIssuerVariants(' , '), /No issuer variants given/);
});

test('signing key and metadata signing select the service, format and status the profile', () => {
  const [software, awsKms, awsKmsSigned, softwareSigned] = parseIssuerVariants(
    'mdoc+status, mdoc+status+kms, mdoc+status+kms+signed, w3c+signed'
  );
  assert.equal(variantIssuerTarget('waltid.t1', software), 'waltid.t1.issuer2-software.mdoc-status');
  assert.equal(variantIssuerTarget('waltid.t1', awsKms), 'waltid.t1.issuer2-aws-kms.mdoc-status');
  assert.equal(variantIssuerTarget('waltid.t1', awsKmsSigned), 'waltid.t1.issuer2-aws-kms-signed-metadata.mdoc-status');
  assert.equal(variantIssuerTarget('waltid.t1', softwareSigned), 'waltid.t1.issuer2-software-signed-metadata.w3c');
});

test('kms variants use the AWS KMS key and its certificate, others the software key', () => {
  const [software, kms] = parseIssuerVariants('mdoc, mdoc+kms');
  assert.equal(variantSigningKeyId(software), KEY_IDS.issuerSigningKey);
  assert.equal(variantDocSignerCertId(software), CERT_IDS.docSignerCert);
  assert.equal(variantSigningKeyId(kms), ISSUER_VARIANT_IDS.awsKmsSigningKey);
  assert.equal(variantDocSignerCertId(kms), ISSUER_VARIANT_IDS.awsKmsDocSignerCert);
});

test('each format and signing key has its own status list', () => {
  const [mdoc, sdjwt, w3c, mdocKms, sdjwtKms, w3cKms] = parseIssuerVariants(
    'mdoc+status, sdjwt+status, w3c+status, mdoc+status+kms, sdjwt+status+kms, w3c+status+kms'
  );
  assert.equal(variantStatusConfigId(mdoc), STATUS_CONFIG_IDS.tokenStatusListCwt);
  assert.equal(variantStatusConfigId(sdjwt), ISSUER_VARIANT_IDS.tokenStatusListJwt);
  assert.equal(variantStatusConfigId(w3c), ISSUER_VARIANT_IDS.bitstringStatusList);
  assert.equal(variantStatusConfigId(mdocKms), ISSUER_VARIANT_IDS.tokenStatusListCwtAwsKms);
  assert.equal(variantStatusConfigId(sdjwtKms), ISSUER_VARIANT_IDS.tokenStatusListJwtAwsKms);
  assert.equal(variantStatusConfigId(w3cKms), ISSUER_VARIANT_IDS.bitstringStatusListAwsKms);
});
