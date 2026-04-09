variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.cluster_name))
    error_message = "Cluster name must contain only lowercase letters, numbers, and hyphens."
  }
}

variable "aws_region" {
  description = "AWS region where resources will be created"
  type        = string
}

variable "letsencrypt_email" {
  description = "Email address used for Let's Encrypt ACME registration"
  type        = string

  validation {
    condition     = length(trimspace(var.letsencrypt_email)) > 0
    error_message = "letsencrypt_email must not be empty."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "VPC CIDR must be a valid IPv4 CIDR block."
  }
}

variable "availability_zones" {
  description = "List of availability zones. If not provided, will use first 3 AZs in region."
  type        = list(string)
  default     = []
}

variable "cluster_version" {
  description = "Kubernetes version for EKS cluster"
  type        = string
  default     = "1.35"
}

variable "cluster_endpoint_private_access" {
  description = "Enable private API server endpoint"
  type        = bool
  default     = true
}

variable "cluster_endpoint_public_access" {
  description = "Enable public API server endpoint"
  type        = bool
  default     = true
}

variable "cluster_endpoint_public_access_cidrs" {
  description = "List of CIDR blocks that can access the public API endpoint"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "node_instance_types" {
  description = "List of instance types for EKS node group"
  type        = list(string)
  default     = ["t3.medium"]
}

variable "node_desired_size" {
  description = "Desired number of worker nodes"
  type        = number
  default     = 1
}

variable "node_min_size" {
  description = "Minimum number of worker nodes"
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum number of worker nodes"
  type        = number
  default     = 10
}

variable "node_disk_size" {
  description = "Disk size in GB for worker nodes"
  type        = number
  default     = 20
}

variable "documentdb_instance_class" {
  description = "Instance class for DocumentDB"
  type        = string
  default     = "db.t3.medium"
}

variable "documentdb_parameter_group_family" {
  description = "DocumentDB cluster parameter group family"
  type        = string
  default     = "docdb8.0"

  validation {
    condition     = contains(["docdb5.0", "docdb8.0"], var.documentdb_parameter_group_family)
    error_message = "DocumentDB parameter group family must be either 'docdb5.0' or 'docdb8.0'."
  }
}

variable "documentdb_instance_count" {
  description = "Number of DocumentDB instances to create"
  type        = number
  default     = 1

  validation {
    condition     = var.documentdb_instance_count >= 1 && var.documentdb_instance_count <= 15
    error_message = "DocumentDB instance count must be between 1 and 15."
  }
}

variable "documentdb_backup_retention_period" {
  description = "Number of days to retain DocumentDB backups"
  type        = number
  default     = 7

  validation {
    condition     = var.documentdb_backup_retention_period >= 1 && var.documentdb_backup_retention_period <= 35
    error_message = "Backup retention period must be between 1 and 35 days."
  }
}

variable "skip_final_snapshot" {
  description = "Skip final snapshot when destroying DocumentDB cluster"
  type        = bool
  default     = false
}

variable "nat_gateway_count" {
  description = "Number of NAT Gateways to create (1 or 3)"
  type        = number
  default     = 1

  validation {
    condition     = contains([1, 3], var.nat_gateway_count)
    error_message = "NAT gateway count must be either 1 or 3."
  }
}

variable "enable_container_insights" {
  description = "Enable CloudWatch Container Insights"
  type        = bool
  default     = true
}

variable "enable_cluster_autoscaler" {
  description = "Install Cluster Autoscaler helm chart"
  type        = bool
  default     = true
}

variable "letsencrypt_server" {
  description = "Let's Encrypt ACME directory URL"
  type        = string
  default     = "https://acme-v02.api.letsencrypt.org/directory"
}

variable "enable_credential_status_bucket" {
  description = "Enable S3 bucket for credential status publishing"
  type        = bool
  default     = false
}

variable "credential_status_force_destroy" {
  description = "Allow destruction of credential status bucket even if it contains objects"
  type        = bool
  default     = false
}

variable "credential_status_versioning_enabled" {
  description = "Enable versioning for credential status bucket"
  type        = bool
  default     = false
}

variable "credential_status_lifecycle_enabled" {
  description = "Enable lifecycle policies for credential status bucket (only applies if versioning is enabled)"
  type        = bool
  default     = true
}

variable "credential_status_noncurrent_version_expiration_days" {
  description = "Number of days before old credential status versions are deleted"
  type        = number
  default     = 90

  validation {
    condition     = var.credential_status_noncurrent_version_expiration_days >= 1
    error_message = "Expiration days must be at least 1."
  }
}

variable "credential_status_cors_allowed_origins" {
  description = "CORS allowed origins for credential status bucket (use ['*'] for all origins)"
  type        = list(string)
  default     = ["*"]
}

variable "enable_kms_key_manager" {
  description = "Enable IAM user with permissions to manage KMS keys"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Additional tags to apply to all resources"
  type        = map(string)
  default     = {}
}
