# Breaking Changes Helper for 0.17.0

This contains MongoDB migration scripts for the 0.17.0 release of the Enterprise Stack.

# Usage

To use the mongo commands, you will need to run the commands in a mongo shell. You can do this by running `mongosh` in your terminal.

WARNING: We strongly recommend you to backup your database before running any of the scripts below. You should have full backup and recovery mechanisms in place in case the migrations corrupt your database.

# Scripts

## Azure key management behavior

Customers using Azure Keys will **have** to run one of the two scripts below to migrate keys to the new format.

- Azure key management now distinguish between SDK-based and REST-based backends. Existing deployments should review their key configuration and authentication method (SDK vs REST) before upgrading.
- Keys created with one backend (SDK vs REST) are not interchangeable with the other. If you switch backends, you may need to re-provision or migrate keys accordingly.
- Creating a key with the REST-based backend will now require a client ID, tenant ID, and client secret in the configuration, and uses keyType `azure-rest-api` (and no longer `azure`).
- Creating a key with the SDK-based backend will now require a managed identity in the configuration, and uses keyType `azure` (previously not available).

#### Refactor existing Azure keys using Access Keys and keep using Access Keys

```
db.organization_trees.updateMany(
    {
        _t: 'key',
        'key.type': 'azure',
        'key.auth': { $exists: true },
    },
    [
        {
            $set: {
                'key.type': 'azure-rest-api',
                'key.config': {
                    auth: '$key.auth'
                }
            }
        },
        {
            $unset: 'key.auth'
        }
    ]
)

```


#### Move existing Azure keys using Access Keys to use Managed Identity

```
db.organization_trees.updateMany(
    {
        _t: 'key',
        'key.type': 'azure',
        'key.auth': { $exists: true }
    },
    [
        {
            $set: {
                'key.config': {
                    auth: {
                        keyVaultUrl: '$key.auth.keyVaultUrl'
                    }
                }
            }
        },
        {
            $unset: 'key.auth'
        }
    ]
)
```


## AWS key management behavior

Customers using AWS Keys *may have* to run the script below to migrate keys to the new format.

- To better align our request bodies, a new `auth` property has been added to the `config` object for the AWS key management service created with the SDK.
- If you are using the AWS key management service created with the SDK only utilising the `region` property, you will need to update your configuration to include the `auth` property. If you were previously using the Access Keys or RoleNames you will not be affected by this change.

- If you have existing keys created with the SDK, you will need to run a migration script to update your keys to the new format.


#### Refactor existing AWS keys only using region to work with the new stucture

```
db.organization_trees.updateMany(
    {
        _t: 'key',
        'key.type': 'aws',
        'key.config': { $exists: true },
        'key.auth': { $exists: false },
    },
    [
        {
            $set: {
                'key.config.auth': '$key.config',
            }
        },
        {
            $unset: 'key.config'
        }
    ]
)
```

