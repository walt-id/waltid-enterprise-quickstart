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

This flow demonstrates trust list verification using the Enterprise Trust Registry Service. It will create a trust registry, import trust lists, and configure the verifier to verify trust lists.

```bash
npx tsx walt.ts --flow-etsi-trust-lists
```

### Credential Revocation Flow

This flow demonstrates the complete credential revocation lifecycle using TokenStatusList CWT. It will create a credential with status tracking enabled, verify the credential, revoke the credential, and unrevoke the credential.

```bash
npx tsx walt.ts --flow-credential-revocation
```

### Bank Tenant Flow

This flow demonstrates the setup of a bank tenant, which is used for the bank demo found (here)[https://github.com/walt-id/waltid-enterprise-examples/tree/main/waltid-bank-demo].

For this flow, you will need to configure the bank-tenant.env file with the correct values. You can find an example of the bank-tenant.env file (here)[bank-tenant.env.example]. These will need to align with the environment variables used in the bank demo. The examples in both repositories currently match, but beware if you make any updates!

```bash
npx tsx walt.ts --flow-bank-tenant
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

