variable "cluster_name" {
  description = "Name of the deployed EKS cluster"
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

variable "dockerhub_secret" {
  description = "Dockerhub secret for pulling waltid-enterprise private images."
  type        = string
  sensitive   = true
}

variable "domain" {
  description = "Domain for the enterprise stack"
  type        = string
}

variable "mongodb_connection_string" {
  description = "MongoDB connection string for waltid-enterprise"
  type        = string
  sensitive   = true
}
