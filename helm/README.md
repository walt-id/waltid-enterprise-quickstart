# walt.id Enterprise Stack Helm chart

Deploys the Enterprise API and, optionally, the admin UI. The database (MongoDB 5-8, MongoDB Atlas or
Amazon DocumentDB), the ingress controller, TLS certificates and DNS are provided by you.

`values.yaml` holds production defaults and no credentials. Everything sensitive is read from
Kubernetes Secrets you create before installing; the chart references them by name only.

## 1. Create the Secrets

Both Secrets live in the release namespace.

### Configuration Secret (`sensitiveConfig.secretName`, default `waltid-enterprise-config`)

One key per file, mounted as `/config/<key>`:

| Key | Contents |
|---|---|
| `auth.conf` | Login token `signingKey` / `verificationKey`, password `pepper`, auth flows |
| `database.conf` | Connection string, database name, profile |
| `superadmin-registration.conf` | One-time superadmin bootstrap token (while `featConf` enables `superadmin-registration`) |

`auth.conf`. Generate a new Ed25519 key pair for every deployment (any JOSE tool that writes a JWK),
and a random pepper of at least 32 characters. Never reuse the keys from `config/auth.conf`, they are
public.

```hocon
requireHttps = true
pepper = "<random, at least 32 characters>"
signingKey = {"type": "jwk", "jwk": {<private Ed25519 JWK>}}
verificationKey = {"type": "jwk", "jwk": {<public Ed25519 JWK>}}
hashAlgorithm = ARGON2
authFlow = {
    method: email
    expiration: "7d"
    ok: true
}
```

`database.conf` for Amazon DocumentDB. `retryWrites=false` is mandatory, and TLS needs the Amazon
trust store as an extra Secret key (see below):

```hocon
databaseType = mongodb
mongodb = {
    connectionString = "mongodb://<user>:<password>@<cluster-endpoint>:27017/?tls=true&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false"
    database = "waltid-enterprise"
    profile = AWS_DOCUMENTDB_5
    collation = "none"
    ssl = {
        enable = true
        trustStoreLocation = "/config/aws-truststore.jks"
        trustStorePassword = "<trust store password>"
    }
}
```

`superadmin-registration.conf`. Use a random token, and remove the file (and the feature) once the
superadmin exists:

```hocon
tokens = {
    "<random token>": {
        expiration = "<ISO-8601 date shortly after the install>"
        devModeOnly = false
        account = {
            type = "email"
            identifier = { email = "<admin e-mail>" }
            data = { password = "<strong password>" }
        }
    }
}
```

```bash
kubectl create secret generic waltid-enterprise-config \
  --from-file=auth.conf --from-file=database.conf --from-file=superadmin-registration.conf \
  --from-file=aws-truststore.jks   # DocumentDB only
```

Every key the Secret holds beyond the three defaults must also be listed in `sensitiveConfig.files`.

### License Secret (`license.secretName`, default `waltid-enterprise-license`)

See [Kubernetes licensing](../LICENSING.md#kubernetes--helm): `seed-credential` for online activation,
optionally `state-encryption-key`.

## 2. Prepare DNS and TLS

Organizations are served from subdomains, so DNS and the TLS certificate must cover both your
domain and its wildcard, e.g. `enterprise.example.com` and `*.enterprise.example.com`
(unless `ingress.wildcardHost: false`).

## 3. Install

```bash
helm upgrade --install enterprise-stack ./helm -f my-values.yaml
```

## Values overview

| Value | Default | Purpose |
|---|---|---|
| `imagePullSecrets` | `[]` | Pull Secrets for registries that need them |
| `sensitiveConfig.secretName` / `files` | `waltid-enterprise-config` / 3 files | Secret with the sensitive `/config` files |
| `api.existingConfigSecret` | `""` | Alternative: one Secret holding the complete `/config`; replaces the ConfigMap and `sensitiveConfig` |
| `serviceAccount.create` / `name` / `annotations` | `true` / fullname / `{}` | ServiceAccount of the API and license Job. Add `eks.amazonaws.com/role-arn` for IRSA |
| `api.image.registry` / `repository` / `tag` | `docker.io` / `waltid/waltid-enterprise-api` / chart `appVersion` | API image, rendered as `<registry>/<repository>:<tag>` |
| `api.nodeSelector` / `tolerations` / `affinity` | empty | Scheduling for the API and license Job |
| `web.enabled` | `true` | Deploy the admin UI |
| `web.image.*` | as above, `waltid-enterprise-ui` | UI image |
| `web.nodeSelector` / `tolerations` / `affinity` | empty | Scheduling for the UI |
| `api.hpa.enabled`, `web.hpa.enabled` | `true` | Autoscaling; needs metrics-server. When off, `api.replicas` / `web.replicas` apply |
| `ingress.enabled` / `ingressClassName` / `wildcardHost` | `true` / cluster default / `true` | Routing |
| `ingress.host` | `enterprise.example.com` | Public domain: ingress host and the API's `baseDomain` |
| `enterpriseConf` | `""` | Extra `enterprise.conf` settings, appended after the generated `baseDomain` |
| `ingress.annotations` / `clusterIssuer` / `tls` | empty | Controller annotations, cert-manager issuer, `spec.tls` |
| `ingress.exposeDebugEndpoints` | `false` | Route `/debug/*` (only served when `featConf` enables `debug-endpoints`) |
