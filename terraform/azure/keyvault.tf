data "azurerm_client_config" "current" {
  count = var.enable_key_vault ? 1 : 0
}

resource "azuread_application" "keyvault" {
  count = var.enable_key_vault ? 1 : 0

  display_name = "wid-sp-kv" // waltid service principal for key vault access
}

resource "azuread_service_principal" "keyvault" {
  count = var.enable_key_vault ? 1 : 0

  client_id = azuread_application.keyvault[0].client_id
}

resource "azuread_service_principal_password" "keyvault" {
  count = var.enable_key_vault ? 1 : 0

  service_principal_id = azuread_service_principal.keyvault[0].id
}

resource "azurerm_key_vault" "this" {
  count = var.enable_key_vault ? 1 : 0

  name                = "wid-kv"
  resource_group_name = local.resource_group_name
  location            = local.location
  tenant_id           = data.azurerm_client_config.current[0].tenant_id
  sku_name            = "standard"
  tags = merge(local.common_tags, {
    purpose = "key-management"
  })
}

resource "azurerm_role_assignment" "keyvault_crypto_officer" {
  count = var.enable_key_vault ? 1 : 0

  scope                = azurerm_key_vault.this[0].id
  role_definition_name = "Key Vault Crypto Officer"
  principal_id         = azuread_service_principal.keyvault[0].object_id
}
