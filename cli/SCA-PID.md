# SCA and PID setup and flows

This scenario provisions one tenant and exercises SCA-card/DPC and SCA-User SD-JWT credentials, each jointly presented with an mdoc PID. It uses the normal quickstart HTTP, certificate and trust helpers. The example contains fictional data and explicitly selects fixture trust for all four signing roles.

## Provision and run

Use a reviewed Enterprise API and matching quickstart revision. Enable `issuer2`, `wallet-provider` and `trust-registry` in addition to the deployment's normal features. Node.js, OpenSSL 3 and the CLI dependencies (`npm ci` in `cli/`) are required.

Copy `sca-pid.example.json` to a private directory outside the checkout. Set the API origin, organization, tenant and branding. The API must route the organization hostname (`<organization>.<base-host>`) to the same deployment. HTTPS certificate verification remains enabled. The explicit `local` transport is restricted to localhost names and is for disposable development only.

Supply an operator token through `SCA_PID_API_TOKEN`, then run from `cli/`:

```sh
npm run walt -- --setup-sca-pid /private/scenario.json
```

Setup creates the tenant, separate issuer and holder KMS services, credential store, X.509 store/service, trust registry, status service, wallet provider, wallet, issuer, verifier and `journey-operator` role. It provisions separate SCA, PID, verifier and provider signing keys, plus four holder keys (one SCA key and one PID key per profile). Service IDs use the shared `RESOURCES` constants. Supplied key/certificate material is validated before provisioning; existing tenants are checked and reused. Missing or changed existing state requires an explicit operator repair. Setup never silently rotates a key, replaces a registration or resets a wallet. Tenants created by earlier versions of this draft with different resource names or permissions require explicit operator migration or a new sample tenant; setup does not silently adopt them.

Use the normal Enterprise API-key or account-role endpoints to assign `<organization>.<tenant>.journey-operator`. For a disposable API key, an operator:

1. Creates an API key at `POST /v1/<tenant-path>.<key-id>/apikeys-api/api-keys/create` with `{"name":"SCA/PID flow operator","expiration":"1h"}`.
2. Assigns it at `POST /v1/<tenant-path>.journey-operator/roles-api/roles/apikey/assign` with `{"apikey":"<tenant-path>.<key-id>"}`.
3. Delivers the returned token through an approved private channel. If assignment fails, deletes the newly created key at `DELETE /v1/<tenant-path>.<key-id>/apikeys-api/api-keys/delete`.

Replace `SCA_PID_API_TOKEN` with that scoped token and run:

```sh
npm run walt -- --flow-sca-pid /private/scenario.json
```

The role permits issuance, isolated presentation, session reads, wallet-provider reads and status updates only on the scenario's services. It grants no direct KMS permissions, including generation, signing, import or export, and no provisioning, role changes or access to sibling tenants. These commands require the explicit token and do not read administrator credentials or fall back to the default reset/setup flow.

The flow issues fresh synthetic credentials using the holder keys already provisioned by setup, retains the credentials, and selects those exact credentials for each presentation. Fictional subject and payment values live in `src/fixtures/sca-pid.ts`; shared HTTP, certificate and result helpers do not depend on the scenario. It checks signed/encrypted requests, encrypted responses, all required presentation checks, signature, status, role-specific authenticated/fresh trust, SCA validity, schema and metadata integrity. Controls cover each missing credential, wrong trust roles/schema, cross-request replay, revocation/restoration and missing payment authentication evidence. Status transitions use bounded polling.

## Registered trust and metadata

Each `trust` entry must explicitly select `fixture` or `registered`. Registered entries require:

| Field | Meaning |
|---|---|
| `chainFile` | Ordered PEM signing leaf and intermediates; no private keys |
| `anchorsFile` | Independently approved CA trust anchors |
| `publicKeySha256` | Approved SHA-256 hex fingerprint of the leaf public key's DER SubjectPublicKeyInfo |
| `keyFile` | Private JWK for a new imported signer; omit when checking an existing installation or running a journey |
| `sourceFile`, `sourceUrl` | Approved signed trust-list content and its stable provenance URL |
| `sourceSignerFile` | Independently approved trust-list signer certificates |
| `entityType`, `serviceType` | The registration's actual role and service type |
| `certificateProfile`, `dnsName` | For a verifier registration requiring WRPAC: `wrpac` and the approved DNS SAN; requires RSA-2048 |

Relative file paths resolve from the configuration directory. Private key inputs must be owner-only regular files. Import verifies key possession through the KMS, refuses certificate replacement and verifies the stored result. Obtain CSRs with the existing X.509 service's certificate-request API or the registration owner's offline tooling; supply the approved key and subject, verify the CSR signature/public-key fingerprint, and retain it privately. Never generate a replacement key merely to satisfy a portal's algorithm requirement.

SCA trust accepts the configured TSP/attestation role; PID requires `PID_PROVIDER`, the verifier requires the configured relying-party/access-certificate role, and provider trust requires `WALLET_PROVIDER`. Registration decisions must be authenticated, fresh and trusted. A fixture root or an unchecked trust list is not a substitute for missing registration material. PID credentials here contain example claims; they are not an assertion of full national PID conformity.

Optional `typeParents` maps both `sca-card-dpc` and `sca-user` to `{ "uri": "https://…", "integrity": "sha256-…" }`. Pin the actual published parent bytes using the SD-JWT metadata integrity format. The local branded types extend those published parents. Without this field the example uses a three-level local metadata chain and reports fixture metadata. Branding changes affect public issuer/type metadata; use neutral branding where the deployment relationship is confidential.

## Callbacks, payment authorization and results

Set `callbackUrl` and supply `SCA_PID_CALLBACK_TOKEN` to configure issuance and verification webhooks. The receiver must authenticate the bearer token, bound request size, acknowledge promptly, and retrieve authoritative session state through the normal scoped APIs. A callback configured by the CLI is not evidence that a receiver accepted it. The integration test demonstrates authenticated receipt and subsequent session reads.

Immediate and recurring payment requests fail closed without authentication evidence. Successful payment authorization additionally needs the Enterprise operator-owned authority feature and real factor evidence. A programmatic caller can pass a `ScaAuthorizer` to `flowScaPid`; it returns the signed grants for the selected credentials. The authority must independently authenticate the resolved request and user action. The callback input and a successful credential exchange are not authentication evidence. The CLI does not manufacture factors or claim that a synthetic authority authenticates a real user.

HTTP payloads, offer URLs, credentials, grants and callback tokens are not retained in the sensitive command's logs. Optional `SCA_PID_RESULT_FILE` writes an atomic owner-only JSON result into an owner-only directory. Each invocation prints a fresh run ID; results include that ID, operation, timestamps, the SHA-256 of the configuration bytes, and the source revision and dirty state (or `null` when Git provenance is unavailable). An old result is invalidated before configuration validation. If invalidation is unsafe or impossible, the command fails with an explicit instruction to discard the previous result. Consumers must require a successful exit and a successful result for the current run ID. Results report technical outcomes and the configured trust/metadata modes; deployment acceptance records remain private. Errors identify a stage and safe category without printing input paths, payloads or assertion values. The API and any webhook/authority have their own logging policies, which the CLI cannot control.

## Checks and deployment

```sh
npm run typecheck
npm test
HELM_BIN=/path/to/helm npm run test:helm
SCA_PID_TEST_CONFIG=/private/local-fixtures.json npm run test:sca-pid
```

`test:sca-pid` additionally requires `SCA_PID_TEST_ADMIN_TOKEN`; it refuses non-local or registered-trust configuration, creates fresh synthetic tenants, runs scoped access denials and callbacks, and deletes its disposable API key even on failure. It leaves synthetic tenant data in the disposable API. Run it against a dedicated test database.

For hosted deployment, use the [existing Helm deployment options](../README.md#helm-deployment-options) and [native licensing](../LICENSING.md#kubernetes--helm). The same chart options support other quickstart scenarios. Preserve the existing namespace, database, Secrets and storage, inspect the rendered chart against installed resources, and retain a rollback tuple before an upgrade. The chart does not establish registration or deployment acceptance.
