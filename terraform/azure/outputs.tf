output "credential_status_bucket_name" {
  description = "Azure Blob Storage container name for credential status"
  value       = var.enable_credential_status_blob ? azurerm_storage_container.credential_status[0].name : null
}

output "credential_status_bucket_url" {
  description = "Azure Blob Storage URL for credential status"
  value       = var.enable_credential_status_blob ? "${azurerm_storage_account.credential_status[0].primary_blob_endpoint}${azurerm_storage_container.credential_status[0].name}" : null
}

output "credential_status_connection_string" {
  description = "Azure Storage Account connection string for credential status"
  value       = var.enable_credential_status_blob ? azurerm_storage_account.credential_status[0].primary_connection_string : null
  sensitive   = true
}

output "key_vault_url" {
  description = "Azure Key Vault URL"
  value       = var.enable_key_vault ? azurerm_key_vault.this[0].vault_uri : null
}

output "key_vault_tenant_id" {
  description = "Azure AD tenant ID for Key Vault authentication"
  value       = var.enable_key_vault ? data.azurerm_client_config.current[0].tenant_id : null
}

output "key_vault_client_id" {
  description = "Service principal client ID for Key Vault access"
  value       = var.enable_key_vault ? azuread_application.keyvault[0].client_id : null
}

output "key_vault_client_secret" {
  description = "Service principal client secret for Key Vault access"
  value       = var.enable_key_vault ? azuread_service_principal_password.keyvault[0].value : null
  sensitive   = true
}
