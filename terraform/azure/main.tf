locals {
  create_rg           = var.resource_group_name == ""
  resource_group_name = local.create_rg ? azurerm_resource_group.this[0].name : var.resource_group_name
  location            = local.create_rg ? azurerm_resource_group.this[0].location : var.az_region

  common_tags = merge(
    {
      terraform = "true"
      project   = "Walt.Id Enterprise"
    },
    var.tags
  )
}

resource "azurerm_resource_group" "this" {
  count = local.create_rg ? 1 : 0

  name     = "wid-${var.az_region}-rg"
  location = var.az_region
  tags     = local.common_tags
}
