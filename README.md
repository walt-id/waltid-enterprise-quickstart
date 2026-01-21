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

Explore enterprise features via our CLI tool and/or bring up the whole stack using docker-compose.

⚠️ Please note: You need to be an Enterprise Stack customer & have access to the private enterprise stack images, to use this quickstart.

## 1. Enterprise CLI: Explore Enterprise Features via CLI 

### Use the CLI

**Clone the repo**

```bash
git clone https://github.com/walt-id/waltid-enterprise-quickstart.git
```

**Change Working Directory**
```bash
cd waltid-enterprise-quickstart
```

**Run the CLI**
```bash
./waltid-enterprise
```

### CLI Commands

| Command                        | Description                                                                 |
|--------------------------------|-----------------------------------------------------------------------------|
| **run**                        | Run the Enterprise Stack.                                                   |
| **wizard**                     | Start a step-by-step wizard to guide you through all important operations.  |
| **expert mode**                | Switch to expert mode for advanced operations.                              |
|                                |                                                                             |
| **superadmin-create-account**  | Create the super admin account.                                             |
| **init-db**                    | Initialize the database.                                                    |
| **superadmin-login**           | Log in as the super admin.                                                  |
| **create-organization**        | Create an organization or the root organization.                            |
| **create-user-account**        | Create a new user account.                                                  |
| **add-admin-role**             | Assign the 'admin' role to the user previously created.                     |
| **user-admin-login**           | Log in as a user with admin role.                                           |
| **create-tenant**              | Create a tenant in the organization created with the superadmin user.       |
| **create-kms-service**         | Create KMS service in the tenant.                                           |
| **generate-did-key**           | Generate a key to be later used on DID creation.                            |
| **create-did-service**         | Create DID service in the tenant.                                           |
| **create-did**                 | Create a did:key for credential issuance.                                   |
| **create-issuer-service**      | Create issuer service in the tenant.                                        |
| **issue-jwt-vc**               | Issue a W3C JWT credential.                                                 |
| **list-organizations**         | List all organizations under the superadmin account.                        |
| **list-accounts**              | List all accounts.                                                          |
| **list-org-resources**         | List organization's resources.                                              |
| **list-tenant-resources**      | List tenant's resources.                                                    |
| **recreate-db**                | Delete all data and restart the database from scratch.                      |



## 2. Docker-Compose: Run The Enterprise Stack

Use docker-compose to bring up the Enterprise Stack API, UI (soon) and a MongoDB database (storage of the Enterprise Stack).  

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
docker-compose up
```

Once the docker-compose is running, you can visit [enterprise.localhost:3000/swagger](http://enterprise.localhost:3000/swagger) to access the Enterprise Stack APIs.

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




