# walt.id Enterprise Stack Quickstart

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

Visit [docs.walt.id/enterprise-stack](https://docs.walt.id/enterprise-stack/home) to learn more about features and configurations of the enterprise stack.

Need Support? As an Enterprise customer you should also have a support contract with us. Please raise any issues via the [portal](https://support.walt.id), or reach out to the team over email if you need to be given access.






