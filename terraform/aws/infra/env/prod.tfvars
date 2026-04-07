cluster_name = "waltid-prod"
aws_region   = "eu-north-1"

vpc_cidr          = "10.0.0.0/16"
nat_gateway_count = 3

cluster_version                      = "1.35"
cluster_endpoint_private_access      = true
cluster_endpoint_public_access       = true
cluster_endpoint_public_access_cidrs = []

node_instance_types = ["m5.xlarge"]
node_desired_size   = 6
node_min_size       = 3
node_max_size       = 15
node_disk_size      = 50

documentdb_instance_class          = "db.r5.large"
documentdb_instance_count          = 3
documentdb_backup_retention_period = 30
skip_final_snapshot                = false

enable_container_insights = true
enable_cluster_autoscaler = true

tags = {
  Project    = "Walt.id Enterprise"
  ManagedBy  = "Terraform"
  CostCenter = "Production"
}
