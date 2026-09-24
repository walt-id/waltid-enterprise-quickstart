resource "helm_release" "traefik" {
  name             = "traefik"
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  namespace        = "traefik"
  create_namespace = true
  version          = "41.3.0"

  set {
    name  = "deployment.replicas"
    value = var.traefik_replicas
  }

  set {
    name  = "service.type"
    value = "LoadBalancer"
  }

  set {
    name  = "service.spec.externalTrafficPolicy"
    value = "Local"
  }

  set {
    name  = "service.annotations.service\\.beta\\.kubernetes\\.io/aws-load-balancer-type"
    value = "nlb"
  }

  set {
    name  = "service.annotations.service\\.beta\\.kubernetes\\.io/aws-load-balancer-scheme"
    value = "internet-facing"
  }

  # The chart exposes no key for this, so it goes in as a static CLI argument. Only websecure is
  # set: it is the entrypoint the ingress serves, and `web` only redirects to it.
  set {
    name  = "additionalArguments[0]"
    value = "--entrypoints.websecure.http2.maxconcurrentstreams=${var.traefik_max_concurrent_streams}"
  }

  depends_on = [
    aws_eks_addon.vpc_cni,
    aws_eks_addon.coredns,
    aws_eks_addon.kube_proxy,
  ]
}

data "kubernetes_service" "traefik" {
  metadata {
    name      = "traefik"
    namespace = "traefik"
  }

  depends_on = [helm_release.traefik]
}

resource "helm_release" "metrics_server" {
  name             = "metrics-server"
  repository       = "https://kubernetes-sigs.github.io/metrics-server/"
  chart            = "metrics-server"
  namespace        = "kube-system"
  create_namespace = false
  version          = "3.13.0"

  depends_on = [
    aws_eks_addon.vpc_cni,
    aws_eks_addon.coredns,
    aws_eks_addon.kube_proxy,
  ]
}

resource "helm_release" "cluster_autoscaler" {
  count            = var.enable_cluster_autoscaler ? 1 : 0
  name             = "cluster-autoscaler"
  repository       = "https://kubernetes.github.io/autoscaler"
  chart            = "cluster-autoscaler"
  namespace        = "kube-system"
  create_namespace = false
  version          = "9.56.0"

  set {
    name  = "autoDiscovery.clusterName"
    value = aws_eks_cluster.main.name
  }

  set {
    name  = "awsRegion"
    value = var.aws_region
  }

  set {
    name  = "rbac.serviceAccount.create"
    value = "true"
  }

  set {
    name  = "rbac.serviceAccount.name"
    value = "cluster-autoscaler"
  }

  set {
    name  = "rbac.serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = aws_iam_role.cluster_autoscaler[0].arn
  }

  set {
    name  = "extraArgs.balance-similar-node-groups"
    value = "true"
  }

  set {
    name  = "extraArgs.skip-nodes-with-system-pods"
    value = "false"
  }

  depends_on = [
    aws_eks_node_group.main,
    aws_iam_role_policy_attachment.cluster_autoscaler
  ]
}

resource "helm_release" "cert_manager" {
  name             = "cert-manager"
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  namespace        = "cert-manager"
  create_namespace = true
  version          = "v1.20.0"

  set {
    name  = "installCRDs"
    value = "true"
  }

  set {
    name  = "prometheus.enabled"
    value = "false"
  }

  depends_on = [
    aws_eks_node_group.main
  ]
}

resource "kubectl_manifest" "letsencrypt_cluster_issuer" {
  yaml_body = <<-YAML
    apiVersion: cert-manager.io/v1
    kind: ClusterIssuer
    metadata:
      name: letsencrypt-http01
    spec:
      acme:
        email: ${var.letsencrypt_email}
        server: ${var.letsencrypt_server}
        privateKeySecretRef:
          name: letsencrypt-http01-private-key
        solvers:
          - http01:
              ingress:
                ingressClassName: traefik
  YAML

  depends_on = [
    helm_release.cert_manager,
    helm_release.traefik
  ]
}

resource "kubernetes_storage_class" "gp3" {
  metadata {
    name = "gp3"

    annotations = {
      "storageclass.kubernetes.io/is-default-class" = "true"
    }
  }

  storage_provisioner    = "ebs.csi.aws.com"
  reclaim_policy         = var.gp3_storage_class_reclaim_policy
  volume_binding_mode    = "WaitForFirstConsumer"
  allow_volume_expansion = true

  parameters = {
    type      = "gp3"
    encrypted = "true"
  }

  depends_on = [aws_eks_addon.ebs_csi]
}

# A gp3 volume's IOPS do not scale with its size: 400Gi still gets 3000 IOPS and 125 MB/s. A database volume
# that needs more has to say so, and only the database volume should pay for it, so this is a separate class
# rather than a change to the default one above. Created only when asked for, so the default stays as it was.
resource "kubernetes_storage_class" "gp3_mongodb_data" {
  count = var.mongodb_data_volume_iops > 0 || var.mongodb_data_volume_throughput > 0 ? 1 : 0

  metadata {
    name = "gp3-mongodb-data"
  }

  storage_provisioner    = "ebs.csi.aws.com"
  reclaim_policy         = var.gp3_storage_class_reclaim_policy
  volume_binding_mode    = "WaitForFirstConsumer"
  allow_volume_expansion = true

  parameters = merge(
    {
      type      = "gp3"
      encrypted = "true"
    },
    var.mongodb_data_volume_iops > 0 ? { iops = tostring(var.mongodb_data_volume_iops) } : {},
    var.mongodb_data_volume_throughput > 0 ? { throughput = tostring(var.mongodb_data_volume_throughput) } : {},
  )

  depends_on = [aws_eks_addon.ebs_csi]
}
