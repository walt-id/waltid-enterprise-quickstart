output "mongodb_connection_string" {
  description = "Connection string for MongoDB"
  value       = "mongodb://waltid:${random_password.docdb.result}@${aws_docdb_cluster.main.endpoint}:${aws_docdb_cluster.main.port}?replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false"
  sensitive   = true
}

output "ingress_nginx_lb" {
  value = data.kubernetes_service.ingress_nginx.status[0].load_balancer[0].ingress[0]
}
