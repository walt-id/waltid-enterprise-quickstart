resource "aws_launch_template" "mongodb_node" {
  count       = local.mongodb_dedicated_nodes ? 1 : 0
  name_prefix = "${var.cluster_name}-mongodb-node-"

  vpc_security_group_ids = [aws_security_group.node.id]

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.mongodb_node_disk_size
      volume_type           = "gp3"
      delete_on_termination = true
      encrypted             = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags = merge(local.common_tags, {
      Name = "${var.cluster_name}-mongodb-node"
    })
  }

  update_default_version = true
}

resource "aws_eks_node_group" "mongodb" {
  count           = local.mongodb_dedicated_nodes ? 1 : 0
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.cluster_name}-mongodb-node-group"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = aws_subnet.private[*].id

  instance_types = var.mongodb_node_instance_types

  scaling_config {
    desired_size = var.mongodb_dedicated_node_count
    min_size     = var.mongodb_dedicated_node_count
    max_size     = var.mongodb_dedicated_node_count
  }

  update_config {
    max_unavailable = 1
  }

  labels = local.mongodb_node_selector_label

  taint {
    key    = "waltid.io/workload"
    value  = "mongodb"
    effect = "NO_SCHEDULE"
  }

  launch_template {
    id      = aws_launch_template.mongodb_node[0].id
    version = "$Latest"
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_amazon_eks_worker_node_policy,
    aws_iam_role_policy_attachment.node_amazon_eks_cni_policy,
    aws_iam_role_policy_attachment.node_amazon_ec2_container_registry_read_only
  ]

  tags = merge(local.common_tags, { Name = "${var.cluster_name}-mongodb-node-group" })
}

resource "kubernetes_namespace" "mongodb" {
  count = local.use_mongodb ? 1 : 0

  metadata {
    name = var.mongodb_namespace
  }

  depends_on = [aws_eks_node_group.main]
}

resource "helm_release" "mongodb_operator" {
  count      = local.use_mongodb ? 1 : 0
  name       = "mongodb-community-operator"
  repository = "https://mongodb.github.io/helm-charts"
  chart      = "community-operator"
  namespace  = kubernetes_namespace.mongodb[0].metadata[0].name

  set {
    name  = "operator.watchNamespace"
    value = var.mongodb_namespace
  }

  set {
    name  = "community-operator-crds.enabled"
    value = "true"
  }

  depends_on = [
    aws_eks_addon.vpc_cni,
    aws_eks_addon.coredns,
    aws_eks_addon.kube_proxy,
  ]
}

resource "random_password" "mongodb" {
  count   = local.use_mongodb ? 1 : 0
  length  = 24
  special = false
}

resource "kubernetes_secret" "mongodb_password" {
  count = local.use_mongodb ? 1 : 0

  metadata {
    name      = "mongodb-${var.mongodb_username}-password"
    namespace = kubernetes_namespace.mongodb[0].metadata[0].name
  }

  data = {
    password = random_password.mongodb[0].result
  }
}

resource "kubectl_manifest" "mongodb_replica_set" {
  count = local.use_mongodb ? 1 : 0

  yaml_body = yamlencode({
    apiVersion = "mongodbcommunity.mongodb.com/v1"
    kind       = "MongoDBCommunity"

    metadata = {
      name      = "mongodb"
      namespace = kubernetes_namespace.mongodb[0].metadata[0].name
    }

    spec = {
      members = var.mongodb_members
      type    = "ReplicaSet"
      version = var.mongodb_version

      security = {
        authentication = {
          modes = ["SCRAM"]
        }
      }

      users = [
        {
          name = var.mongodb_username
          db   = "admin"

          passwordSecretRef = {
            name = kubernetes_secret.mongodb_password[0].metadata[0].name
          }

          roles = [
            { name = "readWriteAnyDatabase", db = "admin" },
            { name = "clusterMonitor", db = "admin" },
          ]

          scramCredentialsSecretName = "${var.mongodb_username}-scram"
        },
      ]

      additionalMongodConfig = {
        "storage.wiredTiger.engineConfig.journalCompressor" = "zlib"
      }

      statefulSet = {
        spec = {
          template = {
            spec = merge({
              topologySpreadConstraints = [
                {
                  maxSkew           = 1
                  topologyKey       = "kubernetes.io/hostname"
                  whenUnsatisfiable = "ScheduleAnyway"
                  labelSelector = {
                    matchLabels = { app = "mongodb-svc" }
                  }
                },
              ]

              containers = [
                {
                  name      = "mongod"
                  resources = var.mongodb_resources
                },
                {
                  name      = "mongodb-agent"
                  resources = var.mongodb_resources
                },
              ]
            }, local.mongodb_pod_placement...)
          }
        }
      }
    }
  })

  wait = true

  depends_on = [
    helm_release.mongodb_operator,
    kubernetes_storage_class.gp3,
    aws_eks_node_group.mongodb,
  ]
}
