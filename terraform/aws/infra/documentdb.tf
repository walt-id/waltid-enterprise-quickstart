resource "aws_security_group" "documentdb" {
  name        = "${var.cluster_name}-documentdb-sg"
  description = "Security group for DocumentDB"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 27017
    to_port         = 27017
    protocol        = "tcp"
    security_groups = [aws_security_group.node.id]
  }

  tags = merge(local.common_tags, { Name = "${var.cluster_name}-documentdb-sg" })
}

resource "aws_docdb_subnet_group" "main" {
  name       = "${var.cluster_name}-documentdb-subnet-group"
  subnet_ids = aws_subnet.private[*].id

  tags = merge(local.common_tags, { Name = "${var.cluster_name}-documentdb-subnet-group" })
}

resource "aws_docdb_cluster_parameter_group" "main" {
  family      = var.documentdb_parameter_group_family
  name        = "${var.cluster_name}-docdb-params"
  description = "DocumentDB parameter group"

  parameter {
    name  = "tls"
    value = "disabled"
  }

  tags = merge(local.common_tags, { Name = "${var.cluster_name}-docdb-params" })
}

resource "random_password" "docdb" {
  length  = 24
  special = false
}

resource "aws_docdb_cluster" "main" {
  cluster_identifier              = "${var.cluster_name}-docdb"
  engine                          = "docdb"
  engine_version                  = var.documentdb_parameter_group_family == "docdb8.0" ? "8.0.0" : "5.0.0"
  master_username                 = "waltid"
  master_password                 = random_password.docdb.result
  backup_retention_period         = var.documentdb_backup_retention_period
  preferred_backup_window         = "03:00-05:00"
  skip_final_snapshot             = var.skip_final_snapshot
  final_snapshot_identifier       = var.skip_final_snapshot ? null : "${var.cluster_name}-docdb-final"
  db_subnet_group_name            = aws_docdb_subnet_group.main.name
  db_cluster_parameter_group_name = aws_docdb_cluster_parameter_group.main.name
  vpc_security_group_ids          = [aws_security_group.documentdb.id]
  enabled_cloudwatch_logs_exports = ["audit", "profiler"]
  storage_encrypted               = true
  apply_immediately               = true
  deletion_protection             = false

  tags = merge(local.common_tags, { Name = "${var.cluster_name}-docdb-cluster" })
}

resource "aws_docdb_cluster_instance" "main" {
  count              = var.documentdb_instance_count
  identifier         = "${var.cluster_name}-docdb-${count.index + 1}"
  cluster_identifier = aws_docdb_cluster.main.id
  instance_class     = var.documentdb_instance_class

  tags = merge(local.common_tags, { Name = "${var.cluster_name}-docdb-${count.index + 1}" })
}
