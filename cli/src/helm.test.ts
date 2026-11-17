import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { parseAllDocuments, stringify } from 'yaml';

function render(values: object = {}) {
  return parseAllDocuments(execFileSync(process.env.HELM_BIN ?? 'helm', ['template', 'example', '../helm', '-f', '-'],
    { input: stringify(values), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })).map(d => d.toJSON()).filter(Boolean);
}
const containers = (docs: any[]) => docs.filter(d => ['Deployment', 'Job'].includes(d.kind)).flatMap(d => d.spec.template.spec.containers);

test('API and offline bootstrap share immutable image, private config, encryption and pre-provisioned identity', () => {
  const digest = 'sha256:' + 'a'.repeat(64);
  const docs = render({ api: { existingConfigSecret: 'private-config', image: { digest }, hpa: { minReplicas: 1, maxReplicas: 1 },
    strategy: { type: 'Recreate' }, extraEnv: [{ name: 'WALLET2_SCA_AUTHORITY_CONFIG', value: '/authority/config.json' }],
    extraVolumes: [{ name: 'replay', persistentVolumeClaim: { claimName: 'retained-replay' } }],
    extraVolumeMounts: [{ name: 'replay', mountPath: '/replay' }] }, web: { enabled: false },
    license: { secretName: 'retained-license', offline: true, provisionInstallationKeyFile: true,
      installationRequest: { enabled: true, licenseId: 'synthetic-license', organizationId: 'example' } } });
  assert(!docs.some(d => ['Secret', 'ConfigMap', 'PersistentVolumeClaim'].includes(d.kind)), 'Upgrade must not replace existing secrets or storage');
  const workloads = docs.filter(d => ['Deployment', 'Job'].includes(d.kind));
  assert.equal(workloads.length, 2);
  for (const workload of workloads) {
    const pod = workload.spec.template.spec, container = pod.containers[0];
    assert.equal(container.image, 'waltid/waltid-enterprise-api@' + digest);
    assert.deepEqual(pod.volumes.find((v: any) => v.name === 'waltid-enterprise-api-config').secret, { secretName: 'private-config' });
    assert.deepEqual(container.env.find((e: any) => e.name === 'LICENSE_STATE_ENCRYPTION_KEY').valueFrom.secretKeyRef,
      { name: 'retained-license', key: 'state-encryption-key', optional: true });
    assert.equal(container.env.find((e: any) => e.name === 'LICENSE_INSTALLATION_KEY_FILE').value, '/license/installation-key.json');
    assert(pod.volumes.some((v: any) => v.secret?.secretName === 'retained-license' && v.secret.items.some((i: any) => i.key === 'installation-key.json')));
  }
  const deployment = workloads.find(d => d.kind === 'Deployment');
  const hpa = docs.find(d => d.kind === 'HorizontalPodAutoscaler');
  assert.equal(hpa.spec.minReplicas, 1);
  assert.equal(hpa.spec.maxReplicas, 1);
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  assert.equal(deployment.spec.template.spec.volumes.find((v: any) => v.name === 'replay').persistentVolumeClaim.claimName, 'retained-replay');
  const job = workloads.find(d => d.kind === 'Job');
  assert(!job.spec.template.spec.volumes.some((v: any) => v.secret?.items?.some((i: any) => i.key === 'offline-license.waltlicense')), 'An unlicensed bootstrap must not require the returned bundle');
});

test('defaults remain compatible and online activation can use the same existing installation key', () => {
  const defaults = render();
  assert.equal(containers(defaults).length, 2);
  assert(defaults.some(d => d.kind === 'ConfigMap'));
  const hpa = defaults.find(d => d.kind === 'HorizontalPodAutoscaler' && d.spec.scaleTargetRef.name.endsWith('-api'));
  assert.equal(hpa.spec.minReplicas, 1);
  assert.equal(hpa.spec.maxReplicas, 5);
  const docs = render({ web: { enabled: false }, license: { provisionInstallationKeyFile: true } });
  assert(containers(docs)[0].env.some((e: any) => e.name === 'LICENSE_INSTALLATION_KEY_FILE'));
  assert.throws(() => render({ api: { image: { digest: 'latest' } } }));
});
