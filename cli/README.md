# Enterprise CLI Tool

The purpose of this tool is to help new customers understand how the setup works for the Enterprise stack. It also contains commands for running common flows or flows which are related to some of our white label demos, which are available (here)[https://github.com/walt-id/waltid-enterprise-examples].


## Getting Started

There are a number of environment variable files which can be created. You will find examples for each one within the repository.

You can utilise the default values for your first run, then customise later on based on your needs.

Run the enterprise stack locally, using the guide found (here)[../README.md]. Once it is up and running, you can start using the CLI in this directory by running 

```bash
npm install
npx tsx walt.ts
```

This will run the full setup and primary use case (issue and verify mDL credential) to ensure the setup succeeded

At any point, you can recreate this initial setup by running

```bash
npx tsx walt.ts --recreate
```
This will recreate the database and run the full setup from scratch.

## Flows Available

We currently have the following flows:

### ETSI Trust Lists Flow

This flow demonstrates trust list verification using the Enterprise Trust Registry Service. It will use the previously created trust registry and trust lists from the initial setup and show how to issue, accept, share and verify credentials all following key trust principles.

```bash
npx tsx walt.ts --flow-etsi-trust-lists
```

### WAL-1186 Trust Lists Acceptance Flow

This flow verifies registry-owned certificate path construction with an mdoc that omits its IACA/root, rejects an unrelated certificate, and verifies the same leaf-only credential through Verifier2's linked Trust Registry.

```bash
# Requires the normal base and ETSI Trust Registry setup
npx tsx walt.ts --setup-all
npx tsx walt.ts --flow-wal-1186-trust-lists
```

To also validate compact-JWS LoTE loading, configure a signed artifact and its independently trusted signer certificate:

```bash
WAL1186_SIGNED_LOTE_FILE=/path/to/list.json.jws \
WAL1186_SIGNER_CERT_FILE=/path/to/source-signer.pem \
npx tsx walt.ts --flow-wal-1186-trust-lists
```

For a local mechanics-only test, `WAL1186_ALLOW_EMBEDDED_SIGNER_TEST_PIN=true` explicitly pins `x5c[0]`. This is intentionally opt-in because an embedded certificate is not independent signer trust.

### Credential Revocation Flow

This flow demonstrates the complete credential revocation lifecycle using TokenStatusList CWT. It will issue a credential with status tracking enabled, verify the credential, revoke the credential, and unrevoke the credential.

```bash
npx tsx walt.ts --flow-credential-revocation
```

### Bank Tenant Setup

This setup will create a separate tenant within the enterprise stack (bank-tenant), which is used for the bank demo found (here)[https://github.com/walt-id/waltid-enterprise-examples/tree/main/waltid-bank-demo].

For this flow, you will need to configure the bank-tenant.env file with the correct values. You can find an example of the bank-tenant.env file (here)[bank-tenant.env.example]. These will need to align with the environment variables used in the bank demo. The examples in both repositories currently match, but beware if you make any updates!

```bash
npx tsx walt.ts --setup-bank-tenant
```

### Government Services Setup

This setup will create a separate tenant within the enterprise stack (gov-central), which is used for the government services demo found (here)[https://github.com/walt-id/waltid-enterprise-examples/tree/main/waltid-gov-serice].

For this flow, you will need to configure the gov-services.env file with the correct values. You can find an example of the gov-services.env file (here)[gov-services.env.example]. These will need to align with the environment variables used in the government services demo. The examples in both repositories currently match, but beware if you make any updates!

```bash
npx tsx walt.ts --setup-gov-services
```

## Advanced Usage

You can also run specific setup commands by running

```bash
npx tsx walt.ts --setup-<command>
```

If you are running the enterprise stack locally with a tunnel (e.g. ngrok), you can set the `HOST_ALIAS_DOMAIN` environment variable to the domain of the tunnel. This will be used to create the host alias for the enterprise stack.

```bash
HOST_ALIAS_DOMAIN=probable-boxer-proven.ngrok-free.app
```

This will create a host alias for the enterprise stack at `probable-boxer-proven.ngrok-free.app`.

This will allow you to use different public URLs for the enterprise stack which are accessible over the internet, making it easier to test the enterprise stack in a real-world scenario.


## Self-Signed Certificates (Remote Systems)

When connecting to remote systems with self-signed certificates, you'll get:
```
Error code: DEPTH_ZERO_SELF_SIGNED_CERT
```

### Solution 1: Use the insecure wrapper (quick)
```bash
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD=yourpassword \
BASE_URL=https://your-remote-system.example.com \
./walt-insecure.sh --setup-all
```

### Solution 2: Set environment variable
```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD=yourpassword \
BASE_URL=https://your-remote-system.example.com \
npx tsx walt.ts --setup-all
```

### Solution 3: Install the CA certificate (production)
```bash
# Download the CA certificate
curl -k https://your-remote-system.example.com/ca.crt > ca.crt

# Install it (Ubuntu/Debian)
sudo cp ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates

# Now Node.js will trust it
npx tsx walt.ts --setup-all
```

**⚠️ Warning:** `NODE_TLS_REJECT_UNAUTHORIZED=0` disables certificate validation and should only be used for testing/development systems with self-signed certificates.
