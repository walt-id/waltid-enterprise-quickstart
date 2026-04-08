output "mongodb_connection_string" {
  description = "Connection string for MongoDB"
  value       = "mongodb://waltid:${random_password.docdb.result}@${aws_docdb_cluster.main.endpoint}:${aws_docdb_cluster.main.port}?replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false"
  sensitive   = true
}

output "ingress_nginx_lb" {
  value = data.kubernetes_service.ingress_nginx.status[0].load_balancer[0].ingress[0]
}

output "credential_status_bucket_name" {
  description = "Name of the S3 credential status bucket"
  value       = var.enable_credential_status_bucket ? aws_s3_bucket.credential_status[0].bucket : null
}

output "credential_status_access_key_id" {
  description = "Access key ID for the credential status IAM user"
  value       = var.enable_credential_status_bucket ? aws_iam_access_key.credential_status[0].id : null
  sensitive   = true
}

output "credential_status_secret_key" {
  description = "Secret access key for the credential status IAM user"
  value       = var.enable_credential_status_bucket ? aws_iam_access_key.credential_status[0].secret : null
  sensitive   = true
}
