resource "aws_security_group" "postgres" {
  count       = local.use_postgres ? 1 : 0
  name        = "${var.cluster_name}-postgres-sg"
  description = "Security group for the load-test RDS PostgreSQL instance"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.node.id]
  }

  tags = merge(local.common_tags, { Name = "${var.cluster_name}-postgres-sg" })
}

resource "aws_db_subnet_group" "postgres" {
  count      = local.use_postgres ? 1 : 0
  name       = "${var.cluster_name}-postgres"
  subnet_ids = aws_subnet.private[*].id

  tags = merge(local.common_tags, { Name = "${var.cluster_name}-postgres" })
}

data "aws_rds_engine_version" "postgres" {
  count              = local.use_postgres ? 1 : 0
  engine             = "postgres"
  preferred_versions = ["18.6", "18.4", "18.3", "18.1"]
}

resource "aws_db_parameter_group" "postgres" {
  count  = local.use_postgres ? 1 : 0
  name   = "${var.cluster_name}-postgres18"
  family = "postgres18"

  # Static: applied at instance creation, so the first boot already has the higher limit.
  parameter {
    name         = "max_connections"
    value        = "5000"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  tags = merge(local.common_tags, { Name = "${var.cluster_name}-postgres18" })
}

resource "random_password" "postgres" {
  count   = local.use_postgres ? 1 : 0
  length  = 24
  special = false
}

resource "aws_db_instance" "postgres" {
  count                  = local.use_postgres ? 1 : 0
  identifier             = "${var.cluster_name}-pg"
  engine                 = "postgres"
  engine_version         = data.aws_rds_engine_version.postgres[0].version
  instance_class         = var.documentdb_instance_class
  allocated_storage      = 100
  storage_type           = "gp3"
  db_name                = "waltid_enterprise"
  username               = "waltid"
  password               = random_password.postgres[0].result
  db_subnet_group_name   = aws_db_subnet_group.postgres[0].name
  parameter_group_name   = aws_db_parameter_group.postgres[0].name
  vpc_security_group_ids = [aws_security_group.postgres[0].id]
  publicly_accessible     = false
  multi_az                = false
  backup_retention_period = 1
  skip_final_snapshot     = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.cluster_name}-pg-final"
  deletion_protection     = false
  apply_immediately      = true
  storage_encrypted      = true

  tags = merge(local.common_tags, { Name = "${var.cluster_name}-pg" })
}
