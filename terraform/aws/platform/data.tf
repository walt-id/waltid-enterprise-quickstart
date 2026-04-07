data "aws_eks_cluster" "main" {
  name = var.cluster_name
}
