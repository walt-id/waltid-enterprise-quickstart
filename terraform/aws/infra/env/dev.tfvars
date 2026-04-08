cluster_name = "waltid-dev"
aws_region   = "eu-north-1"

vpc_cidr          = "10.0.0.0/16"
nat_gateway_count = 1

cluster_version                      = "1.35"
cluster_endpoint_private_access      = true
cluster_endpoint_public_access       = true
cluster_endpoint_public_access_cidrs = ["0.0.0.0/0"]

node_instance_types = ["t3.medium"]
node_desired_size   = 1
node_min_size       = 1
node_max_size       = 3
node_disk_size      = 20

documentdb_instance_class          = "db.t3.medium"
documentdb_instance_count          = 1
documentdb_backup_retention_period = 3
skip_final_snapshot                = true

enable_container_insights = true
enable_cluster_autoscaler = true

tags = {
  Project    = "Walt.id Enterprise"
  ManagedBy  = "Terraform"
  CostCenter = "Development"
}

# Credential Status Bucket Configuration (disabled by default)
enable_credential_status_bucket                      = false
credential_status_force_destroy                      = true
credential_status_noncurrent_version_expiration_days = 30
