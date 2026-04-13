# Azure Terraform Module

Provisions Azure cloud resources for the Walt.id Enterprise application.

---

## Table of Contents
1. [Summary](#1-summary)
2. [File Structure](#2-file-structure)
3. [Security Model](#3-security-model)
4. [Cost Considerations](#4-cost-considerations)

---

## 1. Summary

| Feature | Default | Description |
|---|---|---|
| Resource Group | auto-created | Creates `waltid-<region>-rg` unless an existing one is provided |
| Blob Storage | disabled | Azure Blob Storage container for credential status publishing |
| Key Vault | disabled | Azure Key Vault with a dedicated service principal for key management |

---

## 2. File Structure

```
terraform/azure/
├── providers.tf                  # Provider configuration
├── variables.tf                  # Input variables
├── main.tf                       # Resource group and common locals/tags
├── blob-credential-status.tf     # Azure Blob Storage for credential status
├── keyvault.tf                   # Azure Key Vault and service principal
├── outputs.tf                    # Output values
└── env/
    ├── dev.tfvars                # Development environment
    └── prod.tfvars               # Production environment
```

### Usage

```bash
cd terraform/azure
terraform init
terraform apply -var-file=env/dev.tfvars  # or env/prod.tfvars
terraform output -raw <output_name>
```

---

## 3. Security Model

### Key Vault

A dedicated Azure AD service principal (`wid-sp-kv`) is created for Key Vault access. It is granted only the `Key Vault Crypto Officer` role, scoped to the specific vault — no broader subscription-level permissions.

### Blob Storage

- HTTPS-only traffic enforced (`https_traffic_only_enabled = true`)
- Public read enabled at the container level so browsers can fetch credential status without authentication
- CORS restricted to `GET`/`HEAD` methods with a configurable origin allow-list (defaults to `*`)

---

## 4. Cost Considerations

### Blob Storage

| Environment | Replication | Versioning | Notes |
|---|---|---|---|
| Dev | `LRS` | Disabled | Lowest cost, no object history |
| Prod | `GRS` | Enabled | Geo-redundancy + version history for recovery |
