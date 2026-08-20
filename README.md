<div align="center">
<h1>walt.id Enterprise Stack Quickstart</h1>
 <span>by </span><a href="https://walt.id">walt.id</a>
 <p>Quickstart to get you up and running with the walt.id Enterprise Stack</p>

  <a href="https://walt.id/community">
  <img src="https://img.shields.io/badge/Join-The Community-blue.svg?style=flat" alt="Join community!" />
  </a>
  <a href="https://www.linkedin.com/company/walt-id/">
  <img src="https://img.shields.io/badge/-LinkedIn-0072b1?style=flat&logo=linkedin" alt="Follow walt_id" />
  </a>
</div>

This repository contains the quickstart CLI and docker-compose files to get you up and running with the walt.id Enterprise Stack for local development. It also contains useful resources to help you with the Enterprise Stack such as configuration files, migration scripts, deployment files and more.

# Get Started

Bring up the whole stack using docker-compose and explore the enterprise features via our CLI tool.

⚠️ Please note: You need to be an Enterprise Stack customer & have access to the private enterprise stack images, to use this quickstart.

## Licensing (required)

The Enterprise API refuses to start without a valid license, so configure this before bringing the
stack up. A license is an SD-JWT verifiable credential signed by walt.id and cryptographically bound
to your installation. It is configured in `config/license.conf`, which reads the `LICENSE_*`
environment variables passed through by docker-compose.

### License state encryption key

`LICENSE_STATE_ENCRYPTION_KEY` encrypts the persisted license credential and the installation
private key in MongoDB. It ships in `.env` with a development default, which is fine locally. For
any real deployment:

- Use at least 32 characters and supply it from a secret manager.
- Every replica must use the **same** value.
- Back it up together with MongoDB. Losing it makes the persisted license state unreadable.
- A wrong or missing key fails startup closed, and live dual-key rotation is not supported.

### Activation

Pick one of the two modes. After a successful first activation, the bound credential and installation
key are stored in MongoDB and later restarts reuse them, so an online offer is never redeemed twice.

**Online** - create a license in License Admin and pass the returned offer:

```bash
LICENSE_SEED_CREDENTIAL="openid-credential-offer://..." docker compose up
```

The stack then renews itself automatically against `https://license.walt.id`.

**Offline / air-gapped** - the stack never contacts walt.id.

First create an installation request. The keypair is generated inside your database and encrypted at
rest; the private key is never written to disk. An unlicensed API never starts, so this runs the image
directly rather than through `docker exec` or `kubectl exec`.

Docker Compose:

```bash
docker compose run --rm waltid-enterprise \
  license request <licenseId> <organizationId> \
  | sed -n '/^{/,/^}/p' > installation-request.json
```

Kubernetes with the Helm chart in `helm/`:

```bash
helm upgrade --install <release> ./helm \
  --set license.installationRequest.enabled=true \
  --set license.installationRequest.licenseId=<licenseId> \
  --set license.installationRequest.organizationId=<organizationId>

kubectl logs job/<release>-enterprise-stack-license-request \
  | sed -n '/^{/,/^}/p' > installation-request.json
```

Then disable the Job again with `--set license.installationRequest.enabled=false`. The `sed` step
extracts the JSON document so the result is correct even if the container logs alongside it.

Send `installation-request.json` to walt.id, which returns a `.waltlicense` bundle. For Compose, place
it in `license/` (git-ignored) and start the stack:

```bash
LICENSE_SEED_CREDENTIAL_FILE=/license/offline-license.waltlicense docker compose up
```

For Kubernetes, add it to the license Secret as `offline-license.waltlicense` and set
`license.offline: true`.

Because the installation key exists only in your database, **your database backups are what protect
your license**. Losing the database means walt.id has to reissue the bundle.

Offline licenses have **no grace period**: the stack stops serving the moment the credential expires.
Request a renewal well before the expiry date shown in the `LICENSE EXPIRY WARNING` startup log line.

### DEV vs PROD licenses

`config/_features.conf` enables `dev-mode`, which exposes debug endpoints and therefore requires a
**DEV** license. A PROD license refuses to start while `dev-mode` is enabled, and vice versa. Remove
`dev-mode` from `enabledFeatures` before using a PROD license.

### Troubleshooting

- Container exits during startup - the license was rejected. `docker compose logs waltid-enterprise`
  states the reason (expired, not bound to this installation, DEV/PROD mismatch, missing seed).
- Every endpoint returns `503 Enterprise API is unavailable because the license is not active` - the
  process started but the license is not active. `GET /livez` still responds in this state.
- `GET /license/status` (superadmin auth) reports the restriction state, expiry countdown and any
  warning message.

### Kubernetes / Helm

The Helm chart reads all license material from one pre-provisioned Secret, named by
`license.secretName` in `helm/values.yaml`. It needs `state-encryption-key`, plus either
`seed-credential` (online) or `offline-license.waltlicense` and `installation-key.json` with
`license.offline: true` (offline).

## 1. Docker-Compose: Run The Enterprise Stack

Use docker-compose to bring up the Enterprise Stack API, UI and a MongoDB database (storage of the Enterprise Stack).

You can update the version of the enterprise stack via the `.env` file.

### Use docker-compose

**Clone the repo**

```bash
git clone https://github.com/walt-id/waltid-enterprise-quickstart.git
```

**Change Working Directory**
```bash
cd waltid-enterprise-quickstart
```

**Run The Stack**
```bash
docker compose pull 
docker compose up
```
In case you want to only run the API, run:
```bash
docker compose -f docker-compose-api.yml up
```

Once the docker-compose is running, you can visit [enterprise.localhost/swagger](http://enterprise.localhost/swagger) to access the Enterprise Stack APIs.

The UI is running at [http://enterprise.localhost/login](http://enterprise.localhost/login)

### Using custom organisation names

The caddy setup is configured only for the "waltid" organisation. If you want to use a custom organisation name, you can update the Caddyfile to add your own organisation domains.

```yaml
  caddy:
    image: caddy:2-alpine
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
    networks:
      mongodb_network:
        aliases:
          - enterprise.localhost
          - waltid.enterprise.localhost
          # add your own organisation domains here
    depends_on:
      - waltid-enterprise
      - waltid-enterprise-ui
```


## 2. Enterprise CLI

A TypeScript CLI tool for setting up and testing the walt.id Enterprise Stack.

```bash
# Clone the repo
git clone https://github.com/walt-id/waltid-enterprise-quickstart.git
cd waltid-enterprise-quickstart

# Install dependencies
cd cli
npm install

# Run full setup + primary use case (mDL issuance & verification)
npx tsx walt.ts --recreate

# Subsequence calls don't need to recreate the DB:
npx tsx walt.ts
```

### Common Commands

| Command | Description |
|---------|-------------|
| `npx tsx walt.ts` | Full setup + primary use case (default) |
| `npx tsx walt.ts --recreate` | Recreate database and run full setup |
| `npx tsx walt.ts --setup-all` | Run all setup commands |
| `npx tsx walt.ts --run-all` | Run primary use case only |
| `npx tsx walt.ts --help` | Show all available commands |

### Configuration

Superadmin credentials are read from `config/superadmin-registration.conf`.

For detailed documentation, see **[cli/README.md](cli/README.md)**.

## Next Steps

Visit [our docs](https://docs.walt.id/enterprise-stack/home) to learn more about features and configurations of the enterprise stack.

Interested to see what releases are available? Checkout our [changelogs](https://docs.walt.id/enterprise-stack/release-notes/overview) to see the latest releases and pre-releases of the Enterprise Stack.

Need Support? As an Enterprise customer you should also have a support contract with us. Please raise any issues via the , or reach out to the team over email if you need to be given access.

## Join the community

* Connect and get the latest updates: [Discord](https://discord.gg/AW8AgqJthZ) | [Newsletter](https://walt.id/newsletter) | [YouTube](https://www.youtube.com/channel/UCXfOzrv3PIvmur_CmwwmdLA) | [LinkedIn](https://www.linkedin.com/company/walt-id/)
* Get help, request features and report bugs: [Support Portal](https://support.walt.id)
* Find more indepth documentation on our [docs site](https://docs.walt.id/enterprise-stack/home)

## License

Licensed under our Enterprise License.

<div align="center">
<img src="./assets/walt-banner.png" alt="walt.id banner" />
</div>
