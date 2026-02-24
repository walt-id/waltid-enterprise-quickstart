# Keycloak (persistent + auto-import) for waltid enterprise quickstart

## Files
- `docker-compose.keycloak.yml` - starts Keycloak with persistent data volume and realm import.
- `import/waltid-realm.json` - dev realm bootstrap (realm, client, roles, users).

## Start
From `waltid-enterprise-quickstart`:

```bash
docker compose -f docker-compose.keycloak.yml up -d
```

## Stop
```bash
docker compose -f docker-compose.keycloak.yml down
```

## Reset completely (delete all Keycloak state)
```bash
docker compose -f docker-compose.keycloak.yml down -v
```

## Access
- Keycloak admin: http://localhost:8080
- Admin user: `admin`
- Admin password: `admin`

## Imported defaults
- Realm: `waltid`
- Client: `waltid_enterprise`
- Client secret: `waltid-enterprise-dev-secret`
- Users:
  - `waltid-admin` / `waltid-admin`
  - `waltid-operator` / `waltid-operator`
- Realm roles:
  - `tenant-admin`
  - `wallet-operator`

## Important
Enterprise OIDC config should use:
- OIDC discovery URL: `http://keycloak:8080/realms/waltid/.well-known/openid-configuration`
- clientId: `waltid_enterprise`
- clientSecret: `waltid-enterprise-dev-secret`
