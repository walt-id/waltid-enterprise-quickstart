terraform {
  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
    }
    helm = {
      source = "hashicorp/helm"
    }
    kubectl = {
      source = "gavinbunney/kubectl"
    }
    kubernetes = {
      source = "hashicorp/kubernetes"
    }
    azapi = {
      source = "azure/azapi"
    }
  }
}

provider "azurerm" {
  features {}
}

variable "environment" {
  type = map(string)
  default = {
    short_name          = "sbx"
    azure_location      = "westeurope"
    location_short_name = "euw"
  }
}
variable "cert_manager_email" {
  type = string
  default = "dinkar@walt.id"
}
variable "dns_zone_name" {
  type = string
}
variable "dns_zone_resource_group" {
  type    = string
}
variable "mongo_db_admin_username" {
  type    = string
  default = "waltid"
}
variable "dockerhub_token" {
  type      = string
  sensitive = true
}

data "azurerm_dns_zone" "dns-zone" {
  name                = var.dns_zone_name
  resource_group_name = var.dns_zone_resource_group
}

resource "azurerm_resource_group" "waltid-rg" {
  name     = format("rg-wid-%s-%s", var.environment.short_name, var.environment.location_short_name)
  location = var.environment.azure_location
  tags = {
    terraform   = "true"
    environment = var.environment.short_name
    project     = "Walt.Id Enterprise"
  }
}

resource "azurerm_kubernetes_cluster" "aks" {
  name = format("aks-wid-%s-%s", var.environment.short_name, var.environment.location_short_name)
  location                  = azurerm_resource_group.waltid-rg.location
  resource_group_name       = azurerm_resource_group.waltid-rg.name
  dns_prefix = format("aks-%s-internal", var.environment.short_name)
  
  sku_tier = "Free"

  workload_identity_enabled = true
  oidc_issuer_enabled       = true
  identity {
    type = "SystemAssigned"
  }

  tags = {
    terraform   = "true"
    environment = var.environment.short_name
    project     = "Walt.Id Enterprise"
  }

  default_node_pool {
    name                        = "agentpool"
    type                        = "VirtualMachineScaleSets"
    auto_scaling_enabled        = true
    temporary_name_for_rotation = "tmpagentp"
    vm_size                     = "Standard_B2ls_v2"
    node_count                  = 2
    min_count                   = 2
    max_count                   = 5

    upgrade_settings {
      drain_timeout_in_minutes      = 0
      max_surge                     = "10%"
      node_soak_duration_in_minutes = 0
    }
  }

  monitor_metrics {
    annotations_allowed = null
    labels_allowed = null
  }

  lifecycle {
    ignore_changes = [
      default_node_pool[0].node_count,
    ]
  }
}

resource "azurerm_kubernetes_cluster_node_pool" "workerpool" {
  name                        = "workerpool"
  temporary_name_for_rotation = "tmpworkerp"
  kubernetes_cluster_id       = azurerm_kubernetes_cluster.aks.id
  vm_size                     = "Standard_A2m_v2"
  auto_scaling_enabled        = true
  node_count                  = 2
  min_count                   = 2
  max_count                   = 5

  upgrade_settings {
    drain_timeout_in_minutes      = 0
    max_surge                     = "10%"
    node_soak_duration_in_minutes = 0
  }
  tags = {
    terraform   = "true"
    environment = var.environment.short_name
    project     = "Walt.Id Enterprise"
  }

  lifecycle {
    ignore_changes = [
      node_count,
    ]
  }
}

resource "azurerm_user_assigned_identity" "id-aks-dns-zone" {
  name                = format("id-aks-dns-zone-%s-%s", var.environment.short_name, var.environment.location_short_name)
  resource_group_name = azurerm_resource_group.waltid-rg.name
  location            = azurerm_resource_group.waltid-rg.location
}

resource "azurerm_role_assignment" "role-dns-zone" {
  scope                = data.azurerm_dns_zone.dns-zone.id
  principal_id         = azurerm_user_assigned_identity.id-aks-dns-zone.principal_id
  principal_type       = "ServicePrincipal"
  role_definition_name = "DNS Zone Contributor"
}

resource "azurerm_federated_identity_credential" "id-aks-dns-zone" {
  name                = "cert-manager"
  resource_group_name = azurerm_resource_group.waltid-rg.name
  audience            = ["api://AzureADTokenExchange"]
  issuer              = azurerm_kubernetes_cluster.aks.oidc_issuer_url
  parent_id           = azurerm_user_assigned_identity.id-aks-dns-zone.id
  // ℹ️ This is the default Kubernetes ServiceAccount used by the cert-manager controller.
  // ℹ️ This is the default namespace for cert-manager.
  subject             = "system:serviceaccount:cert-manager:cert-manager"
}

resource "random_password" "password-mongo-cluster" {
  length           = 16
  special          = true
  override_special = "+-$&"
}
resource "azurerm_mongo_cluster" "mongo-cluster" {
  name                   = format("cosmos-wid-enterprise-%s-%s", var.environment.short_name, var.environment.location_short_name)
  resource_group_name    = azurerm_resource_group.waltid-rg.name
  location               = azurerm_resource_group.waltid-rg.location
  administrator_username = "waltid"
  administrator_password = random_password.password-mongo-cluster.result
  shard_count            = "1"
  compute_tier           = "Free"
  high_availability_mode = "Disabled"
  storage_size_in_gb     = "32"
  version                 = "8.0"
  tags = {
    terraform   = "true"
    environment = var.environment.short_name
    project     = "Walt.Id Enterprise"
  }
}
resource "azapi_resource" "mongo_firewall_rule_allow_aks" {
  type      = "Microsoft.DocumentDB/mongoClusters/firewallRules@2025-07-01-preview"
  name      = "allow-aks-ingress"
  parent_id = azurerm_mongo_cluster.mongo-cluster.id
  body = {
    properties = {
      startIpAddress = "0.0.0.0"
      endIpAddress   = "0.0.0.0"
    }
  }
}

provider "kubectl" {
  host                   = azurerm_kubernetes_cluster.aks.kube_config[0].host
  client_certificate     = base64decode(azurerm_kubernetes_cluster.aks.kube_config[0].client_certificate)
  client_key             = base64decode(azurerm_kubernetes_cluster.aks.kube_config[0].client_key)
  cluster_ca_certificate = base64decode(azurerm_kubernetes_cluster.aks.kube_config[0].cluster_ca_certificate)
}
provider "kubernetes" {
  host                   = azurerm_kubernetes_cluster.aks.kube_config[0].host
  client_certificate     = base64decode(azurerm_kubernetes_cluster.aks.kube_config[0].client_certificate)
  client_key             = base64decode(azurerm_kubernetes_cluster.aks.kube_config[0].client_key)
  cluster_ca_certificate = base64decode(azurerm_kubernetes_cluster.aks.kube_config[0].cluster_ca_certificate)
}
provider "helm" {
  kubernetes = {
    host                   = azurerm_kubernetes_cluster.aks.kube_config[0].host
    client_certificate     = base64decode(azurerm_kubernetes_cluster.aks.kube_config[0].client_certificate)
    client_key             = base64decode(azurerm_kubernetes_cluster.aks.kube_config[0].client_key)
    cluster_ca_certificate = base64decode(azurerm_kubernetes_cluster.aks.kube_config[0].cluster_ca_certificate)
  }
}

resource "helm_release" "nginx_ingress" {
  name       = "ingress-nginx"
  repository = "https://kubernetes.github.io/ingress-nginx"
  chart      = "ingress-nginx"
  namespace  = "ingress-nginx"
  create_namespace = true

  set = [{
    name = "controller.service.annotations.service\\.beta\\.kubernetes\\.io/azure-load-balancer-health-probe-request-path"
    value = "/healthz"
  },
  {
    name = "controller.service.externalTrafficPolicy"
    value = "Local"
  }]
}

data "kubernetes_service" "ingress_nginx" {
  metadata {
    name      = "ingress-nginx-controller"
    namespace = "ingress-nginx"
  }
  depends_on = [helm_release.nginx_ingress]
}
resource "azurerm_dns_a_record" "a-record-aks-ingress" {
  name                = "enterprise"
  zone_name           = var.dns_zone_name
  resource_group_name = var.dns_zone_resource_group
  ttl                 = 300
  records            = [data.kubernetes_service.ingress_nginx.status[0].load_balancer[0].ingress[0].ip]
}
resource "azurerm_dns_a_record" "wildcard-a-record-aks-ingress" {
  name                = "*.enterprise"
  zone_name           = var.dns_zone_name
  resource_group_name = var.dns_zone_resource_group
  ttl                 = 300
  records            = [data.kubernetes_service.ingress_nginx.status[0].load_balancer[0].ingress[0].ip]
}

resource "helm_release" "cert_manager" {
  name       = "cert-manager"
  repository = "https://charts.jetstack.io"
  chart      = "cert-manager"
  namespace  = "cert-manager"
  create_namespace = true

  set = [{
    name = "crds.enabled"
    value = "true"
  },
  {
    name = "podLabels.azure\\.workload\\.identity/use"
    value = "true",
    type  = "string"
  },
  {
    name = "serviceAccount.labels.azure\\.workload\\.identity/use"
    value = "true",
    type  = "string"
  }]
}

resource "kubectl_manifest" "lets-encrypt-cluster-issuer" {
  yaml_body = yamlencode({
    apiVersion = "cert-manager.io/v1"
    kind       = "ClusterIssuer"
    metadata = {
      name = "letsencrypt-production"
    }
    spec = {
      acme = {
        server = "https://acme-v02.api.letsencrypt.org/directory"
        email  = var.cert_manager_email
        privateKeySecretRef = {
          name = "letsencrypt-production-private-key"
        }
        solvers = [
          {
            dns01 = {
              azureDNS = {
                hostedZoneName    = var.dns_zone_name
                resourceGroupName = var.dns_zone_resource_group
                subscriptionID    = split("/", data.azurerm_dns_zone.dns-zone.id)[2]
                environment       = "AzurePublicCloud"
                managedIdentity = {
                  clientID : azurerm_user_assigned_identity.id-aks-dns-zone.client_id
                }
              }
            }
          }
        ]
      }
    }
  })
  depends_on = [helm_release.cert_manager]
}

resource "kubectl_manifest" "secret-registry-dockerhub" {
  yaml_body = yamlencode({
    apiVersion = "v1",
    kind       = "Secret"
    type       = "kubernetes.io/dockerconfigjson"
    metadata = {
      name : "waltid-regcred"
    }
    data = {
      ".dockerconfigjson" = var.dockerhub_token
    }
  })
}

resource "helm_release" "waltid-enterprise" {
  name       = "enterprise-stack"
  # Helm charts have been moved to https://github.com/walt-id/waltid-enterprise-quickstart
  # Update the path accordingly after cloning the repo
  chart      = "../../helm"
  values = [
    file("../../helm/values.yaml"),
    yamlencode({
      dbConf = <<-EOT
        databaseType = "mongodb"
        fileStorage = {
          path = "/data"
        }
        mongodb = {
          connectionString = "${azurerm_mongo_cluster.mongo-cluster.connection_strings[0].value}"
          database = "waltid-enterprise-${var.environment.short_name}"
        }
      EOT
      enterpriseConf = <<-EOT
        baseDomain = "enterprise.${data.azurerm_dns_zone.dns-zone.name}"
      EOT
      ingress = {
        host = "enterprise.${data.azurerm_dns_zone.dns-zone.name}"
        tls = [{
          hosts      = ["enterprise.${data.azurerm_dns_zone.dns-zone.name}", "*.enterprise.${data.azurerm_dns_zone.dns-zone.name}"]
          secretName = "enterprise-tls"
        }]
        clusterIssuer = "letsencrypt-production"
      }
    })
  ]
  depends_on = [kubectl_manifest.lets-encrypt-cluster-issuer, kubectl_manifest.secret-registry-dockerhub, helm_release.nginx_ingress]
}

output "kube_config" {
  value = azurerm_kubernetes_cluster.aks.kube_config_raw
  sensitive = true
}
output "mongo_connection_string" {
  value     = azurerm_mongo_cluster.mongo-cluster.connection_strings[0].value
  sensitive = true
}
output "password_mongo_cluster" {
  value     = random_password.password-mongo-cluster.result
  sensitive = true
}
