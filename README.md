# Enterprise Quickstart

**Explore** the walt.id Enterprise Stack features via **our CLI tool** and/or bring up the whole stack using **docker-compose**.

⚠️ Please note: You require private access to the walt.id enterprise images to use this quickstart.

## 1. Enterprise CLI: Explore Enterprise Features via CLI 

### Use the CLI
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

**Run The Stack**
```bash
docker-compose up
```

Once the docker-compose is running, you can visit [enterprise.localhost:3000/swagger](http://enterprise.localhost:3000/swagger) to access the Enterprise Stack APIs.

## Next Steps

Visit [docs.walt.id/enterprise-stack](https://docs.walt.id/enterprise-stack/home) to learn more about features and configurations of the enterprise stack.






