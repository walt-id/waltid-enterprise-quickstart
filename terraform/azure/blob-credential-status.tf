resource "azurerm_storage_account" "credential_status" {
  count = var.enable_credential_status_blob ? 1 : 0

  name                            = "widcredentialstatus"
  resource_group_name             = local.resource_group_name
  location                        = local.location
  account_tier                    = "Standard"
  account_replication_type        = var.storage_account_replication_type
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = true

  blob_properties {
    versioning_enabled = var.enable_blob_versioning
    cors_rule {
      allowed_headers    = ["*"]
      allowed_methods    = ["GET", "HEAD"]
      allowed_origins    = var.credential_status_cors_allowed_origins
      exposed_headers    = ["ETag"]
      max_age_in_seconds = 3600
    }

    dynamic "delete_retention_policy" {
      for_each = var.enable_blob_versioning ? [1] : []
      content {
        days = var.blob_versioning_retention_days
      }
    }
  }

  tags = merge(local.common_tags, {
    purpose = "credential-status"
  })
}

resource "azurerm_storage_container" "credential_status" {
  count = var.enable_credential_status_blob ? 1 : 0

  name                  = "credential-status"
  storage_account_id    = azurerm_storage_account.credential_status[0].id
  container_access_type = "blob"
}
