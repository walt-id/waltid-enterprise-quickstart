variable "az_region" {
  description = "Azure region where resources will be created"
  type        = string
}

variable "resource_group_name" {
  description = "Name of an existing resource group to deploy into. If not set, a new one will be created."
  type        = string
  default     = ""
}

variable "enable_credential_status_blob" {
  description = "Enable Azure Blob Storage for credential status publishing"
  type        = bool
  default     = false
}

variable "storage_account_replication_type" {
  description = "Replication type for the credential status storage account (e.g., LRS, GRS)"
  type        = string
  default     = "LRS"
}

variable "enable_blob_versioning" {
  description = "Enable versioning for the credential status blob storage account"
  type        = bool
  default     = false
}

variable "blob_versioning_retention_days" {
  description = "Number of days to retain blob versions when versioning is enabled"
  type        = number
  default     = 30

  validation {
    condition     = var.blob_versioning_retention_days >= 1 && var.blob_versioning_retention_days <= 365
    error_message = "blob_versioning_retention_days must be between 1 and 365"
  }
}

variable "credential_status_cors_allowed_origins" {
  description = "CORS allowed origins for credential status blob storage (use ['*'] for all origins)"
  type        = list(string)
  default     = ["*"]
}

variable "enable_key_vault" {
  description = "Enable Azure Key Vault with a service principal for key management"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Additional tags to apply to all resources"
  type        = map(string)
  default     = {}
}
