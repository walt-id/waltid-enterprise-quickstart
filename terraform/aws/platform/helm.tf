resource "kubectl_manifest" "secret-registry-dockerhub" {
  yaml_body = yamlencode({
    apiVersion = "v1"
    kind       = "Secret"
    type       = "kubernetes.io/dockerconfigjson"

    metadata = {
      name = "waltid-regcred"
    }

    data = {
      ".dockerconfigjson" = base64encode(jsonencode({
        auths = {
          "https://index.docker.io/v1/" = {
            auth = base64encode("waltid:${var.dockerhub_secret}")
          }
        }
      }))
    }
  })
}

resource "helm_release" "waltid_enterprise" {
  name = "enterprise-stack"
  # Helm charts have been moved to https://github.com/walt-id/waltid-enterprise-quickstart
  # Update the path accordingly after cloning the repo
  chart = "../../../helm"

  values = concat(
    fileexists("../../../helm/values.yaml") ? [file("../../../helm/values.yaml")] : [],
    [
      yamlencode({
        dbConf         = <<-EOT
          databaseType = "mongodb"
          fileStorage = {
            path = "/data"
          }
          mongodb = {
            connectionString = "${var.mongodb_connection_string}"
            database = "waltid-enterprise-${var.cluster_name}"
          }
        EOT
        enterpriseConf = <<-EOT
          baseDomain = "${var.domain}"
        EOT
        ingress = {
          host             = "${var.domain}"
          ingressClassName = "nginx"
          clusterIssuer    = "letsencrypt-http01"
          tls = [
            {
              hosts      = ["${var.domain}"]
              secretName = "waltid-enterprise-tls"
            }
          ]
        }
      })
    ]
  )
}
