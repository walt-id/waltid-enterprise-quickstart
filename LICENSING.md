# Licensing the Enterprise Stack

The Enterprise API refuses to start without a valid license. This page covers activation, renewal,
disaster recovery and troubleshooting for the docker compose setup in this repository. For the
quickstart itself, see [README.md](README.md).

- [How licensing works](#how-licensing-works)
- [Before the first activation](#before-the-first-activation)
- [Online activation](#online-activation)
- [Offline activation](#offline-activation)
- [Credential lifetime and renewal](#credential-lifetime-and-renewal)
- [Disaster recovery with a pinned installation key](#disaster-recovery-with-a-pinned-installation-key)
- [Moving to another database](#moving-to-another-database)
- [Resetting license state](#resetting-license-state)
- [DEV vs PROD licenses](#dev-vs-prod-licenses)
- [Kubernetes / Helm](#kubernetes--helm)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## How licensing works

A license is an SD-JWT verifiable credential signed by walt.id. It is bound to the **installation
key** of your deployment, and walt.id keeps that binding: a license works only with the key it was
first activated with. By default the Enterprise API generates the installation key on first start
and stores it, encrypted, in the database together with the credential. Restarts reuse both.

`config/license.conf` reads these variables, which docker compose passes through from the shell or
`.env`. File paths are paths **inside the container**: compose mounts `./license` at `/license`.

| Variable                        | Purpose                                                                 |
|---------------------------------|-------------------------------------------------------------------------|
| `LICENSE_SEED_CREDENTIAL`       | Online activation: the `openid-credential-offer://...` from walt.id.    |
| `LICENSE_SEED_CREDENTIAL_FILE`  | Offline activation: the `.waltlicense` bundle, e.g. `/license/offline-license.waltlicense`. |
| `LICENSE_INSTALLATION_KEY_FILE` | Optional: an installation key you generated yourself (see [disaster recovery](#disaster-recovery-with-a-pinned-installation-key)). |
| `LICENSE_STATE_ENCRYPTION_KEY`  | Optional: the secret that encrypts the stored license state.            |
| `LICENSE_SERVER_URL`            | Optional: a different license server, for example a walt.id test environment. |

Set only the variables for the activation mode you use.

## Before the first activation

Two choices are hard to change once the stack is activated. Make them first.

**State encryption key.** `LICENSE_STATE_ENCRYPTION_KEY` encrypts the stored credential and
installation key. When it is unset, as in `.env`, the API generates a secret on first start and
shares it between replicas through the database, wrapped with a key compiled into the image. A copy
of the database plus the image is then enough to read the license state. Set your own value for any
deployment where that matters:

- Use at least 32 characters and supply it from a secret manager.
- Every replica must use the **same** value.
- Back it up together with the database. Losing it makes the stored license state unreadable.
- A wrong value fails startup closed. Live rotation is not supported.
- Never commit it and never copy it between deployments.

**Installation key.** Decide whether to keep the default, a key that exists only in the database, or
to pin a key you hold in your secret manager. Only a pinned key lets you recover an empty database
without walt.id. See
[Disaster recovery with a pinned installation key](#disaster-recovery-with-a-pinned-installation-key).

### Upgrading from a quickstart that shipped an example key

Earlier revisions of this repository shipped `LICENSE_STATE_ENCRYPTION_KEY` pre-filled with a shared
example value. A stack activated with that value now refuses to start:

```
License fleet state integrity verification failed: the stored license state was written with a
different LICENSE_STATE_ENCRYPTION_KEY than this process derives.
```

The stored state is intact; only the key changed. Either:

- **Keep the existing state.** Put the previous value back in `.env`. It was
  `waltid-enterprise-quickstart-license-state-key`. Treat it as a value to migrate away from: set your
  own secret on the next fresh activation.
- **Start clean.** Run `license reset --include-installation-key --confirm`, ask walt.id to unbind the
  installation, then activate again with a fresh credential offer.

## Online activation

Start with the credential offer you received from walt.id:

```bash
LICENSE_SEED_CREDENTIAL="openid-credential-offer://..." docker compose up
```

The offer is redeemed once. Later restarts use the stored credential, and the stack renews it
automatically against `https://license.walt.id`.

## Offline activation

For air-gapped deployments. The stack never contacts walt.id.

1. Create the installation request. Run it against the same compose project, database volume and
   `LICENSE_STATE_ENCRYPTION_KEY` you will run the API with. `<licenseId>` and `<organizationId>` are
   provided by walt.id:

   ```bash
   docker compose run --rm waltid-enterprise \
     license request <licenseId> <organizationId> \
     -o /license/installation-request.json
   ```

   This creates the installation key in the database. `installation-request.json` contains only the
   public key. The request is valid for 14 days; running the command again reuses the same key.

2. Send `license/installation-request.json` to walt.id. You get back a `.waltlicense` bundle. walt.id
   never sends a private key.

3. Save the bundle as `license/offline-license.waltlicense` and start:

   ```bash
   LICENSE_SEED_CREDENTIAL_FILE=/license/offline-license.waltlicense docker compose up
   ```

Do not point `LICENSE_INSTALLATION_KEY_FILE` at `installation-request.json`. That file is the public
request, and startup fails with `KeyTypeMissingException`.

## Credential lifetime and renewal

walt.id sets the credential lifetime per license, in whole days:

|                         | Online                                         | Offline                              |
|-------------------------|------------------------------------------------|--------------------------------------|
| Lifetime                | 4 to 14 days, default 4                        | 1 to 365 days                        |
| Renewal                 | Automatic, long before expiry                  | Manual, with a usage report          |
| License server outage   | Keeps running until expiry, plus 24 h grace    | Not applicable                       |
| After expiry            | 24 h grace, then restricted                    | Restricted immediately, no grace     |

walt.id can change the lifetime of an existing license. The change applies from the next renewal;
a credential that was already issued keeps its expiry. If your operations need a longer window to
survive a license server outage, ask walt.id for a longer online lifetime.

**Renewing an offline license.** Before the bundle expires:

1. Export the signed usage report with `POST /license/usage-report/export` (superadmin).
2. Send it to walt.id. You get back a new `.waltlicense`.
3. Replace `license/offline-license.waltlicense` and restart. A bundle with a newer issue date
   replaces the stored one.

The expiry date is in the startup log (`License credential updated ... expires=...`) and in
`GET /license/status`. The `LICENSE EXPIRY WARNING` log line appears only in the last 24 hours, so
do not wait for it; see [Monitoring](#monitoring).

## Disaster recovery with a pinned installation key

By default the installation key exists only in the database. If the database is lost and no backup
is restored, the key is lost too, and walt.id has to unbind the installation before the license works
again. To recover without walt.id, generate the key yourself, keep it in your secret manager, and
mount it with `LICENSE_INSTALLATION_KEY_FILE`. The license is bound to that key, so the same key and
the same `.waltlicense` activate any empty database.

Set this up before the first activation. A key already stored in the database cannot be replaced:
if the mounted file holds a different key, startup fails with `Configured installation key does not
match the fleet key in the shared database`. An installation that is already activated switches
once: run `license reset --include-installation-key --confirm`, ask walt.id to unbind, then follow
the steps below.

1. Generate the key once per environment (Node.js 18 or later, no dependencies):

   ```bash
   node scripts/generate-installation-key.mjs > license/installation-key.json
   ```

   The file is a private key (`{"type":"jwk","jwk":{...}}`). `license/` is git-ignored. Store a copy
   in your secret manager, never commit it, and never send it to walt.id. Use a separate key for every
   environment that has its own license.

2. Create the installation request with the key pinned. `<licenseId>` and `<organizationId>` are
   provided by walt.id:

   ```bash
   LICENSE_INSTALLATION_KEY_FILE=/license/installation-key.json \
   docker compose run --rm waltid-enterprise \
     license request <licenseId> <organizationId> \
     -o /license/installation-request.json
   ```

   The request's `installationId` equals the `kid` of your key file, which shows that the request
   uses your key and not one generated in the database:

   ```bash
   jq -r .jwk.kid license/installation-key.json
   jq -r .request.installationId license/installation-request.json
   ```

   Send `license/installation-request.json` to walt.id and save the bundle you get back as
   `license/offline-license.waltlicense`.

3. Start with both files. Set the two variables on every start, for example in `.env`, so that an
   empty database is activated without anyone having to remember them:

   ```bash
   LICENSE_SEED_CREDENTIAL_FILE=/license/offline-license.waltlicense \
   LICENSE_INSTALLATION_KEY_FILE=/license/installation-key.json \
   docker compose up
   ```

4. Rehearse the recovery on a test environment. `docker compose down -v` deletes **all** data of
   this stack, not only the license state:

   ```bash
   docker compose down -v
   ```

   Start again with the command from step 3. The API comes up on the empty database with the same
   installation key and the license `ACTIVE`, without contacting walt.id:

   ```bash
   docker compose logs waltid-enterprise | grep -E 'installation key|restriction='
   ```

What this does and does not cover:

- It recovers the license only. Organizations, tenants, keys and credentials come from your database
  backup. When you restore one, keep the newest `.waltlicense` mounted: at startup a newer bundle
  replaces the older credential stored in the backup.
- Usage counters restart at zero on an empty database. walt.id rejects a usage report whose counters
  went backwards, so tell walt.id about the recovery before you submit the next renewal.
- Online licenses: the pinned key removes the need for an unbind, but an empty database still needs a
  new credential offer from walt.id, because an offer is redeemed only once.

## Moving to another database

The license is bound to the installation key, not to the database. This also applies to moving
between MongoDB and DocumentDB (`docker-compose-documentdb.yml`).

- **With a pinned key**, start the new stack with the same `LICENSE_INSTALLATION_KEY_FILE`, plus the
  latest `.waltlicense` (offline) or a new credential offer from walt.id (online).
- **Without a pinned key**, the key stays in the old database, and activating the new one creates a
  different key. walt.id has to unbind the old installation first, so talk to walt.id before you
  switch.

Run only one stack per license at a time.

## Resetting license state

The container CLI has two license subcommands: `license request` (above) and `license reset`, which
discards what is stored in the database.

| Command                                              | Effect                                                        | Needs walt.id                                                                      |
|------------------------------------------------------|---------------------------------------------------------------|------------------------------------------------------------------------------------|
| `license reset --confirm`                            | Removes the stored credential. Your installation key is kept. | No. Ask for a fresh credential offer, start with it, and the existing key rebinds. |
| `license reset --include-installation-key --confirm` | Also discards the installation key.                           | **Yes.** walt.id has to unbind the installation.                                   |

```bash
docker compose run --rm waltid-enterprise license reset --confirm
```

Prefer the first form. Once you discard the installation key, the license still points at it and
activation fails until walt.id unbinds it. Use `--include-installation-key` only when you discard
the environment, or when `LICENSE_STATE_ENCRYPTION_KEY` was lost: the installation key is encrypted
with that secret and cannot be kept anyway.

## DEV vs PROD licenses

`config/_features.conf` enables `dev-mode`, which exposes debug endpoints and therefore requires a
**DEV** license. A PROD license refuses to start while `dev-mode` is enabled, and vice versa. Remove
`dev-mode` from `enabledFeatures` before using a PROD license.

## Kubernetes / Helm

The Helm chart reads license material from one pre-provisioned Secret, named by
`license.secretName` in `helm/values.yaml`. It needs either `seed-credential` (online) or
`offline-license.waltlicense` with `license.offline: true` (offline). `state-encryption-key` is
optional, as described above. For offline activation, the `license.installationRequest` Job creates
the installation key in the database and prints the request.

The chart does not support the pinned-key recovery yet: the `installationRequest` Job does not mount
`installation-key.json`, so it would create a different key than the one the API loads. Leave
`license.provisionInstallationKeyFile` at `false`.

## Monitoring

With the `prometheus` feature enabled in `config/_features.conf`, the API exposes Prometheus metrics
on the port set in `config/prometheus.conf`, including:

- `enterprise_license_seconds_until_expiry`: alert well before it reaches zero.
- `enterprise_license_restriction_state`: 0 ACTIVE, 1 GRACE, 2 RESTRICTED, 3 UNLICENSED.
- `enterprise_license_heartbeat_consecutive_failures`: online renewal is failing.

`GET /license/status` (superadmin) reports the restriction state, the expiry countdown and any
warning.

## Troubleshooting

- **The container exits during startup.** The license was rejected. `docker compose logs
  waltid-enterprise` states the reason: expired, not bound to this installation, DEV/PROD mismatch,
  missing seed, `KeyTypeMissingException` (`LICENSE_INSTALLATION_KEY_FILE` points at the request
  file), or `License fleet state integrity verification failed` (a different
  `LICENSE_STATE_ENCRYPTION_KEY`, or leftover license state from another `license request` run).
- **Every endpoint returns `503 Enterprise API is unavailable because the license is not active`.**
  The process started, but the license is not active. `GET /livez` still responds in this state.
- **`Heartbeat failed: ... 403 Forbidden: License '<id>' has no installation binding`.** The license
  is not bound to your installation. Either the installation key was discarded with
  `license reset --include-installation-key` and walt.id has not unbound the license yet, or the
  license is bound to a different installation. Ask walt.id to unbind it, then start with a fresh
  credential offer. A license is bound to one installation at a time.
- **`Configured installation key does not match the fleet key in the shared database`.** The mounted
  `LICENSE_INSTALLATION_KEY_FILE` holds a different key than the one already stored. Mount the
  original key, or see [Disaster recovery](#disaster-recovery-with-a-pinned-installation-key) for
  switching an existing installation.
