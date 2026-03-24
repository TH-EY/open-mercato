# -----------------------------------------------------------------------------
# RDS - Managed PostgreSQL with pgvector
# -----------------------------------------------------------------------------

resource "aws_db_subnet_group" "this" {
  count = local.create_managed_rds ? 1 : 0

  name       = "${var.name}-postgres"
  subnet_ids = local.private_subnet_ids

  tags = merge(local.common_tags, { Name = "${var.name}-postgres" })
}

resource "aws_db_parameter_group" "this" {
  count = local.create_managed_rds ? 1 : 0

  name   = "${var.name}-postgres18"
  family = "postgres18"

  # pgvector does not require shared_preload_libraries on RDS.
  # It is installed via CREATE EXTENSION vector at app init time.

  tags = merge(local.common_tags, { Name = "${var.name}-postgres18" })
}

resource "aws_db_instance" "this" {
  count = local.create_managed_rds ? 1 : 0

  identifier     = "${var.name}-postgres"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_username

  manage_master_user_password = true

  publicly_accessible     = false
  deletion_protection     = var.db_deletion_protection
  backup_retention_period = var.db_backup_retention_days
  multi_az                = var.db_multi_az

  vpc_security_group_ids = [aws_security_group.db[0].id]
  db_subnet_group_name   = aws_db_subnet_group.this[0].name
  parameter_group_name   = aws_db_parameter_group.this[0].name

  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-postgres-final"

  tags = merge(local.common_tags, { Name = "${var.name}-postgres" })
}

# -----------------------------------------------------------------------------
# Read the RDS-managed password so we can compose a full DATABASE_URL
# -----------------------------------------------------------------------------

data "aws_secretsmanager_secret_version" "rds_password" {
  count     = local.create_managed_rds ? 1 : 0
  secret_id = aws_db_instance.this[0].master_user_secret[0].secret_arn
}

locals {
  rds_password = local.create_managed_rds ? jsondecode(data.aws_secretsmanager_secret_version.rds_password[0].secret_string)["password"] : ""
  database_url = local.create_managed_rds ? "postgres://${var.db_username}:${urlencode(local.rds_password)}@${aws_db_instance.this[0].address}:${aws_db_instance.this[0].port}/${var.db_name}" : ""
}

# -----------------------------------------------------------------------------
# Composed DATABASE_URL secret
# -----------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "database_url" {
  count = local.create_managed_rds ? 1 : 0

  name = "${var.name}/database-url"

  tags = merge(local.common_tags, { Name = "${var.name}/database-url" })
}

resource "aws_secretsmanager_secret_version" "database_url" {
  count = local.create_managed_rds ? 1 : 0

  secret_id     = aws_secretsmanager_secret.database_url[0].id
  secret_string = local.database_url
}
