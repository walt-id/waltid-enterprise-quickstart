output "mongodb_connection_string" {
  description = "Connection string for the provisioned database. Empty when database_backend = external"
  value       = local.mongodb_connection_string
  sensitive   = true
}

output "ingress_lb_hostname" {
  value = local.ingress_lb_hostname
}

output "credential_status_bucket_name" {
  description = "Name of the S3 credential status bucket"
  value       = var.enable_credential_status_bucket ? aws_s3_bucket.credential_status[0].bucket : null
}

output "credential_status_manager_access_key_id" {
  description = "Access key ID for the credential status IAM user"
  value       = var.enable_credential_status_bucket ? aws_iam_access_key.credential_status[0].id : null
  sensitive   = true
}

output "credential_status_manager_secret_key" {
  description = "Secret access key for the credential status IAM user"
  value       = var.enable_credential_status_bucket ? aws_iam_access_key.credential_status[0].secret : null
  sensitive   = true
}

output "kms_manager_access_key_id" {
  description = "Access key ID for the KMS IAM user"
  value       = var.enable_kms_key_manager ? aws_iam_access_key.kms[0].id : null
  sensitive   = true
}

output "kms_manager_secret_key" {
  description = "Secret access key for the KMS IAM user"
  value       = var.enable_kms_key_manager ? aws_iam_access_key.kms[0].secret : null
  sensitive   = true
}
